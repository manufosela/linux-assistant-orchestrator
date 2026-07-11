/**
 * Temperature watcher (LUI-TSK-0071).
 *
 * Vigila periódicamente los sensores de temperatura de Home Assistant y avisa
 * por Telegram según la temporada:
 *  - Verano (por defecto may–oct): alerta si la media de la casa ≥ 30.0 o
 *    cualquier habitación ≥ 31.0.
 *  - Invierno (por defecto nov–abr): alerta si la media ≤ 20.1 o cualquier
 *    habitación ≤ 20.1.
 *
 * Comportamiento (calcado del patrón de cluster-watcher):
 *  - Estado de alerta global en memoria; no repite el aviso mientras la alerta
 *    siga activa (anti-spam), con re-aviso opcional cada `reAlertMs`.
 *  - Al normalizarse la temperatura, avisa de la recuperación.
 *  - Franja silenciosa nocturna (quiet hours): dentro de la franja detecta pero
 *    no avisa; al salir, si la alerta persiste, avisa.
 *  - Si Home Assistant no responde o un sensor da 'unknown'/'unavailable', se
 *    descarta y NO se inventan datos.
 *
 * Los mensajes son en español, claros y descriptivos (norma del proyecto).
 *
 * @param {{
 *   logger: import('pino').Logger,
 *   scheduler: import('../../infrastructure/scheduler/scheduler.js').Scheduler,
 *   notificationService: import('../notifications/notification-service.js').NotificationService,
 *   stateCache: import('../home-assistant/ha-state-cache.js').HomeAssistantStateCache,
 *   checkIntervalMs?: number,
 *   summerMonths?: number[],
 *   winterMonths?: number[],
 *   summerMeanThreshold?: number,
 *   summerRoomThreshold?: number,
 *   winterMeanThreshold?: number,
 *   winterRoomThreshold?: number,
 *   reAlertMs?: number,
 *   excludePattern?: string,
 *   quietWindowStart?: string,
 *   quietWindowEnd?: string,
 *   nowFn?: () => Date,
 * }} deps
 * @returns {TemperatureWatcher}
 */
import { isInQuietWindow, parseQuietWindow, formatDuration } from '../cluster/cluster-watcher.js';

