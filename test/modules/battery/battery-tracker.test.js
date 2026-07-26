import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBatteryTracker,
  isBatteryChange,
  isFiniteLevel,
  daysBetween,
  formatDate,
  humanizeDuration,
  buildChangeMessage,
  parseSeedCsv,
  resolveSeedEntityId,
} from '../../../src/modules/battery/battery-tracker.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

// ---- fakes (a mano, sin librería de mocking) ---------------------------------

function buildFakeScheduler() {
  return { schedule() { return { stop() {} }; }, delay() { return { cancel() {} }; }, stopAll() {} };
}

function buildFakeNotifier() {
  const sent = [];
  return { sent, service: { async sendNotification(msg) { sent.push(msg); } } };
}

function buildFakeStateCache(entities = []) {
  let current = entities;
  return {
    setEntities(next) { current = next; },
    findEntities({ deviceClass } = {}) {
      return current.filter((e) => !deviceClass || e.device_class === deviceClass);
    },
  };
}

/** Store en memoria con la misma API que el store real. */
function buildMemoryStore(initial = { levels: {}, history: {} }) {
  const data = { levels: { ...initial.levels }, history: structuredClone(initial.history) };
  let saves = 0;
  return {
    saves: () => saves,
    async load() { return data; },
    async save() { saves += 1; },
    getLastLevel(id) { return Object.prototype.hasOwnProperty.call(data.levels, id) ? data.levels[id] : null; },
    setLastLevel(id, lvl) { data.levels[id] = lvl; },
    getHistory(id) { return Array.isArray(data.history[id]) ? [...data.history[id]] : []; },
    hasHistory(id) { return Array.isArray(data.history[id]) && data.history[id].length > 0; },
    recordChange(id, c) { (data.history[id] ??= []).push(c); },
    isEmpty() { return Object.keys(data.levels).length === 0 && Object.keys(data.history).length === 0; },
    get data() { return data; },
  };
}

const battery = (id, state, name) => ({
  entity_id: id,
  domain: 'sensor',
  device_class: 'battery',
  friendly_name: name ?? id,
  state: String(state),
  unit: '%',
});

function makeTracker({ cache, notifier, store, nowFn, seedCsvPath = '', excludePattern = '' }) {
  return createBatteryTracker({
    logger: noopLogger,
    scheduler: buildFakeScheduler(),
    notificationService: notifier.service,
    stateCache: cache,
    store,
    seedCsvPath,
    excludePattern,
    nowFn,
  });
}

// ---- funciones puras ---------------------------------------------------------

describe('battery pure helpers', () => {
  it('isFiniteLevel acepta 0..100 y rechaza unknown/unavailable/fuera de rango', () => {
    assert.equal(isFiniteLevel('0'), true);
    assert.equal(isFiniteLevel('100'), true);
    assert.equal(isFiniteLevel('unavailable'), false);
    assert.equal(isFiniteLevel('unknown'), false);
    assert.equal(isFiniteLevel(null), false);
    assert.equal(isFiniteLevel('120'), false);
    assert.equal(isFiniteLevel('-5'), false);
  });

  it('isBatteryChange detecta salto al alza (15→100) pero no descensos ni subidas leves', () => {
    assert.equal(isBatteryChange(15, 100), true);
    assert.equal(isBatteryChange(49, 90), true);
    assert.equal(isBatteryChange(100, 99), false); // descenso
    assert.equal(isBatteryChange(45, 60), false); // no llega a jumpMin
    assert.equal(isBatteryChange(55, 100), false); // prev no era bajo
    assert.equal(isBatteryChange(null, 100), false); // sin baseline
  });

  it('daysBetween cuenta días redondeados', () => {
    assert.equal(daysBetween('2026-05-01T00:00:00Z', '2026-05-31T00:00:00Z'), 30);
    assert.equal(daysBetween('2026-05-01T00:00:00Z', '2026-05-01T10:00:00Z'), 0);
  });

  it('formatDate da dd/mm/aaaa', () => {
    assert.equal(formatDate('2026-07-25T12:00:00Z'), '25/07/2026');
  });

  it('humanizeDuration usa días y añade meses cuando procede', () => {
    assert.equal(humanizeDuration(1), '1 día');
    assert.equal(humanizeDuration(40), '40 días');
    assert.match(humanizeDuration(90), /90 días \(~3 meses\)/);
  });

  it('buildChangeMessage: primer cambio vs con duración', () => {
    const first = buildChangeMessage({ name: 'Despacho', level: 100, prevChange: null, nowIso: '2026-07-25T00:00:00Z' });
    assert.match(first, /Pila cambiada en «Despacho»/);
    assert.match(first, /primer cambio/);

    const withDur = buildChangeMessage({
      name: 'Salón',
      level: 100,
      prevChange: { date: '2026-04-25T00:00:00Z', level: 100 },
      nowIso: '2026-07-25T00:00:00Z',
    });
    assert.match(withDur, /La anterior duró/);
    assert.match(withDur, /25\/04\/2026/);
    assert.match(withDur, /25\/07\/2026/);
  });

  it('parseSeedCsv soporta cabecera con entity_id y formato legado', () => {
    const modern = parseSeedCsv('fecha,entity_id,nombre,nivel\n2026-07-25,sensor.a_battery,Despacho,100');
    assert.equal(modern.length, 1);
    assert.equal(modern[0].entityId, 'sensor.a_battery');
    assert.equal(modern[0].name, 'Despacho');
    assert.equal(modern[0].level, 100);

    const legacy = parseSeedCsv('fecha,sensor,nivel_al_cambiar\n2026-07-25,despacho_interior,100');
    assert.equal(legacy[0].sensor, 'despacho_interior');
    assert.equal(legacy[0].level, 100);
    assert.equal(legacy[0].entityId, undefined);
  });

  it('resolveSeedEntityId usa entity_id directo o resuelve por tokens/acentos', () => {
    const ents = [battery('sensor.temp_humedad_salon_battery', 90, 'Salón'), battery('sensor.temp_humedad_despacho_battery', 90, 'Despacho')];
    assert.equal(resolveSeedEntityId({ entityId: 'sensor.x_battery' }, ents), 'sensor.x_battery');
    assert.equal(resolveSeedEntityId({ sensor: 'salon' }, ents), 'sensor.temp_humedad_salon_battery');
    assert.equal(resolveSeedEntityId({ sensor: 'despacho_interior' }, ents), 'sensor.temp_humedad_despacho_battery');
    assert.equal(resolveSeedEntityId({ sensor: 'zzz' }, ents), null);
  });
});

