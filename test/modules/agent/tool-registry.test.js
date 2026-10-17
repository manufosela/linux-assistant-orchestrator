import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../../src/modules/agent/tool-registry.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const weatherTool = {
  name: 'get_weather',
  description: 'Previsión de hoy',
  parameters: {
    type: 'object',
    properties: { days: { type: 'integer' }, unit: { type: 'string', enum: ['C', 'F'] } },
    required: ['days'],
  },
  execute: async ({ days }) => ({ days, rain: '80%' }),
};

describe('tool-registry', () => {
  it('exposes the tools in OpenAI function format without the executor', () => {
    const registry = createToolRegistry([weatherTool], { logger });

    assert.deepEqual(registry.definitions(), [{
      type: 'function',
      function: { name: 'get_weather', description: 'Previsión de hoy', parameters: weatherTool.parameters },
    }]);
  });

  it('rejects duplicated or incomplete tools', () => {
    assert.throws(() => createToolRegistry([weatherTool, weatherTool], { logger }), /duplicada: get_weather/);
    assert.throws(() => createToolRegistry([{ name: 'x' }], { logger }), /mal definida: x/);
  });

  it('invokes the tool with the parsed arguments', async () => {
    const registry = createToolRegistry([weatherTool], { logger });

    assert.deepEqual(await registry.invoke({ name: 'get_weather', arguments: '{"days": 2}' }), { days: 2, rain: '80%' });
  });

  const errorCases = [
    ['an unknown tool', { name: 'nope', arguments: '{}' }, /Herramienta desconocida: nope/],
    ['a null call', null, /Herramienta desconocida/],
    ['a call without name', {}, /Herramienta desconocida/],
    ['non-text arguments', { name: 'get_weather', arguments: { days: 1 } }, /se esperaba texto JSON/],
    ['invalid JSON', { name: 'get_weather', arguments: '{days' }, /no es JSON/],
    ['non-object arguments', { name: 'get_weather', arguments: '[1]' }, /se esperaba un objeto/],
    ['a missing required argument', { name: 'get_weather', arguments: '{}' }, /obligatorio: days/],
    ['an argument of the wrong type', { name: 'get_weather', arguments: '{"days": "two"}' }, /no válido: days="two"/],
    ['an undeclared argument', { name: 'get_weather', arguments: '{"days": 1, "x": 1}' }, /no válido: x=1/],
    ['a value outside the enum', { name: 'get_weather', arguments: '{"days": 1, "unit": "K"}' }, /no válido: unit="K"/],
  ];
  for (const [label, call, expected] of errorCases) {
    it(`returns an explicit error for ${label}`, async () => {
      const registry = createToolRegistry([weatherTool], { logger });

      assert.match((await registry.invoke(call)).error, expected);
    });
  }

  it('returns and logs the error of a tool that throws', async () => {
    const warnings = [];
    const failing = { ...weatherTool, execute: async () => { throw new Error('Open-Meteo caído'); } };
    const registry = createToolRegistry([failing], { logger: { ...logger, warn: (obj) => warnings.push(obj) } });

    const result = await registry.invoke({ name: 'get_weather', arguments: '{"days": 1}' });

    assert.deepEqual(result, { error: 'Open-Meteo caído' });
    assert.equal(warnings[0].tool, 'get_weather');
  });

  for (const thrown of ['texto suelto', null]) {
    it(`returns an error when a tool throws a non-Error (${thrown})`, async () => {
      const failing = { ...weatherTool, execute: async () => { throw thrown; } };
      const registry = createToolRegistry([failing], { logger });

      assert.deepEqual(await registry.invoke({ name: 'get_weather', arguments: '{"days": 1}' }), { error: String(thrown) });
    });
  }
});
