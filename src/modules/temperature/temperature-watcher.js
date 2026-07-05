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
  reAlertMs = 3 * 60 * 60 * 1000,
  excludePattern = '',
  quietWindowStart = '',
  quietWindowEnd = '',
  nowFn = () => new Date(),
}) {
  const excludeRe = buildExcludeRegex(excludePattern);
  const quietWindow = parseQuietWindow(quietWindowStart, quietWindowEnd);
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
    const valid = sensors.filter((s) => isFiniteNumber(s.state) && !isExcluded(s, excludeRe));
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
      const triggered = mean >= summerMeanThreshold || hottest.temp >= summerRoomThreshold;
      return { triggered, kind: 'calor', room: hottest.name, roomTemp: hottest.temp, mean };
    }
    const coldest = rooms.reduce((a, b) => (b.temp < a.temp ? b : a));
    const triggered = mean <= winterMeanThreshold || coldest.temp <= winterRoomThreshold;
    return { triggered, kind: 'frio', room: coldest.name, roomTemp: coldest.temp, mean };
  }

  /**
   * @param {{ kind: 'calor'|'frio', room: string, roomTemp: number, mean: number }} ev
   * @param {{ reminder?: boolean }} [opts]
   * @returns {string}
   */
  function buildAlertMessage(ev, { reminder = false } = {}) {
    const head = ev.kind === 'calor'
      ? (reminder ? '🌡️ Sigue haciendo calor en casa' : '🌡️ Hace calor en casa')
      : (reminder ? '🥶 Sigue haciendo frío en casa' : '🥶 Hace frío en casa');
    const since = reminder ? ` (desde hace ${formatDuration(nowFn().getTime() - alert.since)})` : '';
    return `${head}${since}\nTemperatura ${ev.room}: ${fmt1(ev.roomTemp)}º | Temperatura media: ${fmt1(ev.mean)}º`;
  }

  /**
   * @param {number} mean
   * @returns {string}
   */
  function buildRecoveryMessage(mean) {
    return `✅ Temperatura normalizada en casa\nTemperatura media: ${fmt1(mean)}º`;
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

    if (ev.triggered) {
      if (!alert.active) {
        alert = { active: true, kind: ev.kind, since: now, notifiedAt: 0 };
        if (inQuiet) {
          logger.info({ kind: ev.kind }, 'Temperature alert durante franja silenciosa — notificación suprimida');
        } else {
          logger.warn({ kind: ev.kind, room: ev.room, roomTemp: ev.roomTemp, mean: ev.mean }, 'Temperature alert');
          await notify(buildAlertMessage(ev), 'warn');
          alert.notifiedAt = now;
        }
        return;
      }
      // Alerta ya activa.
      if (inQuiet) return;
      if (alert.notifiedAt === 0) {
        // Entró durante quiet hours y ahora ya estamos fuera → notificar.
        await notify(buildAlertMessage(ev), 'warn');
        alert.notifiedAt = now;
      } else if (now - alert.notifiedAt >= reAlertMs) {
        await notify(buildAlertMessage(ev, { reminder: true }), 'warn');
        alert.notifiedAt = now;
      } else {
        logger.debug('Temperature alert sigue activa (anti-spam, sin re-aviso)');
      }
      return;
    }

    // No hay condición de alerta.
    if (alert.active) {
      const wasNotified = alert.notifiedAt > 0;
      alert = { active: false, kind: null, since: 0, notifiedAt: 0 };
      if (wasNotified && !inQuiet) {
        logger.info({ mean: ev.mean }, 'Temperature normalizada');
        await notify(buildRecoveryMessage(ev.mean), 'success');
      } else {
        logger.info('Temperature normalizada (recuperación no notificada)');
      }
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
