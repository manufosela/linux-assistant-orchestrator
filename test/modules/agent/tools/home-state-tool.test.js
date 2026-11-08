import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHomeStateTool } from '../../../../src/modules/agent/tools/home-state-tool.js';

const STATES = [
  {
    entity_id: 'climate.salon',
    state: 'heat',
    attributes: {
      friendly_name: 'Salón', current_temperature: 19.5, temperature: 21, hvac_action: 'heating',
      preset_mode: 'schedule', hvac_modes: ['auto', 'heat', 'off'], supported_features: 401,
    },
  },
  {
    entity_id: 'climate.despacho',
    state: 'unavailable',
    attributes: { friendly_name: 'Despacho' },
  },
  {
    entity_id: 'sensor.temperatura_salon',
    state: '20.1',
    attributes: { friendly_name: 'Temperatura Salón', unit_of_measurement: '°C', device_class: 'temperature' },
  },
  { entity_id: 'light.esquina', state: 'off', attributes: { friendly_name: 'Luz esquina' } },
  { entity_id: 'sensor.humedad_cocina', state: 'unknown', attributes: { friendly_name: 'Humedad cocina', unit_of_measurement: '%' } },
];

const toolWith = (states, opts = {}) => createHomeStateTool({ fetchStates: async () => states, ...opts });

describe('get_home_state tool', () => {
  it('filters by type and returns the useful heating data, not every attribute', async () => {
    const result = await toolWith(STATES).execute({ domain: 'climate' });

    assert.equal(result.total, 2);
    assert.deepEqual(result.entidades[0], {
      id: 'climate.salon',
      nombre: 'Salón',
      estado: 'heat',
      temperatura_actual: 19.5,
      temperatura_objetivo: 21,
      accion: 'heating',
      modo: 'schedule',
    });
  });

  it('says plainly when a device has no connection or no data', async () => {
    const result = await toolWith(STATES).execute({ query: 'despacho' });
    const humidity = await toolWith(STATES).execute({ query: 'humedad' });

    assert.equal(result.entidades[0].estado, 'no disponible (sin conexión)');
    assert.equal(humidity.entidades[0].estado, 'sin dato');
  });

  it('matches every word of the query against name and id, ignoring accents and case', async () => {
    const result = await toolWith(STATES).execute({ query: 'temperatura del SALON' });

    assert.deepEqual(result.entidades, [
      { id: 'sensor.temperatura_salon', nombre: 'Temperatura Salón', estado: '20.1', unidad: '°C' },
    ]);
  });

  it('treats "calefacción" or "termostato" as the heating type, not as a word of the name', async () => {
    const withDomain = await toolWith(STATES).execute({ domain: 'climate', query: 'calefaccion' });
    const alone = await toolWith(STATES).execute({ query: 'termostato del salón' });

    assert.deepEqual(withDomain.entidades.map((e) => e.id), ['climate.salon', 'climate.despacho']);
    assert.deepEqual(alone.entidades.map((e) => e.id), ['climate.salon']);
  });

  it('combines query and type', async () => {
    const result = await toolWith(STATES).execute({ query: 'salón', domain: 'sensor' });

    assert.deepEqual(result.entidades.map((e) => e.id), ['sensor.temperatura_salon']);
  });

  it('caps the list and tells the model to narrow the search', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ entity_id: `light.l${i}`, state: 'on', attributes: {} }));

    const result = await toolWith(many, { maxResults: 3 }).execute({ domain: 'light' });

    assert.equal(result.total, 5);
    assert.equal(result.entidades.length, 3);
    assert.match(result.aviso, /afina/i);
  });

  it('refuses an empty request instead of dumping the whole house', async () => {
    await assert.rejects(() => toolWith(STATES).execute({}), /query o domain/);
  });

  it('declares its parameters for the model', () => {
    const tool = toolWith(STATES);

    assert.equal(tool.name, 'get_home_state');
    assert.ok(tool.parameters.properties.domain.enum.includes('climate'));
    assert.deepEqual(tool.parameters.required, []);
  });
});
