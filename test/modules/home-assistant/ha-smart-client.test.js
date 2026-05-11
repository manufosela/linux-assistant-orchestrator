import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSmartHomeAssistantClient } from '../../../src/modules/home-assistant/ha-smart-client.js';

/**
 * @returns {object}
 */
function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

const FIXTURE = [
  {
    id: 'despacho', name: 'Despacho',
    entities: [
      { entity_id: 'sensor.despacho_temp', domain: 'sensor', friendly_name: 'Temp', device_class: 'temperature', state: '24.6', unit: '°C' },
    ],
  },
];

/**
 * @param {object[]} areas
 */
function makeCache(areas) {
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
    findEntities: ({ areaQuery, deviceClass } = {}) => {
      const out = [];
      const sources = areaQuery
        ? [areas.find((a) => norm(a.id) === norm(areaQuery) || norm(a.name) === norm(areaQuery))].filter(Boolean)
        : areas;
      for (const area of sources) {
        for (const e of area.entities ?? []) {
          if (deviceClass && e.device_class !== deviceClass) continue;
          out.push({ ...e, area_id: area.id, area_name: area.name });
        }
      }
      return out;
    },
    findEntitiesByName: () => [],
  };
}

describe('home-assistant — smart client', () => {
  it('uses fast path for known patterns and avoids the LLM', async () => {
    let llmCalls = 0;
    const haClient = {
      processConversation: async () => { llmCalls += 1; return { speech: 'llm', responseType: 'action_done', errorCode: null, conversationId: null, raw: {} }; },
      checkHealth: async () => true,
    };
    const cache = makeCache(FIXTURE);
    const smart = createSmartHomeAssistantClient({ haClient, stateCache: cache, logger: silentLogger() });

    const result = await smart.processConversation('qué temperatura hace en el despacho');
    assert.equal(llmCalls, 0, 'fast path should bypass the LLM');
    assert.match(result.speech, /24\.6/);
    assert.equal(result.raw?.fastPath, true);
  });

  it('falls back to the underlying client when no pattern matches', async () => {
    let captured = null;
    const haClient = {
      processConversation: async (text) => { captured = text; return { speech: 'fallback', responseType: 'action_done', errorCode: null, conversationId: 'x', raw: {} }; },
      checkHealth: async () => true,
    };
    const cache = makeCache(FIXTURE);
    const smart = createSmartHomeAssistantClient({ haClient, stateCache: cache, logger: silentLogger() });

    const result = await smart.processConversation('reproducir Bach en el salón');
    assert.equal(captured, 'reproducir Bach en el salón');
    assert.equal(result.speech, 'fallback');
  });

  it('falls back when fast path throws', async () => {
    const haClient = {
      processConversation: async () => ({ speech: 'fallback', responseType: 'action_done', errorCode: null, conversationId: null, raw: {} }),
      checkHealth: async () => true,
    };
    // Cache that throws to simulate a corrupt state
    const cache = {
      areaCount: 1,
      listAreas: () => [{ id: 'x', name: 'X' }],
      findArea: () => { throw new Error('boom'); },
      findEntities: () => { throw new Error('boom'); },
    };
    const smart = createSmartHomeAssistantClient({ haClient, stateCache: cache, logger: silentLogger() });

    const result = await smart.processConversation('qué temperatura hace en el despacho');
    assert.equal(result.speech, 'fallback');
  });

  it('skips fast path when there is no cache', async () => {
    let llmCalls = 0;
    const haClient = {
      processConversation: async () => { llmCalls += 1; return { speech: 'fallback', responseType: 'action_done', errorCode: null, conversationId: null, raw: {} }; },
      checkHealth: async () => true,
    };
    const smart = createSmartHomeAssistantClient({ haClient, logger: silentLogger() });

    await smart.processConversation('qué temperatura hace en el despacho');
    assert.equal(llmCalls, 1);
  });
});