// ---- checkOnce ---------------------------------------------------------------

describe('createBatteryTracker.checkOnce', () => {
  it('fija línea base en el primer avistamiento sin avisar', async () => {
    const cache = buildFakeStateCache([battery('sensor.a_battery', 45, 'Despacho')]);
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore();
    const tracker = makeTracker({ cache, notifier, store });

    await tracker.checkOnce();

    assert.equal(notifier.sent.length, 0);
    assert.equal(store.getLastLevel('sensor.a_battery'), 45);
  });

  it('avisa cuando detecta el salto de pila y guarda el cambio', async () => {
    const cache = buildFakeStateCache([battery('sensor.a_battery', 15, 'Despacho')]);
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore({ levels: { 'sensor.a_battery': 15 }, history: {} });
    let now = new Date('2026-07-25T09:00:00Z');
    const tracker = makeTracker({ cache, notifier, store, nowFn: () => now });

    cache.setEntities([battery('sensor.a_battery', 100, 'Despacho')]);
    await tracker.checkOnce();

    assert.equal(notifier.sent.length, 1);
    assert.match(notifier.sent[0].text, /Pila cambiada en «Despacho»/);
    assert.match(notifier.sent[0].text, /primer cambio/);
    assert.equal(store.getLastLevel('sensor.a_battery'), 100);
    assert.equal(store.getHistory('sensor.a_battery').length, 1);
  });

  it('calcula la duración desde el cambio anterior', async () => {
    const cache = buildFakeStateCache([battery('sensor.a_battery', 12, 'Salón')]);
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore({
      levels: { 'sensor.a_battery': 12 },
      history: { 'sensor.a_battery': [{ date: '2026-04-25T00:00:00.000Z', level: 100, name: 'Salón' }] },
    });
    const now = new Date('2026-07-25T00:00:00.000Z');
    const tracker = makeTracker({ cache, notifier, store, nowFn: () => now });

    cache.setEntities([battery('sensor.a_battery', 100, 'Salón')]);
    await tracker.checkOnce();

    assert.equal(notifier.sent.length, 1);
    assert.match(notifier.sent[0].text, /La anterior duró/);
    assert.match(notifier.sent[0].text, /91 días/); // abr→jul
  });

  it('no avisa por descensos normales, pero actualiza el nivel', async () => {
    const cache = buildFakeStateCache([battery('sensor.a_battery', 80, 'Despacho')]);
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore({ levels: { 'sensor.a_battery': 85 }, history: {} });
    const tracker = makeTracker({ cache, notifier, store });

    await tracker.checkOnce();

    assert.equal(notifier.sent.length, 0);
    assert.equal(store.getLastLevel('sensor.a_battery'), 80);
  });

  it('ignora sensores unavailable sin perder el baseline previo', async () => {
    const cache = buildFakeStateCache([battery('sensor.a_battery', 'unavailable', 'Despacho')]);
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore({ levels: { 'sensor.a_battery': 15 }, history: {} });
    const tracker = makeTracker({ cache, notifier, store });

    await tracker.checkOnce();
    assert.equal(notifier.sent.length, 0);
    assert.equal(store.getLastLevel('sensor.a_battery'), 15); // se conserva

    // vuelve con pila nueva → debe detectar el salto contra el 15 conservado
    cache.setEntities([battery('sensor.a_battery', 100, 'Despacho')]);
    await tracker.checkOnce();
    assert.equal(notifier.sent.length, 1);
  });

  it('ignora baterías recargables excluidas (móvil que se carga a diario)', async () => {
    const cache = buildFakeStateCache([battery('sensor.pixel_7_pro_battery_level', 40, 'Pixel 7 Pro Battery level')]);
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore({ levels: { 'sensor.pixel_7_pro_battery_level': 40 }, history: {} });
    const tracker = makeTracker({ cache, notifier, store, excludePattern: 'phone|pixel|tablet' });

    // el móvil se carga: 40 → 95. Sin exclusión sería un "cambio de pila"; con ella, nada.
    cache.setEntities([battery('sensor.pixel_7_pro_battery_level', 95, 'Pixel 7 Pro Battery level')]);
    await tracker.checkOnce();

    assert.equal(notifier.sent.length, 0);
  });

  it('no repite el aviso si el nivel se mantiene alto tras el cambio', async () => {
    const cache = buildFakeStateCache([battery('sensor.a_battery', 15, 'Despacho')]);
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore({ levels: { 'sensor.a_battery': 15 }, history: {} });
    const tracker = makeTracker({ cache, notifier, store, nowFn: () => new Date('2026-07-25T00:00:00Z') });

    cache.setEntities([battery('sensor.a_battery', 100, 'Despacho')]);
    await tracker.checkOnce();
    await tracker.checkOnce(); // segundo tick con 100 sostenido
    await tracker.checkOnce();

    assert.equal(notifier.sent.length, 1);
  });
});
