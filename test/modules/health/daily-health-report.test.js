import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { collectHealth, createDailyHealthReport } from '../../../src/modules/health/daily-health-report.js';

const NOW = new Date('2026-08-03T05:30:00Z');

function tempSensor(id, state, dc = 'temperature', friendly = '') {
  return { entity_id: id, state: String(state), last_changed: NOW.toISOString(), attributes: { device_class: dc, friendly_name: friendly || id } };
}
function auto(id, state) {
  return { entity_id: id, state, last_changed: NOW.toISOString(), attributes: {} };
}
function sw(id, hoursAgo) {
  return { entity_id: id, state: 'off', last_changed: new Date(NOW.getTime() - hoursAgo * 3600000).toISOString(), attributes: {} };
}
const cover = { entity_id: 'cover.persiana_salon_cortina', state: 'open', last_changed: NOW.toISOString(), attributes: { current_position: 30 } };

const CAPS = [
  { name: 'temperature', status: 'enabled' },
  { name: 'dishwasher', status: 'enabled' },
  { name: 'weather', status: 'enabled' },
  { name: 'email', status: 'placeholder' },
];
const CFG = {
  outdoorEntity: 'sensor.ext',
  riegoValves: [{ entity: 'switch.valv1', label: 'canal 1' }, { entity: 'switch.valv2', label: 'canal 2' }],
  riegoStaleHours: 36,
};

describe('collectHealth', () => {
  it('HA caído → aviso "no responde"', () => {
    const r = collectHealth({ states: null, capabilities: CAPS, config: CFG, now: NOW });
    assert.equal(r.hasWarning, true);
    assert.match(r.message, /Home Assistant NO responde/);
  });

  it('casa sana → lista watchers, persianas, riego OK, temperatura', () => {
    const states = [
      tempSensor('sensor.salon', 26, 'temperature', 'Salón'),
      tempSensor('sensor.cocina', 28, 'temperature', 'Cocina'),
      tempSensor('sensor.ext', 31, 'temperature', 'Sensor Ext 5'),
      auto('automation.persiana_verano_1', 'on'),
      auto('automation.persiana_verano_2', 'on'),
      auto('automation.persiana_verano_3', 'on'),
      auto('automation.persiana_verano_4', 'on'),
      cover,
      sw('switch.valv1', 20),
      sw('switch.valv2', 10),
    ];
    const r = collectHealth({ states, capabilities: CAPS, config: CFG, now: NOW });
    assert.equal(r.hasWarning, false);
    assert.match(r.message, /Watchers: temperatura · lavavajillas · tiempo/);
    assert.match(r.message, /Persianas verano: 4\/4 activas · salón al 70%/); // 100-30
    assert.match(r.message, /Riego canal 1: válvula OK/);
    assert.match(r.message, /Temperatura: 27\.0° de media \(exterior 31°\)/); // (26+28)/2, ext excluido
    assert.doesNotMatch(r.message, /⚠️/);
  });

  it('válvula sin actuar en >36h → aviso', () => {
    const states = [sw('switch.valv1', 72), sw('switch.valv2', 5)];
    const r = collectHealth({ states, capabilities: [], config: CFG, now: NOW });
    assert.equal(r.hasWarning, true);
    assert.match(r.message, /Riego canal 1: la válvula no se activa desde hace 72 h/);
    assert.match(r.message, /Riego canal 2: válvula OK/);
  });

  it('alguna persiana desactivada → aviso', () => {
    const states = [auto('automation.persiana_verano_1', 'on'), auto('automation.persiana_verano_2', 'off'), cover];
    const r = collectHealth({ states, capabilities: [], config: CFG, now: NOW });
    assert.equal(r.hasWarning, true);
    assert.match(r.message, /⚠️ Persianas verano: 1\/2 activas/);
  });

  it('excluye el sensor exterior y las lecturas imposibles (0°) de la media', () => {
    const states = [
      tempSensor('sensor.salon', 26, 'temperature', 'Salón'),
      tempSensor('sensor.ts0222_lux', 0, 'temperature', 'Lux salón'), // sensor roto
      tempSensor('sensor.ext', 35, 'temperature'),
    ];
    const r = collectHealth({ states, capabilities: [], config: { ...CFG, riegoValves: [] }, now: NOW });
    assert.match(r.message, /Temperatura: 26\.0° de media/); // solo salón; 0° y ext fuera
  });
});

describe('createDailyHealthReport', () => {
  const noop = { info() {}, warn() {}, error() {}, debug() {} };
  const sched = { schedule: () => ({ stop() {} }) };

  it('run() lee estados y envía el parte', async () => {
    const sent = [];
    const r = createDailyHealthReport({
      logger: noop, scheduler: sched,
      notificationService: { async sendNotification(m) { sent.push(m); } },
      fetchStates: async () => [tempSensor('sensor.salon', 26, 'temperature', 'Salón')],
      capabilities: CAPS, config: { ...CFG, riegoValves: [] }, nowFn: () => NOW,
    });
    await r.run();
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Parte diario/);
    assert.equal(sent[0].level, 'info');
  });

  it('si fetchStates falla, envía "HA no responde" y no lanza', async () => {
    const sent = [];
    const r = createDailyHealthReport({
      logger: noop, scheduler: sched,
      notificationService: { async sendNotification(m) { sent.push(m); } },
      fetchStates: async () => { throw new Error('timeout'); },
      config: CFG, nowFn: () => NOW,
    });
    await r.run();
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Home Assistant NO responde/);
    assert.equal(sent[0].level, 'warn');
  });

  it('requiere fetchStates', () => {
    assert.throws(() => createDailyHealthReport({ scheduler: sched, notificationService: {} }), /fetchStates/);
  });
});
