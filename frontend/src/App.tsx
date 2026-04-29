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

const CHART_WIDTH = 900;
const CHART_HEIGHT = 320;

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

function App() {
  const defaultRange = useMemo(() => getDefaultRange(), []);
  const [location, setLocation] = useState<LocationCode>('EE');
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

  const hasData = readings.length > 0;

  const chartPoints = useMemo(() => {
    if (!hasData) {
      return '';
    }

    const prices = readings.map(r => r.price_eur_mwh);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const xStep = readings.length > 1 ? CHART_WIDTH / (readings.length - 1) : CHART_WIDTH;
    const yScale = maxPrice === minPrice ? 1 : CHART_HEIGHT / (maxPrice - minPrice);

    return readings
      .map((reading, index) => {
        const x = index * xStep;
        const y = CHART_HEIGHT - ((reading.price_eur_mwh - minPrice) * yScale);
        return `${x},${y}`;
      })
      .join(' ');
  }, [hasData, readings]);

  const stats = useMemo(() => {
    if (!hasData) {
      return null;
    }
    const prices = readings.map(r => r.price_eur_mwh);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const avg = prices.reduce((sum, value) => sum + value, 0) / prices.length;
    return { min, max, avg };
  }, [hasData, readings]);

  async function fetchReadings(
    rangeStart = start,
    rangeEnd = end,
    rangeLocation: LocationCode = location
  ) {
    const startIso = new Date(rangeStart).toISOString();
    const endIso = new Date(rangeEnd).toISOString();
    const params = new URLSearchParams({
      start: startIso,
      end: endIso,
      location: rangeLocation
    });

    const response = await fetch(`/api/readings?${params.toString()}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.message || 'Failed to fetch readings');
    }

    setReadings(payload);
  }

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

      setLocation(syncLocation);
      setStart(syncStart);
      setEnd(syncEnd);
      await fetchReadings(syncStart, syncEnd, syncLocation);
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
          location: 'EE'
        });
        const response = await fetch(`/api/readings?${params.toString()}`);
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.message || 'Failed to fetch readings');
        }
        if (!cancelled) {
          setReadings(payload);
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

    loadInitialData();

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
              <option value="EE">EE</option>
              <option value="LV">LV</option>
              <option value="FI">FI</option>
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
        <label>
          Asukoht
          <select value={location} onChange={(event) => setLocation(event.target.value as LocationCode)}>
            <option value="EE">EE</option>
            <option value="LV">LV</option>
            <option value="FI">FI</option>
          </select>
        </label>

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

      <section className="chart-card">
        <h2>Hinnagraafik</h2>
        {hasData ? (
          <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label="Elektrihinna graafik">
            <polyline points={chartPoints} fill="none" stroke="#2563eb" strokeWidth="3" />
          </svg>
        ) : (
          <p>Andmed puuduvad valitud filtriga.</p>
        )}
      </section>

      {stats && (
        <section className="stats">
          <p>Min: {stats.min.toFixed(2)} EUR/MWh</p>
          <p>Max: {stats.max.toFixed(2)} EUR/MWh</p>
          <p>Keskmine: {stats.avg.toFixed(2)} EUR/MWh</p>
        </section>
      )}

      {hasData && (
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
              {readings.map((reading) => (
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
