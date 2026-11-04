import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatHeatingReport, buildHeatingReport } from '../../../src/modules/heating/heating-report.js';

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

describe('buildHeatingReport', () => {
  it('lee los estados de HA y los formatea', async () => {
    assert.match(await buildHeatingReport(async () => full()), /Hoy: 2 arranques/);
  });

  it('si HA falla, dice que no pudo leerla con el motivo (escapado)', async () => {
    const html = await buildHeatingReport(async () => { throw new Error('HA <503>'); });
    assert.match(html, /No pude leer la calefacción: HA &lt;503&gt;/);
  });
});
