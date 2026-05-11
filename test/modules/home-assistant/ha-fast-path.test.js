import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tryFastPath } from '../../../src/modules/home-assistant/ha-fast-path.js';

/**
 * Builds an in-memory state cache stub.
 *
 * @param {Array<{id: string, name: string, entities: any[]}>} areas
 * @returns {object}
 */
function makeCache(areas) {
  /**
   * @param {string} q
   */
  const norm = (q) => String(q ?? '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/^\s*(el|la|los|las|del|de la)\s+/, '').trim();

  return {
    areaCount: areas.length,
    listAreas: () => areas.map((a) => ({ id: a.id, name: a.name })),
    findArea: (q) => {
      const n = norm(q);
      return areas.find((a) => norm(a.id) === n || norm(a.name) === n) ?? null;
    },
    findEntities: ({ areaQuery, domain, deviceClass } = {}) => {
      const sources = areaQuery ? [areas.find((a) => norm(a.id) === norm(areaQuery) || norm(a.name) === norm(areaQuery))].filter(Boolean) : areas;
      const out = [];
      for (const area of sources) {
        for (const e of area.entities ?? []) {
          if (domain && e.domain !== domain) continue;
          if (deviceClass && e.device_class !== deviceClass) continue;
          out.push({ ...e, area_id: area.id, area_name: area.name });
        }
      }
      return out;
    },
    findEntitiesByName: (q, opts = {}) => {
      const n = norm(q);
      if (!n) return [];
      const words = n.split(/\s+/).filter(Boolean);
      const allowed = opts.domains;
      const all = [];
      for (const area of areas) {
        for (const e of area.entities ?? []) {
          if (allowed && !allowed.includes(e.domain)) continue;
          all.push({ ...e, area_id: area.id, area_name: area.name });
        }
      }
      const exact = all.filter((e) => norm(e.friendly_name) === n);
      if (exact.length > 0) return exact;
      return all.filter((e) => {
        const haystack = `${norm(e.friendly_name)} ${norm(e.entity_id)}`;
        return words.every((w) => haystack.includes(w));
      });
    },
  };
}

const FIXTURE = [
  {
    id: 'despacho', name: 'Despacho',
    entities: [
      { entity_id: 'sensor.despacho_temp', domain: 'sensor', friendly_name: 'Temp', device_class: 'temperature', state: '24.6', unit: '°C' },
      { entity_id: 'sensor.despacho_hum', domain: 'sensor', friendly_name: 'Hum', device_class: 'humidity', state: '40', unit: '%' },
      { entity_id: 'light.luz_esquina', domain: 'light', friendly_name: 'Luz Esquina', device_class: '', state: 'off', unit: '' },
    ],
  },
  {
    id: 'cocina', name: 'Cocina',
    entities: [
      { entity_id: 'sensor.cocina_temp', domain: 'sensor', friendly_name: 'Temp', device_class: 'temperature', state: '23.8', unit: '°C' },
      { entity_id: 'switch.humidificador', domain: 'switch', friendly_name: 'Humidificador', device_class: '', state: 'off', unit: '' },
    ],
  },
  {
    id: 'salon', name: 'Salón',
    entities: [
      { entity_id: 'sensor.salon_temp', domain: 'sensor', friendly_name: 'Temp', device_class: 'temperature', state: 'unavailable', unit: '°C' },
      { entity_id: 'light.luz_principal', domain: 'light', friendly_name: 'Luz Principal', device_class: '', state: 'off', unit: '' },
      { entity_id: 'light.luz_esquina_salon', domain: 'light', friendly_name: 'Luz Esquina Salón', device_class: '', state: 'off', unit: '' },
    ],
  },
];

describe('home-assistant — fast path', () => {
  /** @type {ReturnType<typeof makeCache>} */
  let cache;
  beforeEach(() => { cache = makeCache(FIXTURE); });

  it('answers temperature in a known area with the cached state', async () => {
    const result = await tryFastPath({ text: 'qué temperatura hace en el despacho', stateCache: cache });
    assert.equal(result?.handled, true);
    assert.match(result.speech, /Despacho/);
    assert.match(result.speech, /24\.6/);
  });

  it('answers humidity in a known area', async () => {
    const result = await tryFastPath({ text: '¿qué humedad hay en el despacho?', stateCache: cache });
    assert.equal(result?.handled, true);
    assert.match(result.speech, /40/);
    assert.match(result.speech, /Despacho/);
  });

  it('returns a friendly message when sensors are unavailable', async () => {
    const result = await tryFastPath({ text: 'qué temperatura hace en el salón', stateCache: cache });
    assert.match(result.speech.toLowerCase(), /sin lectura|no hay/);
  });

  it('returns null when the query does not match any pattern', async () => {
    const result = await tryFastPath({ text: 'cuéntame un chiste filosófico', stateCache: cache });
    assert.equal(result, null);
  });

  it('reports unknown areas with their name in the message', async () => {
    const result = await tryFastPath({ text: 'qué temperatura hace en el garaje', stateCache: cache });
    assert.equal(result?.handled, true);
    assert.match(result.speech.toLowerCase(), /garaje/);
    assert.match(result.speech.toLowerCase(), /no conozco|no tengo/);
  });

  it('computes the average temperature across the whole house', async () => {
    const result = await tryFastPath({ text: 'qué temperatura media hace en casa', stateCache: cache });
    assert.equal(result?.handled, true);
    assert.match(result.speech, /media|promedio/i);
    // Average of 24.6 and 23.8 is 24.2 (salón está unavailable y se ignora)
    assert.match(result.speech, /24\.2/);
  });

  it('computes the average humidity across the whole house', async () => {
    const result = await tryFastPath({ text: 'qué humedad promedio hay en toda la casa', stateCache: cache });
    assert.equal(result?.handled, true);
    assert.match(result.speech, /40/);
  });

  it('lists the configured areas', async () => {
    const result = await tryFastPath({ text: 'qué áreas hay configuradas', stateCache: cache });
    assert.equal(result?.handled, true);
    assert.match(result.speech, /3 áreas/);
    assert.match(result.speech, /Despacho/);
    assert.match(result.speech, /Cocina/);
    assert.match(result.speech, /Salón/);
  });

  it('returns null on empty input', async () => {
    assert.equal(await tryFastPath({ text: '', stateCache: cache }), null);
    assert.equal(await tryFastPath({ text: '   ', stateCache: cache }), null);
  });

  it('turns on a device by exact friendly_name', async () => {
    const calls = [];
    const haClient = { callService: async (d, s, data) => { calls.push({ d, s, data }); return []; } };
    const result = await tryFastPath({ text: 'enciende luz esquina', stateCache: cache, haClient });
    assert.equal(result?.handled, true);
    assert.match(result.speech.toLowerCase(), /encendido/);
    assert.deepEqual(calls, [{ d: 'light', s: 'turn_on', data: { entity_id: 'light.luz_esquina' } }]);
  });

  it('turns off a device matching by partial words', async () => {
    const calls = [];
    const haClient = { callService: async (d, s, data) => { calls.push({ d, s, data }); return []; } };
    const result = await tryFastPath({ text: 'apaga el humidificador', stateCache: cache, haClient });
    assert.equal(result?.handled, true);
    assert.match(result.speech.toLowerCase(), /apagado/);
    assert.deepEqual(calls, [{ d: 'switch', s: 'turn_off', data: { entity_id: 'switch.humidificador' } }]);
  });

  it('asks for disambiguation when multiple devices match', async () => {
    const calls = [];
    const haClient = { callService: async () => { calls.push(true); return []; } };
    const result = await tryFastPath({ text: 'enciende luz', stateCache: cache, haClient });
    assert.equal(result?.handled, true);
    assert.match(result.speech.toLowerCase(), /varios|coinciden/);
    assert.equal(calls.length, 0);
  });

  it('reports when no device matches the target', async () => {
    const calls = [];
    const haClient = { callService: async () => { calls.push(true); return []; } };
    const result = await tryFastPath({ text: 'enciende ascensor', stateCache: cache, haClient });
    assert.equal(result?.handled, true);
    assert.match(result.speech.toLowerCase(), /no encuentro/);
    assert.equal(calls.length, 0);
  });

  it('on/off pattern is skipped when haClient is not provided', async () => {
    const result = await tryFastPath({ text: 'enciende luz esquina', stateCache: cache });
    assert.equal(result, null);
  });

  it('handles a callService failure gracefully', async () => {
    const haClient = { callService: async () => { throw new Error('HA timeout'); } };
    const result = await tryFastPath({ text: 'enciende luz esquina', stateCache: cache, haClient });
    assert.equal(result?.handled, true);
    assert.match(result.speech.toLowerCase(), /no pude/);
    assert.match(result.speech, /HA timeout/);
  });
});
