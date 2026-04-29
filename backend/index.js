const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { Op } = require('sequelize');
const sequelize = require('./models').sequelize;
const { EnergyReadings } = require('./models');

const app = express();
app.use(express.json());

const ALLOWED_LOCATIONS = new Set(['EE', 'LV', 'FI']);
const PRICE_API_URL = 'https://dashboard.elering.ee/api/nps/price';

function isIsoUtcWithTimezone(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const isoUtcRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]00:00)$/;
  if (!isoUtcRegex.test(value)) {
    return false;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  return true;
}

function normalizeLocation(location) {
  if (location === undefined || location === null || location === '') {
    return 'EE';
  }

  return String(location).trim().toUpperCase();
}

function parseLocationsQuery(locationQuery) {
  const rawValues = Array.isArray(locationQuery) ? locationQuery : [locationQuery];

  const parsed = rawValues
    .filter(value => value !== undefined && value !== null && value !== '')
    .flatMap(value => String(value).split(','))
    .map(value => normalizeLocation(value))
    .filter((value, index, arr) => value && arr.indexOf(value) === index);

  if (parsed.length === 0) {
    return {
      isValid: false,
      locations: [],
      message: 'location is required'
    };
  }

  const invalidLocation = parsed.find(location => !ALLOWED_LOCATIONS.has(location));
  if (invalidLocation) {
    return {
      isValid: false,
      locations: [],
      message: 'location must be one of: EE, LV, FI'
    };
  }

  return {
    isValid: true,
    locations: parsed
  };
}

function toIsoUtcNoMs(date) {
  return date.toISOString().replace('.000Z', 'Z');
}

function getDefaultUtcRange() {
  const now = new Date();
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 0, 0
  ));
  const end = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    23, 59, 59
  ));

  return {
    start: toIsoUtcNoMs(start),
    end: toIsoUtcNoMs(end)
  };
}

async function loadImportData(req) {
  if (Array.isArray(req.body)) {
    return req.body;
  }

  if (Array.isArray(req.body?.data)) {
    return req.body.data;
  }

  const candidatePaths = [
    path.join(process.cwd(), 'energy_dump.json'),
    path.join(__dirname, 'energy_dump.json')
  ];

  for (const filePath of candidatePaths) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`JSON root must be an array in ${filePath}`);
      }
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }

  throw new Error('energy_dump.json not found and request body had no data array');
}

app.get('/api/health', (req, res) => {
  sequelize.authenticate()
    .then(() => {
      res.json({ status: 'ok', db: 'ok' });
    })
    .catch(err => {
      console.error('Database connection error:', err);
      res.status(500).json({ status: 'error', db: 'error' });
    });
});

app.post('/api/sync/prices', async (req, res) => {
  const defaultRange = getDefaultUtcRange();
  const start = req.body?.start || defaultRange.start;
  const end = req.body?.end || defaultRange.end;
  const location = normalizeLocation(req.body?.location);

  if (!ALLOWED_LOCATIONS.has(location)) {
    return res.status(400).json({ message: 'location must be one of: EE, LV, FI' });
  }

  if (!isIsoUtcWithTimezone(start) || !isIsoUtcWithTimezone(end)) {
    return res.status(400).json({
      message: 'start and end must be ISO 8601 UTC timestamps with timezone (e.g. 2026-01-01T10:00:00Z)'
    });
  }

  const externalField = location.toLowerCase();
  const url = new URL(PRICE_API_URL);
  url.searchParams.set('start', start);
  url.searchParams.set('end', end);
  url.searchParams.set('fields', externalField);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const apiResponse = await fetch(url, { signal: controller.signal });

    if (!apiResponse.ok) {
      throw new Error(`External API returned ${apiResponse.status}`);
    }

    const payload = await apiResponse.json();
    const sourceReadings = payload?.data?.[externalField];
    if (!payload?.success || !Array.isArray(sourceReadings)) {
      throw new Error('External API response shape is invalid');
    }

    const readingsToSave = sourceReadings
      .filter(reading =>
        Number.isFinite(reading?.timestamp) && Number.isFinite(reading?.price)
      )
      .map(reading => ({
        timestamp: new Date(reading.timestamp * 1000),
        location,
        price_eur_mwh: Number(reading.price),
        source: 'API'
      }));

    if (readingsToSave.length > 0) {
      await EnergyReadings.bulkCreate(readingsToSave, {
        updateOnDuplicate: ['price_eur_mwh', 'source', 'updatedAt']
      });
    }

    return res.json({
      synced: readingsToSave.length,
      location,
      start,
      end
    });
  } catch (error) {
    console.error('Price sync failed:', error);
    return res.status(503).json({ error: 'PRICE_API_UNAVAILABLE' });
  } finally {
    clearTimeout(timeout);
  }
});

app.post('/api/import/json', async (req, res) => {
  let inserted = 0;
  let skipped = 0;
  let duplicates_detected = 0;

  try {
    const records = await loadImportData(req);
    const seenInFile = new Set();

    for (const record of records) {
      const timestamp = record?.timestamp;
      const location = normalizeLocation(record?.location);
      const price = record?.price_eur_mwh;

      if (!isIsoUtcWithTimezone(timestamp)) {
        skipped += 1;
        continue;
      }

      if (typeof price !== 'number' || Number.isNaN(price)) {
        skipped += 1;
        continue;
      }

      const duplicateKey = `${timestamp}|${location}`;
      if (seenInFile.has(duplicateKey)) {
        duplicates_detected += 1;
        skipped += 1;
        continue;
      }
      seenInFile.add(duplicateKey);

      const duplicateInDb = await EnergyReadings.findOne({
        where: {
          timestamp: new Date(timestamp),
          location
        }
      });

      if (duplicateInDb) {
        duplicates_detected += 1;
        skipped += 1;
        continue;
      }

      try {
        await EnergyReadings.create({
          timestamp: new Date(timestamp),
          location,
          price_eur_mwh: price,
          source: 'UPLOAD'
        });
        inserted += 1;
      } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
          duplicates_detected += 1;
          skipped += 1;
          continue;
        }
        throw error;
      }
    }

    const summary = `Import completed:\n- inserted: ${inserted}\n- skipped: ${skipped}\n- duplicates_detected: ${duplicates_detected}`;
    console.log(summary);

    return res.json({
      message: summary,
      inserted,
      skipped,
      duplicates_detected
    });
  } catch (error) {
    console.error('Import failed:', error);
    return res.status(400).json({
      message: `Import failed: ${error.message}`
    });
  }
});

app.get('/api/readings', async (req, res) => {
  const { start, end, location } = req.query;
  const parsedLocations = parseLocationsQuery(location);

  if (!parsedLocations.isValid) {
    return res.status(400).json({ message: parsedLocations.message });
  }

  if (!start || !end) {
    return res.status(400).json({ message: 'start and end are required' });
  }

  if (!isIsoUtcWithTimezone(start) || !isIsoUtcWithTimezone(end)) {
    return res.status(400).json({
      message: 'start and end must be ISO 8601 UTC timestamps with timezone (e.g. 2026-01-01T10:00:00Z)'
    });
  }

  try {
    const readings = await EnergyReadings.findAll({
      where: {
        location: {
          [Op.in]: parsedLocations.locations
        },
        timestamp: {
          [Op.gte]: new Date(start),
          [Op.lte]: new Date(end)
        }
      },
      order: [['timestamp', 'ASC'], ['location', 'ASC']]
    });

    return res.json(readings);
  } catch (error) {
    console.error('Readings fetch failed:', error);
    return res.status(500).json({ message: 'Failed to fetch readings' });
  }
});

const PORT = 3001;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