export function createTemperatureWatcher({
  logger,
  scheduler,
  notificationService,
  stateCache,
  checkIntervalMs = 15 * 60 * 1000,
  summerMonths = [5, 6, 7, 8, 9, 10],
  winterMonths = [11, 12, 1, 2, 3, 4],
  summerMeanThreshold = 30.0,
  summerRoomThreshold = 31.0,
  winterMeanThreshold = 20.1,
  winterRoomThreshold = 20.1,
  // Histéresis: tras una alerta, la vuelta a la normalidad (aviso de bajada/
  // subida, útil p.ej. para apagar el aire) NO se declara al cruzar de vuelta el
  // umbral de alerta, sino al alcanzar este umbral de recuperación.
  summerRecoveryMean = 25.0,
  winterRecoveryMean = 22.0,
  reAlertMs = 3 * 60 * 60 * 1000,
  excludePattern = '',
  requireArea = true,
  outdoorEntity = '',
  quietWindowStart = '',
  quietWindowEnd = '',
  alexaAnnouncer = null,
  alexaTarget = '',
  // Franja en la que NUNCA se anuncia por voz (Telegram sí). Más amplia que la
  // franja silenciosa general. Por defecto 22:00–09:00.
  alexaQuietStart = '22:00',
  alexaQuietEnd = '09:00',
  nowFn = () => new Date(),
}) {
  const excludeRe = buildExcludeRegex(excludePattern);
  const quietWindow = parseQuietWindow(quietWindowStart, quietWindowEnd);
  const alexaQuietWindow = parseQuietWindow(alexaQuietStart, alexaQuietEnd);
  if (quietWindow) {
    logger.info(
      { start: quietWindowStart, end: quietWindowEnd },
      'Temperature quiet window habilitada: avisos suprimidos en franja nocturna',
    );
  }

  /** @type {AlertState} */
  let alert = { active: false, kind: null, since: 0, notifiedAt: 0 };
  /** @type {{ stop: () => void } | null} */
  let job = null;

  /**
   * @param {string} text
   * @param {'warn'|'success'} level
   */
  async function notify(text, level) {
    try {
      await notificationService.sendNotification({ text, level });
    } catch (error) {
      logger.error({ err: error?.message }, 'Temperature notification failed to dispatch');
    }
  }

  /**
   * Lee los sensores de temperatura del cache, descarta lecturas no numéricas y
   * las excluidas por patrón, y agrega media de la casa + temperatura por
   * habitación (media de los sensores de cada área).
   *
   * @returns {{ rooms: Array<{ name: string, temp: number }>, mean: number, sensorCount: number } | null}
   */
  function readRooms() {
    const sensors = stateCache.findEntities({ deviceClass: 'temperature' });
    const valid = sensors.filter((s) =>
      isFiniteNumber(s.state)
      // El sensor exterior no cuenta como interior aunque tenga área asignada.
      && s.entity_id !== outdoorEntity
      && !isExcluded(s, excludeRe)
      // Sólo sensores ubicados en una habitación: descarta duplicados y
      // dispositivos sin área (que suelen dar valores basura tipo 0.0 y
      // falsearían la media).
      && (!requireArea || Boolean(s.area_name && s.area_name.trim())),
    );
    if (valid.length === 0) return null;

    const allValues = valid.map((s) => Number(s.state));
    const mean = allValues.reduce((acc, v) => acc + v, 0) / allValues.length;

    /** @type {Map<string, number[]>} */
    const byRoom = new Map();
    for (const s of valid) {
      const room = (s.area_name && s.area_name.trim()) || s.friendly_name || s.entity_id;
      if (!byRoom.has(room)) byRoom.set(room, []);
      byRoom.get(room).push(Number(s.state));
    }
    const rooms = [...byRoom.entries()].map(([name, vals]) => ({
      name,
      temp: vals.reduce((acc, v) => acc + v, 0) / vals.length,
    }));
    return { rooms, mean, sensorCount: valid.length };
  }

  /**
   * Media de humedad relativa interior (device_class=humidity), con el mismo
   * filtro que la temperatura: descarta no numéricos, excluidos por patrón
   * (incluye exteriores tipo "Ext N") y —si requireArea— los sin habitación.
   *
   * @returns {number | null}
   */
  function readHumidityMean() {
    const sensors = stateCache.findEntities({ deviceClass: 'humidity' });
    const valid = sensors.filter((s) =>
      isFiniteNumber(s.state)
      && s.entity_id !== outdoorEntity
      && !isExcluded(s, excludeRe)
      && (!requireArea || Boolean(s.area_name && s.area_name.trim())),
    );
    if (valid.length === 0) return null;
    const values = valid.map((s) => Number(s.state));
    return values.reduce((acc, v) => acc + v, 0) / values.length;
  }

  /**
   * Temperatura del sensor exterior configurado (TEMP_OUTDOOR_ENTITY), o null si
   * no hay entity configurado o su lectura no es válida (unavailable).
   *
   * @returns {number | null}
   */
  function readOutdoorTemp() {
    if (!outdoorEntity) return null;
    const sensor = stateCache
      .findEntities({ deviceClass: 'temperature' })
      .find((s) => s.entity_id === outdoorEntity);
    if (!sensor || !isFiniteNumber(sensor.state)) return null;
    return Number(sensor.state);
  }

  /** @returns {'summer'|'winter'|null} */
  function currentSeason() {
    const month = nowFn().getMonth() + 1;
    if (summerMonths.includes(month)) return 'summer';
    if (winterMonths.includes(month)) return 'winter';
    return null;
  }

  /**
   * @param {{ rooms: Array<{ name: string, temp: number }>, mean: number }} reading
   * @param {'summer'|'winter'} season
   * @returns {{ triggered: boolean, kind: 'calor'|'frio', room: string, roomTemp: number, mean: number }}
   */
  function evaluate(reading, season) {
    const { rooms, mean } = reading;
    if (season === 'summer') {
      const hottest = rooms.reduce((a, b) => (b.temp > a.temp ? b : a));
      const isAlert = mean >= summerMeanThreshold || hottest.temp >= summerRoomThreshold;
      const isRecovered = mean <= summerRecoveryMean;
      return { kind: 'calor', room: hottest.name, roomTemp: hottest.temp, mean, isAlert, isRecovered };
    }
    const coldest = rooms.reduce((a, b) => (b.temp < a.temp ? b : a));
    const isAlert = mean <= winterMeanThreshold || coldest.temp <= winterRoomThreshold;
    const isRecovered = mean >= winterRecoveryMean;
    return { kind: 'frio', room: coldest.name, roomTemp: coldest.temp, mean, isAlert, isRecovered };
  }

  /**
   * Línea extra opcional: temperatura exterior y/o humedad media interior.
   * Vacía si no hay ninguna de las dos.
   *
   * @param {{ outdoorTemp?: number|null, humidityMean?: number|null }} [ctx]
   * @returns {string}
   */
  function buildExtraLine({ outdoorTemp = null, humidityMean = null } = {}) {
    const parts = [];
    if (outdoorTemp != null) parts.push(`🌡️ Exterior: ${fmt1(outdoorTemp)}º`);
    if (humidityMean != null) parts.push(`💧 Humedad media: ${Math.round(humidityMean)}%`);
    return parts.length ? `\n${parts.join(' · ')}` : '';
  }

  /**
   * @param {{ kind: 'calor'|'frio', room: string, roomTemp: number, mean: number }} ev
   * @param {{ reminder?: boolean, outdoorTemp?: number|null, humidityMean?: number|null }} [opts]
   * @returns {string}
   */
  function buildAlertMessage(ev, { reminder = false, outdoorTemp = null, humidityMean = null } = {}) {
    const head = ev.kind === 'calor'
      ? (reminder ? '🌡️ Sigue haciendo calor en casa' : '🌡️ Hace calor en casa')
      : (reminder ? '🥶 Sigue haciendo frío en casa' : '🥶 Hace frío en casa');
    const since = reminder ? ` (desde hace ${formatDuration(nowFn().getTime() - alert.since)})` : '';
    return `${head}${since}\nTemperatura ${ev.room}: ${fmt1(ev.roomTemp)}º | Temperatura media: ${fmt1(ev.mean)}º`
      + buildExtraLine({ outdoorTemp, humidityMean });
  }

  /**
   * Aviso de vuelta al rango tras una alerta (histéresis). Para calor es una
   * bajada (p.ej. señal para apagar el aire); para frío, una subida. NO usa la
   * palabra "normalizada".
   *
   * @param {{ kind: 'calor'|'frio', mean: number }} ev
   * @param {{ outdoorTemp?: number|null, humidityMean?: number|null }} [ctx]
   * @returns {string}
   */
  function buildDropMessage(ev, { outdoorTemp = null, humidityMean = null } = {}) {
    const head = ev.kind === 'calor' ? '✅ La temperatura ha bajado' : '✅ La temperatura ha subido';
    return `${head}\nTemperatura media: ${fmt1(ev.mean)}º`
      + buildExtraLine({ outdoorTemp, humidityMean });
  }

  /**
   * Texto hablado para Alexa: sin emojis ni HTML, grados enteros, frase natural.
   *
   * @param {{ kind: 'calor'|'frio', room: string, roomTemp: number, mean: number }} ev
   * @param {{ reminder?: boolean }} [opts]
   * @returns {string}
   */
  function buildVoiceMessage(ev, { reminder = false, drop = false } = {}) {
    if (drop) {
      return ev.kind === 'calor'
        ? `La temperatura ha bajado a ${Math.round(ev.mean)} grados.`
        : `La temperatura ha subido a ${Math.round(ev.mean)} grados.`;
    }
    const cond = ev.kind === 'calor'
      ? (reminder ? 'Sigue haciendo calor en casa' : 'Atención, hace calor en casa')
      : (reminder ? 'Sigue haciendo frío en casa' : 'Atención, hace frío en casa');
    return `${cond}. Temperatura en ${ev.room}, ${Math.round(ev.roomTemp)} grados. `
      + `Media de la casa, ${Math.round(ev.mean)} grados.`;
  }

  /**
   * Anuncia la alerta por voz en Alexa (best-effort). Sólo para alertas de
   * calor/frío, nunca para la recuperación. Si no hay announcer o falla, no
   * afecta al aviso de Telegram.
   *
   * @param {{ kind: 'calor'|'frio', room: string, roomTemp: number, mean: number }} ev
   * @param {{ reminder?: boolean }} [opts]
   * @returns {Promise<void>}
   */
  async function announceVoice(ev, opts = {}) {
    if (!alexaAnnouncer) return;
    if (isInQuietWindow(nowFn(), alexaQuietWindow)) {
      logger.info('Temperature: anuncio por Alexa suprimido (franja nocturna de voz)');
      return;
    }
    const message = buildVoiceMessage(ev, opts);
    // alexaTarget puede ser una lista separada por comas (p.ej. "casa,despacho").
    const targets = alexaTarget
      ? alexaTarget.split(',').map((t) => t.trim()).filter(Boolean)
      : [''];
    for (const target of targets) {
      try {
        await alexaAnnouncer.announce(message, target ? { target } : {});
      } catch (error) {
        logger.error({ err: error?.message, target }, 'Temperature Alexa announce failed');
      }
    }
  }

  /**
   * Un tick de evaluación. Idempotente respecto al estado de alerta.
   *
   * @returns {Promise<void>}
   */
  async function checkOnce() {
    let reading;
    try {
      await stateCache.refresh();
      reading = readRooms();
    } catch (error) {
      logger.error({ err: error?.message }, 'Temperature watcher: no se pudo leer Home Assistant');
      return;
    }
    if (!reading) {
      logger.warn('Temperature watcher: sin lecturas válidas de temperatura');
      return;
    }
    const season = currentSeason();
    if (!season) {
      logger.debug({ month: nowFn().getMonth() + 1 }, 'Temperature watcher: mes fuera de temporadas configuradas');
      return;
    }

    const ev = evaluate(reading, season);
    const now = nowFn().getTime();
    const inQuiet = isInQuietWindow(nowFn(), quietWindow);
    // Contexto extra para los mensajes: exterior (si hay lectura) + humedad media.
    const ctx = { outdoorTemp: readOutdoorTemp(), humidityMean: readHumidityMean() };

    if (!alert.active) {
      // Entrar en alerta al superar el umbral de alerta.
      if (ev.isAlert) {
        alert = { active: true, kind: ev.kind, since: now, notifiedAt: 0 };
        if (inQuiet) {
          logger.info({ kind: ev.kind }, 'Temperature alert durante franja silenciosa — notificación suprimida');
        } else {
          logger.warn({ kind: ev.kind, room: ev.room, roomTemp: ev.roomTemp, mean: ev.mean }, 'Temperature alert');
          await notify(buildAlertMessage(ev, ctx), 'warn');
          await announceVoice(ev);
          alert.notifiedAt = now;
        }
      }
      return;
    }

    // Alerta activa: histéresis. Sólo se declara la vuelta al rango al alcanzar
    // el umbral de recuperación (p.ej. media <= 25 en verano), no al cruzar de
    // vuelta el umbral de alerta. Es el aviso útil (p.ej. apagar el aire).
    if (ev.isRecovered) {
      alert = { active: false, kind: null, since: 0, notifiedAt: 0 };
      if (inQuiet) {
        logger.info({ mean: ev.mean }, 'Temperature: vuelta al rango durante franja silenciosa (sin aviso)');
      } else {
        logger.info({ mean: ev.mean }, 'Temperature: vuelta al rango (histéresis)');
        await notify(buildDropMessage(ev, ctx), 'success');
        await announceVoice(ev, { drop: true });
      }
      return;
    }

    // Sigue en alerta (entre el umbral de recuperación y el de alerta).
    if (inQuiet) return;
    if (alert.notifiedAt === 0) {
      // La alerta se abrió durante la franja silenciosa; ahora fuera, avisar.
      await notify(buildAlertMessage(ev, ctx), 'warn');
      await announceVoice(ev);
      alert.notifiedAt = now;
    } else if (now - alert.notifiedAt >= reAlertMs) {
      await notify(buildAlertMessage(ev, { reminder: true, ...ctx }), 'warn');
      await announceVoice(ev, { reminder: true });
      alert.notifiedAt = now;
    } else {
      logger.debug('Temperature alert sigue activa (anti-spam, sin re-aviso)');
    }
  }

  function start() {
    if (job) return;
    job = scheduler.schedule(checkOnce, checkIntervalMs, 'temperature-watcher');
    logger.info({ intervalMs: checkIntervalMs, quiet: Boolean(quietWindow) }, 'Temperature watcher started');
  }

  function stop() {
    job?.stop();
    job = null;
  }

  return { start, stop, checkOnce, getState: () => ({ ...alert }) };
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  if (value == null) return false;
  if (value === 'unknown' || value === 'unavailable') return false;
  return Number.isFinite(Number(value));
}

