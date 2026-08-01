import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDishwasherWatcher,
  buildReport,
  prettyProgram,
  parseNumber,
  isActiveState,
} from '../../../src/modules/dishwasher/dishwasher-watcher.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function buildFakeScheduler() {
  return { schedule() { return { stop() {} }; }, delay() { return { cancel() {} }; }, stopAll() {} };
}
function buildFakeNotifier() {
  const sent = [];
  return { sent, service: { async sendNotification(msg) { sent.push(msg); } } };
}
function buildFakeStateCache(map = {}) {
  let states = { ...map };
  return {
    set(id, state) { states[id] = state; },
    setAll(next) { states = { ...next }; },
    findEntities() { return Object.entries(states).map(([entity_id, state]) => ({ entity_id, state })); },
  };
}
function buildMemoryStore() {
  const data = { lastState: null, cycles: [] };
  let saves = 0;
  return {
    saves: () => saves,
    async load() { return data; },
    async save() { saves += 1; },
    getLastState: () => data.lastState,
    setLastState: (s) => { data.lastState = s; },
    addCycle: (c) => data.cycles.push(c),
    getCycles: () => [...data.cycles],
    get data() { return data; },
  };
}

const ENERGY = 'sensor.lavavajillas_consumo_de_energia';
const WATER = 'sensor.lavavajillas_consumo_de_agua';
const PROGRAM = 'sensor.lavavajillas_programa';
const STATE = 'sensor.lavavajillas';

function makeWatcher(cache, notifier, store, nowFn) {
  return createDishwasherWatcher({
    logger: noopLogger,
    scheduler: buildFakeScheduler(),
    notificationService: notifier.service,
    stateCache: cache,
    store,
    nowFn,
  });
}

describe('dishwasher — helpers puros', () => {
  it('parseNumber descarta unknown/unavailable', () => {
    assert.equal(parseNumber('0.9'), 0.9);
    assert.equal(parseNumber('unknown'), null);
    assert.equal(parseNumber('unavailable'), null);
    assert.equal(parseNumber(null), null);
  });
  it('prettyProgram formatea', () => {
    assert.equal(prettyProgram('eco'), 'Eco');
    assert.equal(prettyProgram('quick_power_wash'), 'Quick power wash');
    assert.equal(prettyProgram('no_program'), '—');
  });
  it('isActiveState: hay ciclo → sondeo rápido; reposo → lento', () => {
    for (const s of ['programmed', 'in_use', 'pause', 'rinse_hold', 'waiting_to_start', 'reserved']) {
      assert.equal(isActiveState(s), true, `activo: ${s}`);
    }
    for (const s of ['off', 'idle', 'on', 'not_connected', 'program_ended', 'failure']) {
      assert.equal(isActiveState(s), false, `reposo: ${s}`);
    }
  });
  it('buildReport incluye consumo del ciclo y los 4 periodos', () => {
    const r = buildReport(
      { energy: 0.9, water: 12, program: 'eco' },
      { today: { count: 1, energy: 0.9, water: 12 }, week: { count: 5, energy: 4.6, water: 61 }, month: { count: 22, energy: 20, water: 264 }, year: { count: 180, energy: 165, water: 2160 } },
    );
    assert.match(r, /programa Eco/);
    assert.match(r, /Este lavado: 0,9 kWh · 12 L/);
    assert.match(r, /Semana: 5 lavados/);
    assert.match(r, /Año: 180 lavados/);
  });
});

describe('dishwasher watcher — checkOnce', () => {
  it('al pasar a program_ended registra el ciclo y avisa con consumos', async () => {
    const cache = buildFakeStateCache({ [STATE]: 'in_use', [ENERGY]: '0.7', [WATER]: '10', [PROGRAM]: 'eco' });
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore();
    const now = new Date(2026, 6, 15, 11, 0);
    const w = makeWatcher(cache, notifier, store, () => now);

    await w.checkOnce(); // in_use: fija baseline, sin aviso
    assert.equal(notifier.sent.length, 0);

    cache.setAll({ [STATE]: 'program_ended', [ENERGY]: '0.9', [WATER]: '12', [PROGRAM]: 'eco' });
    await w.checkOnce();

    assert.equal(notifier.sent.length, 1);
    assert.equal(store.getCycles().length, 1);
    assert.equal(store.getCycles()[0].energy, 0.9);
    assert.equal(store.getCycles()[0].water, 12);
    assert.match(notifier.sent[0].text, /Lavavajillas terminado/);
    assert.match(notifier.sent[0].text, /0,9 kWh · 12 L/);
  });

  it('no repite el aviso si sigue en program_ended', async () => {
    const cache = buildFakeStateCache({ [STATE]: 'program_ended', [ENERGY]: '0.9', [WATER]: '12', [PROGRAM]: 'eco' });
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore();
    store.setLastState('in_use'); // veníamos de en marcha
    const w = makeWatcher(cache, notifier, store, () => new Date(2026, 6, 15, 11, 0));

    await w.checkOnce(); // detecta el fin → 1 aviso
    await w.checkOnce(); // sigue program_ended → nada
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1);
    assert.equal(store.getCycles().length, 1);
  });

  it('captura el último consumo válido aunque se resetee a unknown al terminar', async () => {
    const cache = buildFakeStateCache({ [STATE]: 'in_use', [ENERGY]: '0.8', [WATER]: '11', [PROGRAM]: 'eco' });
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore();
    const w = makeWatcher(cache, notifier, store, () => new Date(2026, 6, 15, 11, 0));

    await w.checkOnce(); // guarda lastEnergy=0.8, lastWater=11
    // el sensor se resetea a unknown justo cuando termina
    cache.setAll({ [STATE]: 'program_ended', [ENERGY]: 'unknown', [WATER]: 'unknown', [PROGRAM]: 'no_program' });
    await w.checkOnce();

    assert.equal(store.getCycles().length, 1);
    assert.equal(store.getCycles()[0].energy, 0.8); // recuperado del último válido
    assert.equal(store.getCycles()[0].water, 11);
    assert.equal(store.getCycles()[0].program, 'eco');
  });

  it('estados intermedios no registran nada', async () => {
    const cache = buildFakeStateCache({ [STATE]: 'programmed', [ENERGY]: 'unknown', [WATER]: 'unknown', [PROGRAM]: 'eco' });
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore();
    const w = makeWatcher(cache, notifier, store, () => new Date(2026, 6, 15, 8, 0));
    await w.checkOnce();
    cache.set(STATE, 'in_use');
    await w.checkOnce();
    assert.equal(notifier.sent.length, 0);
    assert.equal(store.getCycles().length, 0);
  });
});
