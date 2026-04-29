import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

type LocationCode = 'EE' | 'LV' | 'FI';

type EnergyReading = {
  id: number;
  timestamp: string;
  location: LocationCode;
  price_eur_mwh: number;
  source: 'API' | 'UPLOAD';
};

type TimePoint = {
  x: number;
  y: number;
};

type LineSeries = {
  label: string;
  color: string;
  points: TimePoint[];
};

const CHART_WIDTH = 900;
const CHART_HEIGHT = 320;
const LOCATION_CODES: LocationCode[] = ['EE', 'LV', 'FI'];
const LOCATION_COLORS: Record<LocationCode, string> = {
  EE: '#2563eb',
  LV: '#16a34a',
  FI: '#f97316'
};

function toDatetimeLocalValue(date: Date) {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  const localDate = new Date(date.getTime() - offsetMs);
  return localDate.toISOString().slice(0, 16);
}

function getDefaultRange() {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const end = new Date(now);
  end.setHours(23, 59, 0, 0);

  return {
    start: toDatetimeLocalValue(start),
    end: toDatetimeLocalValue(end)
  };
}

function formatDisplayTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

function scalePoints(points: TimePoint[]) {
  if (points.length === 0) {
    return '';
  }

  const xValues = points.map(point => point.x);
  const yValues = points.map(point => point.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const xScale = maxX === minX ? 1 : CHART_WIDTH / (maxX - minX);
  const yScale = maxY === minY ? 1 : CHART_HEIGHT / (maxY - minY);

  return points
    .map(point => {
      const x = (point.x - minX) * xScale;
      const y = CHART_HEIGHT - ((point.y - minY) * yScale);
      return `${x},${y}`;
    })
    .join(' ');
}

function SingleLineChart({ title, points }: { title: string; points: TimePoint[] }) {
  if (points.length === 0) {
    return (
      <section className="chart-card">
        <h2>{title}</h2>
        <p>Andmed puuduvad valitud filtriga.</p>
      </section>
    );
  }

  return (
    <section className="chart-card">
      <h2>{title}</h2>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={title}>
        <polyline points={scalePoints(points)} fill="none" stroke="#2563eb" strokeWidth="3" />
      </svg>
    </section>
  );
}

function MultiLineChart({ title, series }: { title: string; series: LineSeries[] }) {
  const nonEmptySeries = series.filter(item => item.points.length > 0);
  if (nonEmptySeries.length === 0) {
    return (
      <section className="chart-card">
        <h2>{title}</h2>
        <p>Andmed puuduvad valitud filtriga.</p>
      </section>
    );
  }

  const allPoints = nonEmptySeries.flatMap(item => item.points);
  const minX = Math.min(...allPoints.map(point => point.x));
  const maxX = Math.max(...allPoints.map(point => point.x));
  const minY = Math.min(...allPoints.map(point => point.y));
  const maxY = Math.max(...allPoints.map(point => point.y));
  const xScale = maxX === minX ? 1 : CHART_WIDTH / (maxX - minX);
  const yScale = maxY === minY ? 1 : CHART_HEIGHT / (maxY - minY);

  return (
    <section className="chart-card">
      <h2>{title}</h2>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={title}>
        {nonEmptySeries.map(item => {
          const points = item.points
            .map(point => {
              const x = (point.x - minX) * xScale;
              const y = CHART_HEIGHT - ((point.y - minY) * yScale);
              return `${x},${y}`;
            })
            .join(' ');

          return (
            <polyline
              key={item.label}
              points={points}
              fill="none"
              stroke={item.color}
              strokeWidth="3"
            />
          );
        })}
      </svg>
      <div className="legend">
        {series.map(item => (
          <span key={item.label}>
            <i style={{ backgroundColor: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
    </section>
  );
}

function LocationBarChart({
  title,
  values
}: {
  title: string;
  values: Array<{ location: LocationCode; avg: number }>;
}) {
  if (values.length === 0) {
    return (
      <section className="chart-card">
        <h2>{title}</h2>
        <p>Andmed puuduvad valitud filtriga.</p>
      </section>
    );
  }

  const maxValue = Math.max(...values.map(value => value.avg));
  const barWidth = CHART_WIDTH / values.length;

  return (
    <section className="chart-card">
      <h2>{title}</h2>
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={title}>
        {values.map((value, index) => {
          const height = maxValue === 0 ? 0 : (value.avg / maxValue) * (CHART_HEIGHT - 30);
          const x = index * barWidth + barWidth * 0.15;
          const y = CHART_HEIGHT - height;
          return (
            <rect
              key={value.location}
              x={x}
              y={y}
              width={barWidth * 0.7}
              height={height}
              fill={LOCATION_COLORS[value.location]}
              rx="6"
            />
          );
        })}
      </svg>
      <div className="legend">
        {values.map(value => (
          <span key={value.location}>
            <i style={{ backgroundColor: LOCATION_COLORS[value.location] }} />
            {value.location}: {value.avg.toFixed(2)} EUR/MWh
          </span>
        ))}
      </div>
    </section>
  );
}

function App() {
  const defaultRange = useMemo(() => getDefaultRange(), []);
  const [selectedLocations, setSelectedLocations] = useState<LocationCode[]>(LOCATION_CODES);
  const [start, setStart] = useState(defaultRange.start);
  const [end, setEnd] = useState(defaultRange.end);
  const [syncLocation, setSyncLocation] = useState<LocationCode>('EE');
  const [syncStart, setSyncStart] = useState(defaultRange.start);
  const [syncEnd, setSyncEnd] = useState(defaultRange.end);
  const [readings, setReadings] = useState<EnergyReading[]>([]);
  const [filterMessage, setFilterMessage] = useState('');
  const [filterError, setFilterError] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [syncError, setSyncError] = useState('');
  const [readingsLoading, setReadingsLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);

  const validReadings = useMemo(() => {
    return readings.filter(reading => {
      if (!Number.isFinite(reading.price_eur_mwh)) {
        return false;
      }
      return !Number.isNaN(new Date(reading.timestamp).getTime());
    });
  }, [readings]);

  const stats = useMemo(() => {
    if (validReadings.length === 0) {
      return null;
    }
    const prices = validReadings.map(reading => reading.price_eur_mwh);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const avg = prices.reduce((sum, value) => sum + value, 0) / prices.length;
    return { min, max, avg };
  }, [validReadings]);

  const priceOverTimePoints = useMemo(() => {
    const grouped = new Map<string, { timestampMs: number; sum: number; count: number }>();

    for (const reading of validReadings) {
      const timestampMs = new Date(reading.timestamp).getTime();
      const key = String(timestampMs);
      const current = grouped.get(key);
      if (!current) {
        grouped.set(key, { timestampMs, sum: reading.price_eur_mwh, count: 1 });
        continue;
      }
      current.sum += reading.price_eur_mwh;
      current.count += 1;
    }

    return Array.from(grouped.values())
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map(item => ({
        x: item.timestampMs,
        y: item.sum / item.count
      }));
  }, [validReadings]);

  const dailyAveragePoints = useMemo(() => {
    const grouped = new Map<string, { dayStartMs: number; sum: number; count: number }>();

    for (const reading of validReadings) {
      const readingDate = new Date(reading.timestamp);
      const dayKey = readingDate.toISOString().slice(0, 10);
      const dayStartMs = new Date(`${dayKey}T00:00:00.000Z`).getTime();
      const current = grouped.get(dayKey);
      if (!current) {
        grouped.set(dayKey, { dayStartMs, sum: reading.price_eur_mwh, count: 1 });
        continue;
      }
      current.sum += reading.price_eur_mwh;
      current.count += 1;
    }

    return Array.from(grouped.values())
      .sort((a, b) => a.dayStartMs - b.dayStartMs)
      .map(item => ({
        x: item.dayStartMs,
        y: item.sum / item.count
      }));
  }, [validReadings]);

  const averageByLocation = useMemo(() => {
    const grouped = new Map<LocationCode, { sum: number; count: number }>();

    for (const reading of validReadings) {
      const current = grouped.get(reading.location) ?? { sum: 0, count: 0 };
      current.sum += reading.price_eur_mwh;
      current.count += 1;
      grouped.set(reading.location, current);
    }

    return selectedLocations
      .map(location => {
        const data = grouped.get(location);
        if (!data || data.count === 0) {
          return null;
        }
        return {
          location,
          avg: data.sum / data.count
        };
      })
      .filter((value): value is { location: LocationCode; avg: number } => value !== null);
  }, [selectedLocations, validReadings]);

  const compareSeries = useMemo(() => {
    return selectedLocations.map(location => {
      const points = validReadings
        .filter(reading => reading.location === location)
        .map(reading => ({
          x: new Date(reading.timestamp).getTime(),
          y: reading.price_eur_mwh
        }))
        .sort((a, b) => a.x - b.x);

      return {
        label: location,
        color: LOCATION_COLORS[location],
        points
      };
    });
  }, [selectedLocations, validReadings]);

  const locationCounts = useMemo(() => {
    return selectedLocations.map(location => ({
      location,
      count: validReadings.filter(reading => reading.location === location).length
    }));
  }, [selectedLocations, validReadings]);

  async function fetchReadings(
    rangeStart = start,
    rangeEnd = end,
    locations: LocationCode[] = selectedLocations
  ) {
    const startIso = new Date(rangeStart).toISOString();
    const endIso = new Date(rangeEnd).toISOString();
    const params = new URLSearchParams({
      start: startIso,
      end: endIso,
      location: locations.join(',')
    });

    const response = await fetch(`/api/readings?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || 'Failed to fetch readings');
    }

    setReadings(Array.isArray(payload) ? payload : []);
  }

  function toggleLocation(location: LocationCode) {
    setSelectedLocations(current => {
      if (current.includes(location)) {
        if (current.length === 1) {
          return current;
        }
        return current.filter(item => item !== location);
      }
      return [...current, location];
    });
  }2

  async function handleFilterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilterError('');
    setFilterMessage('');
    setReadingsLoading(true);

    try {
      await fetchReadings();
      setFilterMessage('Andmed uuendatud.');
    } catch (submitError) {
      const text = submitError instanceof Error ? submitError.message : 'Failed to fetch readings';
      setFilterError(text);
    } finally {
      setReadingsLoading(false);
    }
  }

  async function handleSync() {
    setSyncError('');
    setSyncMessage('');
    setSyncLoading(true);

    try {
      const response = await fetch('/api/sync/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: new Date(syncStart).toISOString(),
          end: new Date(syncEnd).toISOString(),
          location: syncLocation
        })
      });

      const payload = await response.json();
      if (!response.ok) {
        if (payload.error === 'PRICE_API_UNAVAILABLE') {
          throw new Error('Hindade sünkroonimine ebaõnnestus. Proovi mõne hetke pärast uuesti.');
        }
        throw new Error(payload.error || payload.message || 'Sync failed');
      }

      const nextLocations = selectedLocations.includes(syncLocation)
        ? selectedLocations
        : [...selectedLocations, syncLocation];

      setSelectedLocations(nextLocations);
      setStart(syncStart);
      setEnd(syncEnd);
      await fetchReadings(syncStart, syncEnd, nextLocations);
      setSyncMessage(`Hinnad sünkrooniti edukalt. Andmebaasi imporditi ${payload.synced} kirjet.`);
    } catch (syncError) {
      const text = syncError instanceof Error ? syncError.message : 'Sync failed';
      setSyncError(text);
    } finally {
      setSyncLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadInitialData() {
      setReadingsLoading(true);
      setFilterError('');
      try {
        const params = new URLSearchParams({
          start: new Date(defaultRange.start).toISOString(),
          end: new Date(defaultRange.end).toISOString(),
          location: LOCATION_CODES.join(',')
        });
        const response = await fetch(`/api/readings?${params.toString()}`);
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.message || 'Failed to fetch readings');
        }
        if (!cancelled) {
          setReadings(Array.isArray(payload) ? payload : []);
        }
      } catch {
        if (!cancelled) {
          setFilterError('Andmete laadimine ebaõnnestus.');
        }
      } finally {
        if (!cancelled) {
          setReadingsLoading(false);
        }
      }
    }

    void loadInitialData();

    return () => {
      cancelled = true;
    };
  }, [defaultRange.end, defaultRange.start]);

  return (
    <main className="dashboard">
      <h1>Elektrihinnad</h1>

      <section className="sync-card">
        <h2>Hinnasünkroonimine</h2>
        <form className="sync-form" onSubmit={(event) => {
          event.preventDefault();
          void handleSync();
        }}>
          <label>
            Asukoht
            <select
              value={syncLocation}
              onChange={(event) => setSyncLocation(event.target.value as LocationCode)}
              disabled={syncLoading}
            >
              {LOCATION_CODES.map(location => (
                <option key={location} value={location}>{location}</option>
              ))}
            </select>
          </label>

          <label>
            Algus
            <input
              type="datetime-local"
              value={syncStart}
              onChange={(event) => setSyncStart(event.target.value)}
              required
              disabled={syncLoading}
            />
          </label>

          <label>
            Lõpp
            <input
              type="datetime-local"
              value={syncEnd}
              onChange={(event) => setSyncEnd(event.target.value)}
              required
              disabled={syncLoading}
            />
          </label>

          <button type="submit" disabled={syncLoading}>
            {syncLoading ? 'Loading...' : 'Sync Prices'}
            {syncLoading && <span className="spinner" aria-hidden="true" />}
          </button>
        </form>
        {syncMessage && <p className="success">{syncMessage}</p>}
        {syncError && <p className="error">{syncError}</p>}
      </section>

      <form className="filters" onSubmit={handleFilterSubmit}>
        <fieldset className="location-filter">
          <legend>Asukohad</legend>
          <div className="location-options">
            {LOCATION_CODES.map(location => (
              <label key={location}>
                <input
                  type="checkbox"
                  checked={selectedLocations.includes(location)}
                  onChange={() => toggleLocation(location)}
                />
                {location}
              </label>
            ))}
          </div>
        </fieldset>

        <label>
          Algus
          <input
            type="datetime-local"
            value={start}
            onChange={(event) => setStart(event.target.value)}
            required
          />
        </label>

        <label>
          Lõpp
          <input
            type="datetime-local"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            required
          />
        </label>

        <button type="submit" disabled={readingsLoading}>Filtreeri</button>
      </form>

      {filterMessage && <p className="info">{filterMessage}</p>}
      {filterError && <p className="error">{filterError}</p>}
      <p className="info">
        {locationCounts.map(item => `${item.location}: ${item.count} kirjet`).join(' | ')}
      </p>

      <SingleLineChart title="1) Price over time" points={priceOverTimePoints} />
      <SingleLineChart title="2) Daily average price in selected date range" points={dailyAveragePoints} />
      <LocationBarChart title="3) Average price per selected location" values={averageByLocation} />
      <MultiLineChart title="4) Compare prices per location on selected period" series={compareSeries} />

      {stats && (
        <section className="stats">
          <p>Min: {stats.min.toFixed(2)} EUR/MWh</p>
          <p>Max: {stats.max.toFixed(2)} EUR/MWh</p>
          <p>Keskmine: {stats.avg.toFixed(2)} EUR/MWh</p>
        </section>
      )}

      {validReadings.length > 0 && (
        <section className="table-card">
          <h2>Kirjed</h2>
          <table>
            <thead>
              <tr>
                <th>Aeg</th>
                <th>Asukoht</th>
                <th>Hind (EUR/MWh)</th>
                <th>Allikas</th>
              </tr>
            </thead>
            <tbody>
              {validReadings.map((reading) => (
                <tr key={`${reading.location}-${reading.timestamp}`}>
                  <td>{formatDisplayTimestamp(reading.timestamp)}</td>
                  <td>{reading.location}</td>
                  <td>{reading.price_eur_mwh.toFixed(2)}</td>
                  <td>{reading.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

export default App;