/**
 * @param {import('../home-assistant/ha-state-cache.js').EntitySnapshot} sensor
 * @param {RegExp|null} excludeRe
 * @returns {boolean}
 */
function isExcluded(sensor, excludeRe) {
  if (!excludeRe) return false;
  const haystack = `${sensor.friendly_name ?? ''} ${sensor.entity_id ?? ''} ${sensor.area_name ?? ''}`;
  return excludeRe.test(haystack);
}

/**
 * @param {string} pattern
 * @returns {RegExp|null}
 */
function buildExcludeRegex(pattern) {
  const p = String(pattern ?? '').trim();
  if (!p) return null;
  try {
    return new RegExp(p, 'i');
  } catch {
    return null;
  }
}

/**
 * @param {number} n
 * @returns {string}
 */
function fmt1(n) {
  return n.toFixed(1);
}

/**
 * @typedef {Object} AlertState
 * @property {boolean} active
 * @property {'calor'|'frio'|null} kind
 * @property {number} since - epoch ms del inicio de la alerta actual
 * @property {number} notifiedAt - epoch ms del último aviso enviado (0 = no notificado)
 */

/**
 * @typedef {Object} TemperatureWatcher
 * @property {() => void} start
 * @property {() => void} stop
 * @property {() => Promise<void>} checkOnce
 * @property {() => AlertState} getState
 */
