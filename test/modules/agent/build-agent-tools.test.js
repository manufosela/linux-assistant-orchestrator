import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentTools, withCurrentDate } from '../../../src/modules/agent/build-agent-tools.js';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const webSearch = { search: async () => [] };

describe('buildAgentTools', () => {
  it('registers weather and web search when both are configured', () => {
    const tools = buildAgentTools({ weather: { latitude: 40, longitude: -3 }, webSearch, logger: silent });

    assert.deepEqual(tools.map((tool) => tool.name), ['get_weather_forecast', 'web_search']);
  });

  it('skips the tools whose service is not configured and logs why', () => {
    const warnings = [];
    const logger = { ...silent, warn: (obj) => warnings.push(obj) };

    const tools = buildAgentTools({ weather: { latitude: null, longitude: null }, webSearch: undefined, logger });

    assert.deepEqual(tools, []);
    assert.deepEqual(warnings.map((w) => w.tool), ['get_weather_forecast', 'web_search']);
  });
});

describe('withCurrentDate', () => {
  it('adds the current local date and time as a system message after the system prompt', () => {
    const messages = [{ role: 'system', content: 'Eres luis' }, { role: 'user', content: '¿Lloverá hoy?' }];

    const result = withCurrentDate(messages, new Date('2026-10-17T12:30:00Z'), 'Europe/Madrid');

    assert.equal(result.length, 3);
    assert.equal(result[1].role, 'system');
    assert.match(result[1].content, /sábado, 17 de octubre de 2026.*14:30/);
    assert.deepEqual(result[2], messages[1]);
  });
});
