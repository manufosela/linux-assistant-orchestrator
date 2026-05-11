import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHomeAssistantStateCache, normaliseAreaName } from '../../../src/modules/home-assistant/ha-state-cache.js';

/**
 * @returns {object}
 */
function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/**
 * Spins up a fake HA that responds to /api/template with a stable JSON snapshot.
 *
 * @param {{ snapshot?: any[], status?: number }} [opts]
 * @returns {Promise<{ baseUrl: string, calls: number, stop: () => Promise<void> }>}
 */
async function startFakeHa(opts = {}) {
  const { status = 200, snapshot } = opts;
  let calls = 0;

  const defaultSnapshot = {
    areas: [
      { id: 'despacho', name: 'Despacho' },
      { id: 'cocina', name: 'Cocina' },
      { id: 'salon', name: 'Salón' },
    ],
    entities: [
      { entity_id: 'sensor.despacho_temp', domain: 'sensor', friendly_name: 'Temp Despacho', device_class: 'temperature', state: '24.6', unit: '°C', area_id: 'despacho', area_name: 'Despacho' },
      { entity_id: 'sensor.despacho_hum', domain: 'sensor', friendly_name: 'Hum Despacho', device_class: 'humidity', state: '40', unit: '%', area_id: 'despacho', area_name: 'Despacho' },
      { entity_id: 'sensor.cocina_temp', domain: 'sensor', friendly_name: 'Temp Cocina', device_class: 'temperature', state: '23.8', unit: '°C', area_id: 'cocina', area_name: 'Cocina' },
      { entity_id: 'switch.cocina_luz', domain: 'switch', friendly_name: 'Luz Cocina', device_class: '', state: 'off', unit: '', area_id: 'cocina', area_name: 'Cocina' },
      { entity_id: 'sensor.salon_temp', domain: 'sensor', friendly_name: 'Temp Salón', device_class: 'temperature', state: 'unavailable', unit: '°C', area_id: 'salon', area_name: 'Salón' },
      { entity_id: 'switch.luz_esquina', domain: 'switch', friendly_name: 'Luz Esquina', device_class: '', state: 'off', unit: '', area_id: '', area_name: '' },
    ],
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.url === '/api/template' && req.method === 'POST') {
        calls += 1;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(snapshot ?? defaultSnapshot));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get calls() { return calls; },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('home-assistant — state cache', () => {
  it('refresh fetches the area index and stores it in memory', async () => {
    const fake = await startFakeHa();
    try {
      const cache = createHomeAssistantStateCache({ baseUrl: fake.baseUrl, token: 't', logger: silentLogger() });
      assert.equal(cache.areaCount, 0);
      await cache.refresh();
      assert.equal(cache.areaCount, 3);
      assert.ok(cache.generatedAt instanceof Date);
    } finally {
      await fake.stop();
    }
  });

  it('findArea matches by id and by display name (case/diacritics insensitive)', async () => {
    const fake = await startFakeHa();
    try {
      const cache = createHomeAssistantStateCache({ baseUrl: fake.baseUrl, token: 't', logger: silentLogger() });
      await cache.refresh();
      assert.equal(cache.findArea('despacho')?.id, 'despacho');
      assert.equal(cache.findArea('Despacho')?.id, 'despacho');
      assert.equal(cache.findArea('el despacho')?.id, 'despacho');
      assert.equal(cache.findArea('SALÓN')?.id, 'salon');
      assert.equal(cache.findArea('Salon')?.id, 'salon');
      assert.equal(cache.findArea('garaje'), null);
    } finally {
      await fake.stop();
    }
  });

  it('findEntities filters by area / domain / device_class', async () => {
    const fake = await startFakeHa();
    try {
      const cache = createHomeAssistantStateCache({ baseUrl: fake.baseUrl, token: 't', logger: silentLogger() });
      await cache.refresh();

      const temps = cache.findEntities({ deviceClass: 'temperature' });
      assert.equal(temps.length, 3);

      const cocina = cache.findEntities({ areaQuery: 'cocina' });
      assert.equal(cocina.length, 2);

      const cocinaSwitch = cache.findEntities({ areaQuery: 'cocina', domain: 'switch' });
      assert.equal(cocinaSwitch.length, 1);
      assert.equal(cocinaSwitch[0].entity_id, 'switch.cocina_luz');

      const tempInDespacho = cache.findEntities({ areaQuery: 'despacho', deviceClass: 'temperature' });
      assert.equal(tempInDespacho.length, 1);
      assert.equal(tempInDespacho[0].state, '24.6');
    } finally {
      await fake.stop();
    }
  });

  it('findEntitiesByName matches entities even without an assigned area', async () => {
    const fake = await startFakeHa();
    try {
      const cache = createHomeAssistantStateCache({ baseUrl: fake.baseUrl, token: 't', logger: silentLogger() });
      await cache.refresh();
      const matches = cache.findEntitiesByName('luz esquina', { domains: ['switch', 'light'] });
      assert.equal(matches.length, 1);
      assert.equal(matches[0].entity_id, 'switch.luz_esquina');
      assert.equal(matches[0].area_id, '');
    } finally {
      await fake.stop();
    }
  });

  it('start triggers an initial refresh and stop clears the timer', async () => {
    const fake = await startFakeHa();
    try {
      const cache = createHomeAssistantStateCache({
        baseUrl: fake.baseUrl, token: 't', logger: silentLogger(),
        refreshIntervalMs: 24 * 60 * 60 * 1000,
      });
      await cache.start();
      assert.equal(fake.calls, 1);
      cache.stop();
    } finally {
      await fake.stop();
    }
  });

  it('refresh propagates errors when HA returns 5xx', async () => {
    const fake = await startFakeHa({ status: 503 });
    try {
      const cache = createHomeAssistantStateCache({ baseUrl: fake.baseUrl, token: 't', logger: silentLogger() });
      await assert.rejects(() => cache.refresh(), /HTTP 503/);
    } finally {
      await fake.stop();
    }
  });

  it('normaliseAreaName strips diacritics and articles', () => {
    assert.equal(normaliseAreaName('Despacho'), 'despacho');
    assert.equal(normaliseAreaName('el despacho'), 'despacho');
    assert.equal(normaliseAreaName('La Cocina'), 'cocina');
    assert.equal(normaliseAreaName('Salón'), 'salon');
    assert.equal(normaliseAreaName('  los  niños '), 'ninos');
  });
});
