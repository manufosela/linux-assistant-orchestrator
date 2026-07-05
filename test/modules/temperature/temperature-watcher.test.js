import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTemperatureWatcher } from '../../../src/modules/temperature/temperature-watcher.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function buildFakeScheduler() {
  return { schedule() { return { stop() {} }; }, delay() { return { cancel() {} }; }, stopAll() {} };
}

function buildFakeNotifier() {
  const sent = [];
  return { sent, service: { async sendNotification(msg) { sent.push(msg); } } };
}

/**
 * Fake HA state cache. `entities` puede cambiarse entre ticks con setEntities().
 */
function buildFakeStateCache({ entities = [], throwOnRefresh = false } = {}) {
  let current = entities;
  return {
    refreshCalls: 0,
    setEntities(next) { current = next; },
    async refresh() {
      this.refreshCalls += 1;
      if (throwOnRefresh) throw new Error('HA no responde');
    },
    findEntities({ deviceClass } = {}) {
      return current.filter((e) => !deviceClass || e.device_class === deviceClass);
    },
  };
}

/** Helper para construir un sensor de temperatura. */
function temp(entity_id, state, area_name = '', friendly_name = '') {
  return {
    entity_id,
    domain: 'sensor',
    friendly_name: friendly_name || entity_id,
    device_class: 'temperature',
    state: String(state),
    unit: '°C',
    area_id: area_name,
    area_name,
  };
}

const SUMMER_NOON = new Date(2026, 6, 15, 12, 0); // julio, fuera de quiet
const WINTER_NOON = new Date(2026, 0, 15, 12, 0); // enero, fuera de quiet

function makeWatcher(stateCache, notifier, overrides = {}) {
  return createTemperatureWatcher({
    logger: noopLogger,
    scheduler: buildFakeScheduler(),
    notificationService: notifier.service,
    stateCache,
    quietWindowStart: '23:00',
    quietWindowEnd: '08:00',
    nowFn: () => overrides.now ?? SUMMER_NOON,
    ...overrides,
  });
}

describe('createTemperatureWatcher — verano', () => {
  it('avisa por MEDIA ≥ 30 aunque ninguna habitación llegue a 31', async () => {
    const cache = buildFakeStateCache({ entities: [
      temp('sensor.salon', 29.5, 'Salón'),
      temp('sensor.cocina', 30.5, 'Cocina'),
    ] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier);
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1);
    assert.match(notifier.sent[0].text, /Hace calor en casa/);
    assert.match(notifier.sent[0].text, /Temperatura media: 30\.0º/);
    assert.equal(notifier.sent[0].level, 'warn');
  });

  it('avisa por HABITACIÓN ≥ 31 aunque la media sea baja', async () => {
    const cache = buildFakeStateCache({ entities: [
      temp('sensor.salon', 24, 'Salón'),
      temp('sensor.cocina', 31.3, 'Cocina'),
    ] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier);
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1);
    assert.match(notifier.sent[0].text, /Temperatura Cocina: 31\.3º/);
  });

  it('no avisa si media < 30 y ninguna habitación ≥ 31', async () => {
    const cache = buildFakeStateCache({ entities: [
      temp('sensor.salon', 26, 'Salón'),
      temp('sensor.cocina', 28, 'Cocina'),
    ] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier);
    await w.checkOnce();
    assert.equal(notifier.sent.length, 0);
  });
});

describe('createTemperatureWatcher — invierno', () => {
  it('avisa por MEDIA ≤ 20.1 (frío)', async () => {
    const cache = buildFakeStateCache({ entities: [
      temp('sensor.salon', 19, 'Salón'),
      temp('sensor.cocina', 21, 'Cocina'),
    ] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier, { now: WINTER_NOON });
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1);
    assert.match(notifier.sent[0].text, /Hace frío en casa/);
    assert.match(notifier.sent[0].text, /Temperatura Salón: 19\.0º/);
  });

  it('no avisa si media y todas las habitaciones > 20.1', async () => {
    const cache = buildFakeStateCache({ entities: [
      temp('sensor.salon', 21.5, 'Salón'),
      temp('sensor.cocina', 22, 'Cocina'),
    ] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier, { now: WINTER_NOON });
    await w.checkOnce();
    assert.equal(notifier.sent.length, 0);
  });
});

describe('createTemperatureWatcher — anti-spam y recuperación', () => {
  it('no repite el aviso mientras la alerta sigue activa', async () => {
    const cache = buildFakeStateCache({ entities: [temp('sensor.cocina', 31.5, 'Cocina')] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier);
    await w.checkOnce();
    await w.checkOnce();
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1, 'solo un aviso pese a 3 ticks en alerta');
  });

  it('avisa de la recuperación cuando la temperatura se normaliza', async () => {
    const cache = buildFakeStateCache({ entities: [temp('sensor.cocina', 31.5, 'Cocina')] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier);
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1);
    cache.setEntities([temp('sensor.cocina', 26, 'Cocina')]);
    await w.checkOnce();
    assert.equal(notifier.sent.length, 2);
    assert.match(notifier.sent[1].text, /normalizada/);
    assert.equal(notifier.sent[1].level, 'success');
  });
});

describe('createTemperatureWatcher — franja silenciosa', () => {
  it('suprime el aviso dentro de la franja y avisa al salir si persiste', async () => {
    let now = new Date(2026, 6, 15, 3, 0); // 03:00, dentro de 23:00-08:00
    const cache = buildFakeStateCache({ entities: [temp('sensor.cocina', 32, 'Cocina')] });
    const notifier = buildFakeNotifier();
    const w = createTemperatureWatcher({
      logger: noopLogger,
      scheduler: buildFakeScheduler(),
      notificationService: notifier.service,
      stateCache: cache,
      quietWindowStart: '23:00',
      quietWindowEnd: '08:00',
      nowFn: () => now,
    });
    await w.checkOnce();
    assert.equal(notifier.sent.length, 0, 'suprimido en quiet hours');
    now = new Date(2026, 6, 15, 9, 0); // 09:00, fuera de la franja
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1, 'avisa al salir de la franja');
    assert.match(notifier.sent[0].text, /calor/);
  });
});

describe('createTemperatureWatcher — robustez', () => {
  it('si Home Assistant no responde, no avisa ni lanza', async () => {
    const cache = buildFakeStateCache({ entities: [temp('sensor.cocina', 35, 'Cocina')], throwOnRefresh: true });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier);
    await w.checkOnce();
    assert.equal(notifier.sent.length, 0);
  });

  it('descarta sensores unknown/unavailable; sin lecturas válidas no avisa', async () => {
    const cache = buildFakeStateCache({ entities: [
      temp('sensor.salon', 'unknown', 'Salón'),
      temp('sensor.cocina', 'unavailable', 'Cocina'),
    ] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier);
    await w.checkOnce();
    assert.equal(notifier.sent.length, 0);
  });

  it('excluye sensores no interiores (exterior/nevera) por patrón', async () => {
    const cache = buildFakeStateCache({ entities: [
      temp('sensor.temp_exterior', 36, 'Exterior'),
      temp('sensor.nevera', 4, 'Cocina', 'Nevera'),
      temp('sensor.salon', 26, 'Salón'),
    ] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier, {
      excludePattern: '(exterior|nevera|frigo|congelador)',
    });
    await w.checkOnce();
    // Solo cuenta el salón (26º): ni calor ni frío en verano → sin aviso.
    assert.equal(notifier.sent.length, 0);
  });
});
