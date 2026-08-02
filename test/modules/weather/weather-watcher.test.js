import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createWeatherWatcher,
  buildTelegramMessage,
  buildVoiceMessage,
} from '../../../src/modules/weather/weather-watcher.js';
import {
  classifyHour,
  evaluateForecast,
  severityRank,
} from '../../../src/modules/weather/weather-store.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function buildFakeScheduler() {
  return { schedule() { return { stop() {} }; }, delay() { return { cancel() {} }; }, stopAll() {} };
}
function buildFakeNotifier() {
  const sent = [];
  return { sent, service: { async sendNotification(msg) { sent.push(msg); } } };
}
function buildFakeAnnouncer() {
  const calls = [];
  return { calls, announcer: { async announce(message, options = {}) { calls.push({ message, options }); } } };
}
function buildMemoryStore(initial = null) {
  let lastAlert = initial;
  let saves = 0;
  return {
    saves: () => saves,
    async load() {},
    async save() { saves += 1; },
    getLastAlert: () => lastAlert,
    setLastAlert: (a) => { lastAlert = a; },
  };
}

/** fetch falso que devuelve `data` como respuesta OK de Open-Meteo. */
function fetchReturning(data) {
  return async () => ({ ok: true, status: 200, async json() { return data; } });
}

/**
 * Construye una respuesta de Open-Meteo con horas relativas a `now` (offset 0 =
 * tiempos en UTC), de modo que la ventana temporal sea determinista con cualquier
 * TZ. `hours`: [{ deltaH, precipitation?, probability?, weathercode? }].
 */
function makeData(now, hours) {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 16);
  return {
    utc_offset_seconds: 0,
    hourly: {
      time: hours.map((h) => iso(now.getTime() + h.deltaH * 3600000)),
      precipitation: hours.map((h) => h.precipitation ?? 0),
      precipitation_probability: hours.map((h) => h.probability ?? 0),
      weathercode: hours.map((h) => h.weathercode ?? 0),
    },
  };
}

const THRESHOLDS = { probThreshold: 50, precipThreshold: 0.3 };

describe('classifyHour', () => {
  it('marca tormenta por weathercode 95/96/99', () => {
    assert.equal(classifyHour({ weathercode: 95 }, THRESHOLDS), 'storm');
    assert.equal(classifyHour({ weathercode: 99, probability: 0 }, THRESHOLDS), 'storm');
  });
  it('marca lluvia por probabilidad alta o precipitación', () => {
    assert.equal(classifyHour({ probability: 60, weathercode: 3 }, THRESHOLDS), 'rain');
    assert.equal(classifyHour({ precipitation: 0.5, probability: 10 }, THRESHOLDS), 'rain');
  });
  it('devuelve null si no llega al umbral', () => {
    assert.equal(classifyHour({ probability: 20, precipitation: 0.1, weathercode: 2 }, THRESHOLDS), null);
  });
});

describe('severityRank', () => {
  it('storm > rain > nada', () => {
    assert.ok(severityRank('storm') > severityRank('rain'));
    assert.ok(severityRank('rain') > severityRank(null));
  });
});

describe('evaluateForecast', () => {
  const now = new Date('2026-08-02T14:00:00Z');
  const opts = { nowMs: now.getTime(), lookaheadMs: 6 * 3600000, ...THRESHOLDS };

  it('coge la lluvia más próxima dentro de la ventana', () => {
    const { hourly } = makeData(now, [
      { deltaH: 1, probability: 10 },
      { deltaH: 3, probability: 70 },
      { deltaH: 5, probability: 90 },
    ]);
    const entries = hourly.time.map((t, i) => ({
      epochMs: Date.parse(`${t}Z`), hourLabel: t.slice(11, 16),
      probability: hourly.precipitation_probability[i], precipitation: hourly.precipitation[i], weathercode: hourly.weathercode[i],
    }));
    const r = evaluateForecast(entries, opts);
    assert.equal(r.severity, 'rain');
    assert.equal(r.prob, 70); // la de +3h, la más próxima que cumple
  });

  it('la tormenta tiene prioridad aunque llueva antes', () => {
    const { hourly } = makeData(now, [
      { deltaH: 1, probability: 80 },
      { deltaH: 2, weathercode: 95 },
    ]);
    const entries = hourly.time.map((t, i) => ({
      epochMs: Date.parse(`${t}Z`), hourLabel: t.slice(11, 16),
      probability: hourly.precipitation_probability[i], precipitation: hourly.precipitation[i], weathercode: hourly.weathercode[i],
    }));
    const r = evaluateForecast(entries, opts);
    assert.equal(r.severity, 'storm');
  });

  it('ignora horas fuera de la ventana o pasadas', () => {
    const { hourly } = makeData(now, [
      { deltaH: -1, probability: 90 }, // pasada
      { deltaH: 8, probability: 90 }, // fuera de 6h
    ]);
    const entries = hourly.time.map((t, i) => ({
      epochMs: Date.parse(`${t}Z`), hourLabel: t.slice(11, 16),
      probability: hourly.precipitation_probability[i], precipitation: hourly.precipitation[i], weathercode: hourly.weathercode[i],
    }));
    assert.equal(evaluateForecast(entries, opts).severity, null);
  });
});

