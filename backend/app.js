const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { Op } = require('sequelize');

const ALLOWED_LOCATIONS = new Set(['EE', 'LV', 'FI']);
const PRICE_API_URL = 'https://dashboard.elering.ee/api/nps/price';

class AppError extends Error {
  constructor(statusCode, message, code, options = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.expose = options.expose ?? false;
  }
}

function asyncHandler(handler) {
  return function wrappedHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

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
    throw new AppError(400, 'location is required');
  }

  const invalidLocation = parsed.find(location => !ALLOWED_LOCATIONS.has(location));
  if (invalidLocation) {
    throw new AppError(400, 'location must be one of: EE, LV, FI');
  }

  return parsed;
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

function parseDateRange(start, end) {
  if (!start || !end) {
    throw new AppError(400, 'start and end are required');
  }

  if (!isIsoUtcWithTimezone(start) || !isIsoUtcWithTimezone(end)) {
    throw new AppError(
      400,
      'start and end must be ISO 8601 UTC timestamps with timezone (e.g. 2026-01-01T10:00:00Z)'
    );
  }

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (endDate <= startDate) {
    throw new AppError(400, 'end must be greater than start');
  }

  return { start, end, startDate, endDate };
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

function createApp({ sequelize, EnergyReadings, fetchImpl = global.fetch } = {}) {
  if (!sequelize || !EnergyReadings) {
    throw new Error('Missing sequelize or EnergyReadings dependency');
  }

  const app = express();
  app.use(express.json());

  app.get('/api/health', asyncHandler(async (req, res) => {
    await sequelize.authenticate();
    res.json({ status: 'ok', db: 'ok' });
  }));

  app.post('/api/sync/prices', asyncHandler(async (req, res) => {
    const defaultRange = getDefaultUtcRange();
    const start = req.body?.start || defaultRange.start;
    const end = req.body?.end || defaultRange.end;
    const location = normalizeLocation(req.body?.location);

    if (!ALLOWED_LOCATIONS.has(location)) {
      throw new AppError(400, 'location must be one of: EE, LV, FI');
    }

    parseDateRange(start, end);

    const externalField = location.toLowerCase();
    const url = new URL(PRICE_API_URL);
    url.searchParams.set('start', start);
    url.searchParams.set('end', end);
    url.searchParams.set('fields', externalField);

    if (typeof fetchImpl !== 'function') {
      throw new AppError(503, 'Price sync failed. Please try again.', 'PRICE_API_UNAVAILABLE', { expose: true });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const apiResponse = await fetchImpl(url, { signal: controller.signal });
      if (!apiResponse.ok) {
        throw new Error(`External API returned ${apiResponse.status}`);
      }

      const payload = await apiResponse.json();
      const sourceReadings = payload?.data?.[externalField];
      if (!payload?.success || !Array.isArray(sourceReadings)) {
        throw new Error('External API response shape is invalid');
      }

      const incomingReadings = sourceReadings
        .filter(reading =>
          Number.isFinite(reading?.timestamp) && Number.isFinite(reading?.price)
        )
        .map(reading => ({
          timestamp: new Date(reading.timestamp * 1000),
          location,
          price_eur_mwh: Number(reading.price),
          source: 'API'
        }));

      const readingsByKey = new Map();
      for (const reading of incomingReadings) {
        readingsByKey.set(`${reading.timestamp.toISOString()}|${reading.location}`, reading);
      }
      const readingsToSave = Array.from(readingsByKey.values());

      if (readingsToSave.length > 0) {
        const timestamps = readingsToSave.map(reading => reading.timestamp.getTime());
        const minTimestamp = new Date(Math.min(...timestamps));
        const maxTimestamp = new Date(Math.max(...timestamps));

        const existingRows = await EnergyReadings.findAll({
          where: {
            location,
            timestamp: {
              [Op.gte]: minTimestamp,
              [Op.lte]: maxTimestamp
            }
          },
          order: [['timestamp', 'ASC'], ['id', 'DESC']]
        });

        const existingByKey = new Map();
        const duplicateIds = [];

        for (const row of existingRows) {
          const key = `${row.timestamp.toISOString()}|${row.location}`;
          if (!existingByKey.has(key)) {
            existingByKey.set(key, row);
            continue;
          }
          duplicateIds.push(row.id);
        }

        if (duplicateIds.length > 0) {
          await EnergyReadings.destroy({
            where: {
              id: {
                [Op.in]: duplicateIds
              }
            }
          });
        }

        for (const reading of readingsToSave) {
          const key = `${reading.timestamp.toISOString()}|${reading.location}`;
          const existing = existingByKey.get(key);

          if (!existing) {
            await EnergyReadings.create(reading);
            continue;
          }

          if (existing.price_eur_mwh !== reading.price_eur_mwh || existing.source !== 'API') {
            await EnergyReadings.update(
              {
                price_eur_mwh: reading.price_eur_mwh,
                source: 'API'
              },
              {
                where: {
                  id: existing.id
                }
              }
            );
          }
        }
      }

      return res.json({
        synced: readingsToSave.length,
        location,
        start,
        end
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(503, 'Price sync failed. Please try again.', 'PRICE_API_UNAVAILABLE', { expose: true });
    } finally {
      clearTimeout(timeout);
    }
  }));

  app.post('/api/import/json', asyncHandler(async (req, res) => {
    let inserted = 0;
    let skipped = 0;
    let duplicates_detected = 0;

    let records;
    try {
      records = await loadImportData(req);
    } catch (error) {
      throw new AppError(400, 'Import failed. Please check input data.');
    }

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

    return res.json({
      message: summary,
      inserted,
      skipped,
      duplicates_detected
    });
  }));

  app.get('/api/readings', asyncHandler(async (req, res) => {
    const { start, end, location } = req.query;
    const locations = parseLocationsQuery(location);
    const range = parseDateRange(start, end);

    const readings = await EnergyReadings.findAll({
      where: {
        location: {
          [Op.in]: locations
        },
        timestamp: {
          [Op.gte]: range.startDate,
          [Op.lte]: range.endDate
        }
      },
      order: [['timestamp', 'ASC'], ['location', 'ASC'], ['id', 'DESC']]
    });

    const deduplicated = [];
    const seenKeys = new Set();

    for (const reading of readings) {
      const key = `${reading.timestamp.toISOString()}|${reading.location}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      deduplicated.push(reading);
    }

    return res.json(deduplicated);
  }));

  app.delete('/api/readings', asyncHandler(async (req, res) => {
    if (req.query.source !== 'UPLOAD') {
      throw new AppError(400, 'source must be UPLOAD');
    }

    try {
      const deleted = await EnergyReadings.destroy({
        where: {
          source: 'UPLOAD'
        }
      });

      if (deleted === 0) {
        return res.json({ message: 'No UPLOAD records found.' });
      }

      return res.json({ message: `Deleted ${deleted} uploaded records.` });
    } catch (error) {
      throw new AppError(500, 'Cleanup failed. Please try again.', 'CLEANUP_FAILED', { expose: true });
    }
  }));

  app.use((req, res, next) => {
    next(new AppError(404, 'Not found', 'NOT_FOUND'));
  });

  app.use((error, req, res, next) => {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    const message = statusCode >= 500
      ? (error.expose ? error.message : 'Internal server error')
      : (error.message || 'Bad request');

    if (statusCode >= 500) {
      console.error(error);
    }

    const payload = { message };
    if (error.code) {
      payload.error = error.code;
    }

    res.status(statusCode).json(payload);
  });

  return app;
}

module.exports = {
  createApp,
  isIsoUtcWithTimezone,
  parseDateRange,
  normalizeLocation,
  parseLocationsQuery
};
