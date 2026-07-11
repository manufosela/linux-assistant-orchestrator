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

/** Helper para construir un sensor de humedad. */
function hum(entity_id, state, area_name = '', friendly_name = '') {
  return {
    entity_id,
    domain: 'sensor',
    friendly_name: friendly_name || entity_id,
    device_class: 'humidity',
    state: String(state),
    unit: '%',
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

  it('histéresis: no recupera al bajar de 30, solo al llegar a 25; sin "normalizada"', async () => {
    const cache = buildFakeStateCache({ entities: [temp('sensor.cocina', 31.5, 'Cocina')] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier);
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1, 'alerta inicial');
    // Baja a 28 (entre 25 y 30): sigue en alerta, sin nuevo aviso.
    cache.setEntities([temp('sensor.cocina', 28, 'Cocina')]);
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1, 'a 28 aún no recupera');
    // Baja a 24 (≤25): aviso de bajada, NO "normalizada".
    cache.setEntities([temp('sensor.cocina', 24, 'Cocina')]);
    await w.checkOnce();
    assert.equal(notifier.sent.length, 2);
    assert.match(notifier.sent[1].text, /ha bajado/);
    assert.doesNotMatch(notifier.sent[1].text, /normalizada/);
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

  it('con requireArea (default) ignora sensores sin habitación (valor basura 0.0)', async () => {
    const cache = buildFakeStateCache({ entities: [
      temp('sensor.zigbee_raro', 0.0, ''), // sin área, 0.0 arrastraría la media
      temp('sensor.cocina', 31.5, 'Cocina'),
    ] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier);
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1);
    // La media es 31.5 (solo cocina), no 15.75 (si el 0.0 contara).
    assert.match(notifier.sent[0].text, /Temperatura media: 31\.5º/);
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

describe('createTemperatureWatcher — exterior y humedad', () => {
  it('incluye temperatura exterior y humedad media en el aviso', async () => {
    const cache = buildFakeStateCache({ entities: [
      temp('sensor.cocina', 31.5, 'Cocina'),
      temp('sensor.ext', 34.2, 'Despacho', 'Sensor Ext 5'),
      hum('sensor.hum_cocina', 40, 'Cocina'),
      hum('sensor.hum_salon', 50, 'Salón'),
    ] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier, { outdoorEntity: 'sensor.ext' });
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1);
    assert.match(notifier.sent[0].text, /🌡️ Exterior: 34\.2º/);
    assert.match(notifier.sent[0].text, /💧 Humedad media: 45%/);
  });

  it('el sensor exterior NO cuenta en la media interior', async () => {
    const cache = buildFakeStateCache({ entities: [
      temp('sensor.cocina', 29, 'Cocina'),
      temp('sensor.ext', 40, 'Despacho', 'Sensor Ext 5'),
    ] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier, { outdoorEntity: 'sensor.ext' });
    await w.checkOnce();
    // Si el exterior (40º) contara, la media dispararía; solo cuenta cocina 29º.
    assert.equal(notifier.sent.length, 0);
  });

  it('omite el exterior si está unavailable, pero envía el aviso con humedad', async () => {
    const cache = buildFakeStateCache({ entities: [
      temp('sensor.cocina', 31.5, 'Cocina'),
      temp('sensor.ext', 'unavailable', 'Despacho', 'Sensor Ext 5'),
      hum('sensor.hum_cocina', 40, 'Cocina'),
    ] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier, { outdoorEntity: 'sensor.ext' });
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1);
    assert.doesNotMatch(notifier.sent[0].text, /Exterior/);
    assert.match(notifier.sent[0].text, /Humedad media: 40%/);
  });

  it('excluye los sensores "Ext N" de la humedad interior por patrón', async () => {
    const cache = buildFakeStateCache({ entities: [
      temp('sensor.cocina', 31.5, 'Cocina'),
      hum('sensor.hum_cocina', 40, 'Cocina'),
      hum('sensor.hum_ext', 90, 'Despacho', 'Sensor Ext 5 Humidity'),
    ] });
    const notifier = buildFakeNotifier();
    const w = makeWatcher(cache, notifier, { excludePattern: '\\bext\\b' });
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1);
    // Humedad media = 40 (solo cocina); el "Ext 5" (90%) queda excluido.
    assert.match(notifier.sent[0].text, /Humedad media: 40%/);
  });
});

describe('createTemperatureWatcher — Alexa', () => {
  function buildFakeAnnouncer() {
    const calls = [];
    return { calls, announcer: { announce: async (message, opts) => { calls.push({ message, opts }); }, listTargetAliases: () => [] } };
  }

  it('anuncia por voz la alerta, sin emojis ni símbolo de grado', async () => {
    const cache = buildFakeStateCache({ entities: [temp('sensor.cocina', 31.5, 'Cocina')] });
    const notifier = buildFakeNotifier();
    const alexa = buildFakeAnnouncer();
    const w = makeWatcher(cache, notifier, { alexaAnnouncer: alexa.announcer });
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1);
    assert.equal(alexa.calls.length, 1);
    assert.match(alexa.calls[0].message, /hace calor/i);
    assert.match(alexa.calls[0].message, /grados/);
    assert.doesNotMatch(alexa.calls[0].message, /[🌡️🥶º]/);
  });

  it('en franja de voz (22:00-09:00) NO suena por Alexa pero SÍ por Telegram', async () => {
    const cache = buildFakeStateCache({ entities: [temp('sensor.cocina', 31.5, 'Cocina')] });
    const notifier = buildFakeNotifier();
    const alexa = buildFakeAnnouncer();
    // 22:30: fuera de la franja general (23-08) pero dentro de la de voz (22-09).
    const now = new Date(2026, 6, 15, 22, 30);
    const w = makeWatcher(cache, notifier, { alexaAnnouncer: alexa.announcer, now });
    await w.checkOnce();
    assert.equal(notifier.sent.length, 1, 'Telegram sí a las 22:30');
    assert.equal(alexa.calls.length, 0, 'Alexa no a las 22:30');
  });

  it('anuncia por voz el aviso de bajada (a los 24 grados)', async () => {
    const cache = buildFakeStateCache({ entities: [temp('sensor.cocina', 31.5, 'Cocina')] });
    const notifier = buildFakeNotifier();
    const alexa = buildFakeAnnouncer();
    const w = makeWatcher(cache, notifier, { alexaAnnouncer: alexa.announcer });
    await w.checkOnce();
    cache.setEntities([temp('sensor.cocina', 24, 'Cocina')]);
    await w.checkOnce();
    assert.equal(alexa.calls.length, 2);
    assert.match(alexa.calls[1].message, /ha bajado a 24 grados/);
  });

  it('con TEMP_ALEXA_TARGET lista (casa,despacho) anuncia a cada destino', async () => {
    const cache = buildFakeStateCache({ entities: [temp('sensor.cocina', 31.5, 'Cocina')] });
    const notifier = buildFakeNotifier();
    const alexa = buildFakeAnnouncer();
    const w = makeWatcher(cache, notifier, { alexaAnnouncer: alexa.announcer, alexaTarget: 'casa,despacho' });
    await w.checkOnce();
    assert.equal(alexa.calls.length, 2);
    assert.deepEqual(alexa.calls.map((c) => c.opts?.target).sort(), ['casa', 'despacho']);
  });
});
