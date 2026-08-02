/**
 * Weather watcher (LUI-TSK-0088).
 *
 * Sondea Open-Meteo (API gratuita, sin key) para la ubicación de casa y avisa por
 * Telegram (siempre) y por voz en Alexa (solo en horario diurno) cuando se prevé
 * lluvia o tormenta en las próximas horas. Pensado para la ropa tendida.
 *
 * Comportamiento:
 *  - Sondeo periódico (por defecto 30 min) + una primera comprobación al arrancar.
 *  - Ventana de previsión configurable (por defecto próximas 6 h).
 *  - Lluvia si probabilidad ≥ probThreshold o precipitación ≥ precipThreshold;
 *    tormenta si el weathercode es 95/96/99.
 *  - Anti-repetición por episodio: no re-avisa mientras el mismo episodio siga en
 *    la ventana; solo re-avisa si la severidad ESCALA (lluvia → tormenta). Cuando
 *    la ventana se despeja, reinicia el estado y un futuro episodio vuelve a avisar.
 *  - Franja nocturna para la voz (por defecto 22:00–08:00): Telegram sí, Alexa no.
 *  - Si Open-Meteo falla, se descarta el tick y NO se inventan datos.
 *
 * Los mensajes son en español, claros y descriptivos (norma del proyecto).
 *
 * @param {{
 *   logger?: import('pino').Logger,
 *   scheduler: import('../../infrastructure/scheduler/scheduler.js').Scheduler,
 *   notificationService: import('../notifications/notification-service.js').NotificationService,
 *   store: ReturnType<import('./weather-store.js').createWeatherStore>,
 *   alexaAnnouncer?: import('../home-assistant/ha-alexa-announcer.js').AlexaAnnouncer|null,
 *   latitude: number,
 *   longitude: number,
 *   checkIntervalMs?: number,
 *   lookaheadHours?: number,
 *   probThreshold?: number,
 *   precipThreshold?: number,
 *   alexaTarget?: string,
 *   alexaQuietStart?: string,
 *   alexaQuietEnd?: string,
 *   initialDelayMs?: number,
 *   fetchFn?: typeof fetch,
 *   nowFn?: () => Date,
 * }} deps
 * @returns {WeatherWatcher}
 */
import { isInQuietWindow, parseQuietWindow } from '../cluster/cluster-watcher.js';
import { evaluateForecast, severityRank } from './weather-store.js';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