// now diurno (local 14:00) → fuera de la franja nocturna de voz (22-08).
const dayNow = () => new Date(2026, 7, 2, 14, 0, 0);
// now nocturno (local 03:00) → dentro de la franja nocturna de voz.
const nightNow = () => new Date(2026, 7, 2, 3, 0, 0);

function makeWatcher({ fetchFn, notifier, announcer, store, nowFn, extra = {} }) {
  return createWeatherWatcher({
    logger: noopLogger,
    scheduler: buildFakeScheduler(),
    notificationService: notifier.service,
    store,
    alexaAnnouncer: announcer ? announcer.announcer : null,
    latitude: 40.4,
    longitude: -3.5,
    fetchFn,
    nowFn,
    ...extra,
  });
}

describe('createWeatherWatcher.checkOnce', () => {
  it('avisa por Telegram y Alexa cuando se prevé lluvia', async () => {
    const notifier = buildFakeNotifier();
    const announcer = buildFakeAnnouncer();
    const store = buildMemoryStore();
    const data = makeData(dayNow(), [{ deltaH: 3, probability: 70 }]);
    const watcher = makeWatcher({ fetchFn: fetchReturning(data), notifier, announcer, store, nowFn: dayNow });

    await watcher.checkOnce();

    assert.equal(notifier.sent.length, 1);
    assert.match(notifier.sent[0].text, /Lluvia probable/);
    assert.equal(announcer.calls.length, 1);
    assert.match(announcer.calls[0].message, /se prevé lluvia/i);
    // broadcast a toda la casa: sin target explícito
    assert.deepEqual(announcer.calls[0].options, {});
    assert.equal(store.getLastAlert().severity, 'rain');
  });

  it('no repite el aviso del mismo episodio', async () => {
    const notifier = buildFakeNotifier();
    const announcer = buildFakeAnnouncer();
    const store = buildMemoryStore();
    const data = makeData(dayNow(), [{ deltaH: 3, probability: 70 }]);
    const watcher = makeWatcher({ fetchFn: fetchReturning(data), notifier, announcer, store, nowFn: dayNow });

    await watcher.checkOnce();
    await watcher.checkOnce();

    assert.equal(notifier.sent.length, 1);
    assert.equal(announcer.calls.length, 1);
  });

  it('re-avisa si el episodio escala de lluvia a tormenta', async () => {
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore();
    const rain = makeData(dayNow(), [{ deltaH: 3, probability: 70 }]);
    const storm = makeData(dayNow(), [{ deltaH: 2, weathercode: 95 }]);
    let data = rain;
    const watcher = makeWatcher({ fetchFn: async () => ({ ok: true, async json() { return data; } }), notifier, store, nowFn: dayNow });

    await watcher.checkOnce();
    data = storm;
    await watcher.checkOnce();

    assert.equal(notifier.sent.length, 2);
    assert.match(notifier.sent[1].text, /tormenta/i);
    assert.equal(store.getLastAlert().severity, 'storm');
  });

  it('al despejar reinicia el estado y un nuevo episodio vuelve a avisar', async () => {
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore();
    const rain = makeData(dayNow(), [{ deltaH: 3, probability: 70 }]);
    const clear = makeData(dayNow(), [{ deltaH: 3, probability: 0 }]);
    let data = rain;
    const watcher = makeWatcher({ fetchFn: async () => ({ ok: true, async json() { return data; } }), notifier, store, nowFn: dayNow });

    await watcher.checkOnce(); // avisa
    data = clear;
    await watcher.checkOnce(); // despeja → reinicia
    assert.equal(store.getLastAlert(), null);
    data = rain;
    await watcher.checkOnce(); // nuevo episodio → vuelve a avisar

    assert.equal(notifier.sent.length, 2);
  });

  it('de noche manda Telegram pero NO anuncia por voz', async () => {
    const notifier = buildFakeNotifier();
    const announcer = buildFakeAnnouncer();
    const store = buildMemoryStore();
    const data = makeData(nightNow(), [{ deltaH: 2, probability: 80 }]);
    const watcher = makeWatcher({ fetchFn: fetchReturning(data), notifier, announcer, store, nowFn: nightNow });

    await watcher.checkOnce();

    assert.equal(notifier.sent.length, 1);
    assert.equal(announcer.calls.length, 0);
  });

  it('si Open-Meteo falla no avisa ni lanza', async () => {
    const notifier = buildFakeNotifier();
    const store = buildMemoryStore();
    const watcher = makeWatcher({
      fetchFn: async () => ({ ok: false, status: 500 }),
      notifier, store, nowFn: dayNow,
    });
    await watcher.checkOnce();
    assert.equal(notifier.sent.length, 0);
  });
});

describe('mensajes', () => {
  it('Telegram lluvia lleva emoji, hora y probabilidad', () => {
    const msg = buildTelegramMessage({ severity: 'rain', at: { hourLabel: '18:00' }, prob: 70 });
    assert.match(msg, /🌧️/);
    assert.match(msg, /18:00/);
    assert.match(msg, /70%/);
  });
  it('voz no lleva emojis', () => {
    const msg = buildVoiceMessage({ severity: 'storm', at: { hourLabel: '18:00' } });
    assert.doesNotMatch(msg, /[🌧️⛈️]/u);
    assert.match(msg, /tormenta/i);
  });
});
