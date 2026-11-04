import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatHeatingReport, formatRadiatorsReport, buildHeatingReport } from '../../../src/modules/heating/heating-report.js';

const st = (entity_id, state) => ({ entity_id, state, attributes: {} });
const full = ({ heating = 'off', startsToday = '2', hoursToday = '1.25', startsWeek = '5', hoursWeek = '3.67' } = {}) => [
  st('binary_sensor.calefaccion_salon_calentando', heating),
  st('sensor.calefaccion_salon_arranques_hoy', startsToday),
  st('sensor.calefaccion_salon_horas_hoy', hoursToday),
  st('sensor.calefaccion_salon_arranques_semana', startsWeek),
  st('sensor.calefaccion_salon_horas_semana', hoursWeek),
  st('light.salon', 'on'),
];

describe('formatHeatingReport', () => {
  it('muestra arranques y horas de hoy y de la semana', () => {
    const html = formatHeatingReport(full());
    assert.match(html, /Calefacción salón/);
    assert.match(html, /Hoy: 2 arranques · 1 h 15 min/);
    assert.match(html, /Esta semana: 5 arranques · 3 h 40 min/);
    assert.doesNotMatch(html, /calentando ahora/i);
  });

  it('usa singular con un arranque y minutos sueltos sin horas', () => {
    const html = formatHeatingReport(full({ startsToday: '1', hoursToday: '0.5' }));
    assert.match(html, /Hoy: 1 arranque · 30 min/);
  });

  it('sin uso dice que no ha arrancado', () => {
    const html = formatHeatingReport(full({ startsToday: '0', hoursToday: '0.0' }));
    assert.match(html, /Hoy: no ha arrancado/);
  });

  it('avisa si está calentando en este momento', () => {
    assert.match(formatHeatingReport(full({ heating: 'on' })), /calentando ahora/i);
  });

  it('si faltan sensores o no tienen dato, lo dice claro', () => {
    assert.match(formatHeatingReport([st('light.salon', 'on')]), /sin datos/i);
    assert.match(formatHeatingReport(full({ hoursWeek: 'unavailable' })), /sin datos/i);
  });
});

const radiator = (room, { heating = 'off', today = '0.0', week = '0.0' } = {}) => [
  st(`binary_sensor.radiador_${room}_calentando`, heating),
  st(`sensor.radiador_${room}_horas_hoy`, today),
  st(`sensor.radiador_${room}_horas_semana`, week),
];
const radiators = () => [
  ...radiator('dormitorio_dani', { today: '1.25', week: '3.0' }),
  ...radiator('dormitorio_principal', { today: '0.5', week: '2.0' }),
  ...radiator('despacho', { heating: 'unavailable' }),
  ...radiator('dormitorio_pabli', { heating: 'unavailable' }),
];

describe('formatRadiatorsReport', () => {
  it('da horas de hoy y semana por radiador y su % de la semana como estimación', () => {
    const html = formatRadiatorsReport(radiators());
    assert.match(html, /Radiadores/);
    assert.match(html, /estimad/i);
    assert.match(html, /Dormitorio Dani: hoy 1 h 15 min · semana 3 h \(60 %\)/);
    assert.match(html, /Dormitorio Principal: hoy 30 min · semana 2 h \(40 %\)/);
  });

  it('las válvulas sin datos salen como sin datos y no entran en el reparto', () => {
    const html = formatRadiatorsReport(radiators());
    assert.match(html, /Despacho: sin datos \(¿pila\?\)/);
    assert.match(html, /Dormitorio Pabli: sin datos \(¿pila\?\)/);
  });

  it('sin uso hoy dice hoy nada', () => {
    const html = formatRadiatorsReport(radiator('dormitorio_dani', { week: '1.0' }));
    assert.match(html, /Dormitorio Dani: hoy nada · semana 1 h \(100 %\)/);
  });

  it('si ningún radiador ha pedido calor en la semana no da porcentajes', () => {
    const html = formatRadiatorsReport(radiator('dormitorio_dani'));
    assert.match(html, /Dormitorio Dani: no ha pedido calor esta semana/);
    assert.doesNotMatch(html, /%/);
  });

  it('marca el radiador que está calentando ahora', () => {
    const html = formatRadiatorsReport(radiator('dormitorio_dani', { heating: 'on', today: '0.25', week: '0.25' }));
    assert.match(html, /Dormitorio Dani: hoy 15 min · semana 15 min \(100 %\) · calentando ahora/);
  });

  it('si faltan los sensores, todas las salas salen sin datos', () => {
    const html = formatRadiatorsReport([st('light.salon', 'on')]);
    assert.equal(html.match(/sin datos/g).length, 4);
  });
});

describe('buildHeatingReport', () => {
  it('lee los estados de HA y los formatea', async () => {
    assert.match(await buildHeatingReport(async () => full()), /Hoy: 2 arranques/);
  });

  it('incluye el bloque de radiadores tras el del salón', async () => {
    const html = await buildHeatingReport(async () => [...full(), ...radiators()]);
    assert.match(html, /Calefacción salón[\s\S]+Radiadores[\s\S]+Dormitorio Dani: hoy 1 h 15 min/);
  });

  it('si HA falla, dice que no pudo leerla con el motivo (escapado)', async () => {
    const html = await buildHeatingReport(async () => { throw new Error('HA <503>'); });
    assert.match(html, /No pude leer la calefacción: HA &lt;503&gt;/);
  });
});