export function createWeatherWatcher({
  logger,
  scheduler,
  notificationService,
  store,
  alexaAnnouncer = null,
  latitude,
  longitude,
  checkIntervalMs = 30 * 60 * 1000,
  lookaheadHours = 6,
  probThreshold = 50,
  precipThreshold = 0.3,
  alexaTarget = '',
  alexaQuietStart = '22:00',
  alexaQuietEnd = '08:00',
  initialDelayMs = 30 * 1000,
  fetchFn = fetch,
  nowFn = () => new Date(),
}) {
  if (!store) throw new Error('createWeatherWatcher requires store');
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('createWeatherWatcher requires numeric latitude/longitude');
  }

  const alexaQuietWindow = parseQuietWindow(alexaQuietStart, alexaQuietEnd);
  const lookaheadMs = lookaheadHours * 60 * 60 * 1000;
  let job = null;
  let firstJob = null;
  let loaded = false;

  async function fetchForecast() {
    const url = `${OPEN_METEO_URL}?latitude=${latitude}&longitude=${longitude}`
      + '&hourly=precipitation,precipitation_probability,weathercode'
      + '&timezone=auto&forecast_days=2';
    const res = await fetchFn(url);
    if (!res?.ok) throw new Error(`Open-Meteo HTTP ${res?.status}`);
    return res.json();
  }

  /**
   * Convierte la respuesta de Open-Meteo en entradas con epoch absoluto (para
   * comparar con "ahora") y etiqueta horaria local (para el mensaje).
   *
   * Open-Meteo con timezone=auto devuelve horas LOCALES ("2026-08-02T18:00") más
   * `utc_offset_seconds`; el epoch absoluto = interpretar la hora como UTC menos
   * el offset. Así la comparación es correcta sea cual sea la TZ del contenedor.
   */
  function buildEntries(data) {
    const h = data?.hourly;
    if (!h || !Array.isArray(h.time)) return [];
    const offsetMs = Number(data.utc_offset_seconds ?? 0) * 1000;
    return h.time.map((t, i) => ({
      epochMs: Date.parse(`${t}Z`) - offsetMs,
      hourLabel: String(t).slice(11, 16),
      precipitation: h.precipitation?.[i],
      probability: h.precipitation_probability?.[i],
      weathercode: h.weathercode?.[i],
    }));
  }

  async function notify(text) {
    try {
      await notificationService.sendNotification({ text, level: 'warn' });
    } catch (error) {
      logger?.error({ err: error?.message }, 'Weather notification failed to dispatch');
    }
  }

  async function announceVoice(message) {
    if (!alexaAnnouncer) return;
    if (isInQuietWindow(nowFn(), alexaQuietWindow)) {
      logger?.info('Weather: anuncio por voz suprimido (franja nocturna)');
      return;
    }
    const targets = alexaTarget
      ? alexaTarget.split(',').map((t) => t.trim()).filter(Boolean)
      : [''];
    for (const target of targets) {
      try {
        await alexaAnnouncer.announce(message, target ? { target } : {});
      } catch (error) {
        logger?.error({ err: error?.message, target }, 'Weather Alexa announce failed');
      }
    }
  }

  /**
   * Un tick de evaluación. Idempotente respecto al estado de aviso guardado.
   * @returns {Promise<void>}
   */
  async function checkOnce() {
    if (!loaded) {
      await store.load();
      loaded = true;
    }

    let data;
    try {
      data = await fetchForecast();
    } catch (error) {
      logger?.warn({ err: error?.message }, 'Weather watcher: fallo al consultar Open-Meteo');
      return;
    }

    const entries = buildEntries(data);
    if (entries.length === 0) {
      logger?.warn('Weather watcher: previsión vacía o con formato inesperado');
      return;
    }

    const nowMs = nowFn().getTime();
    const result = evaluateForecast(entries, { nowMs, lookaheadMs, probThreshold, precipThreshold });
    const last = store.getLastAlert();

    // Ventana despejada: reinicia el estado para que un futuro episodio avise.
    if (!result.severity) {
      if (last) {
        store.setLastAlert(null);
        await store.save();
        logger?.info('Weather watcher: ventana despejada, estado de aviso reiniciado');
      }
      return;
    }

    // Hay evento. Solo avisar si es nuevo (no había aviso) o si escala en severidad.
    const escalated = Boolean(last) && severityRank(result.severity) > severityRank(last.severity);
    if (last && !escalated) {
      logger?.debug({ severity: result.severity }, 'Weather watcher: mismo episodio, sin re-aviso');
      return;
    }

    store.setLastAlert({
      severity: result.severity,
      onset: new Date(result.at.epochMs).toISOString(),
      notifiedAt: nowFn().toISOString(),
    });
    await store.save();

    logger?.info(
      { severity: result.severity, at: result.at.hourLabel, prob: result.prob, escalated },
      'Weather alert',
    );
    await notify(buildTelegramMessage(result, { escalated }));
    await announceVoice(buildVoiceMessage(result, { escalated }));
  }

  function start() {
    if (job) return;
    firstJob = scheduler.delay(() => checkOnce(), initialDelayMs);
    job = scheduler.schedule(checkOnce, checkIntervalMs, 'weather-watcher');
    logger?.info(
      { intervalMs: checkIntervalMs, lookaheadHours, probThreshold, precipThreshold },
      'Weather watcher started',
    );
  }

  function stop() {
    job?.stop();
    job = null;
    firstJob?.cancel?.();
    firstJob = null;
  }

  return { start, stop, checkOnce, getState: () => ({ ...(store.getLastAlert() ?? {}) }) };
}

/**
 * Mensaje de Telegram (con emoji, español claro).
 *
 * @param {{ severity: 'storm'|'rain', at: { hourLabel: string }, prob: number|null }} result
 * @param {{ escalated?: boolean }} [opts]
 * @returns {string}
 */
export function buildTelegramMessage(result, { escalated = false } = {}) {
  const when = result.at.hourLabel;
  const prob = Number.isFinite(result.prob) ? ` (${result.prob}% de probabilidad)` : '';
  if (result.severity === 'storm') {
    const head = escalated ? '⛈️ El aviso sube a tormenta' : '⛈️ Tormenta prevista';
    return `${head} hacia las ${when}${prob}.\nRecoge la ropa si la tienes tendida.`;
  }
  return `🌧️ Lluvia probable hacia las ${when}${prob}.\nSi tienes ropa tendida, recógela; y mejor no tender.`;
}

/**
 * Texto hablado para Alexa: sin emojis ni HTML, frase natural.
 *
 * @param {{ severity: 'storm'|'rain', at: { hourLabel: string } }} result
 * @param {{ escalated?: boolean }} [opts]
 * @returns {string}
 */
export function buildVoiceMessage(result, { escalated = false } = {}) {
  const when = result.at.hourLabel;
  if (result.severity === 'storm') {
    const head = escalated ? 'Atención, el tiempo empeora a tormenta' : 'Atención, se prevé tormenta';
    return `${head} hacia las ${when}. Recoge la ropa tendida.`;
  }
  return `Atención, se prevé lluvia hacia las ${when}. Si tienes ropa tendida, recógela.`;
}

/**
 * @typedef {Object} WeatherWatcher
 * @property {() => void} start
 * @property {() => void} stop
 * @property {() => Promise<void>} checkOnce
 * @property {() => object} getState
 */
