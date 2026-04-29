const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');

function createMockEnergyReadings(options = {}) {
  const existingKeys = new Set(options.existingKeys || []);
  let findAllCalls = 0;

  return {
    model: {
      async findOne({ where }) {
        const key = `${where.timestamp.toISOString()}|${where.location}`;
        return existingKeys.has(key) ? { id: 1 } : null;
      },
      async create(payload) {
        const key = `${payload.timestamp.toISOString()}|${payload.location}`;
        if (existingKeys.has(key)) {
          const error = new Error('duplicate');
          error.name = 'SequelizeUniqueConstraintError';
          throw error;
        }
        existingKeys.add(key);
        return payload;
      },
      async findAll() {
        findAllCalls += 1;
        return [];
      },
      async bulkCreate() {
        return [];
      },
      async destroy() {
        return 0;
      }
    },
    getFindAllCalls() {
      return findAllCalls;
    }
  };
}

function createTestApp(energyReadings) {
  return createApp({
    sequelize: {
      async authenticate() {}
    },
    EnergyReadings: energyReadings,
    fetchImpl: async () => {
      throw new Error('not used in this test');
    }
  });
}

test('POST /api/import/json skips invalid timestamp and reports duplicates', async () => {
  const timestampInDb = '2026-01-01T02:00:00.000Z';
  const mock = createMockEnergyReadings({
    existingKeys: [`${timestampInDb}|EE`]
  });
  const app = createTestApp(mock.model);

  const response = await request(app)
    .post('/api/import/json')
    .send({
      data: [
        { timestamp: 'not-a-date', location: 'EE', price_eur_mwh: 1.25 },
        { timestamp: '2026-01-01T01:00:00Z', location: 'EE', price_eur_mwh: 2.5 },
        { timestamp: '2026-01-01T01:00:00Z', location: 'EE', price_eur_mwh: 3.5 },
        { timestamp: '2026-01-01T02:00:00Z', location: 'EE', price_eur_mwh: 4.5 }
      ]
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.inserted, 1);
  assert.equal(response.body.skipped, 3);
  assert.equal(response.body.duplicates_detected, 2);
});

test('GET /api/readings returns validation error when end is before start', async () => {
  const mock = createMockEnergyReadings();
  const app = createTestApp(mock.model);

  const response = await request(app).get(
    '/api/readings?start=2026-01-01T10:00:00Z&end=2026-01-01T09:00:00Z&location=EE'
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.message, 'end must be greater than start');
  assert.equal(mock.getFindAllCalls(), 0);
});
