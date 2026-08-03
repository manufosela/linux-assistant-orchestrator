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
 *    siga activa (anti-spam). Sólo re-avisa si la temperatura EMPEORA
 *    `reAlertRiseDelta` ºC sobre el último valor avisado (LUI-TSK-0084); ya no
 *    se re-avisa por tiempo transcurrido.
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
 *   reAlertRiseDelta?: number,
 *   excludePattern?: string,
 *   quietWindowStart?: string,
 *   quietWindowEnd?: string,
 *   nowFn?: () => Date,
 * }} deps
 * @returns {TemperatureWatcher}
 */
import { isInQuietWindow, parseQuietWindow, formatDuration } from '../cluster/cluster-watcher.js';
// Filtro compartido con el fast path (LUI-TSK-0081): la media que se avisa y la
// que se responde al preguntar deben salir del MISMO criterio.
import { buildExcludeRegex, isExcluded } from '../home-assistant/sensor-filter.js';

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
  // Re-aviso SOLO si la temperatura EMPEORA este delta (ºC) sobre el último valor
  // avisado; ya NO se re-avisa por tiempo transcurrido (LUI-TSK-0084).
  reAlertRiseDelta = 2.0,
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
  // Suelo de cordura: lecturas de interior por debajo de esto se descartan por
  // sensor roto (p.ej. el sensor de luz TS0222 reporta "temperatura" 0.0º y
  // falsearía la media). Ningún interior real baja de aquí ni en invierno.
  plausibleMin = 5,
  // Histéresis (ºC) para re-armar cada alerta y evitar parpadeo en el umbral.
  hysteresis = 1.0,
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

  // Dos alertas INDEPENDIENTES (LUI-TSK-0089): la de "concern" (calor en verano /
  // frío en invierno) y la de "relief" (fresco en verano / templado en invierno).
  // Cada una es edge-trigger con histéresis; ya NO dependen una de otra (antes el
  // aviso de "ha bajado a 25" sólo saltaba tras una alerta de calor).
  /** @type {Record<'concern'|'relief', DirState>} */
  const alerts = {
    concern: { active: false, since: 0, notifiedAt: 0, lastMean: null },
    relief: { active: false, since: 0, notifiedAt: 0, lastMean: null },
  };
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
      // Suelo de cordura: descarta lecturas imposibles de sensores rotos (el
      // sensor de luz TS0222 tiene área Salón pero marca "temperatura" 0.0º).
      && Number(s.state) >= plausibleMin
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
      && Number(s.state) >= plausibleMin
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
   * Media de la casa + habitación más caliente y más fría (para las alertas de
   * calor/frío y las de fresco/templado, que miran extremos distintos).
   *
   * @param {{ rooms: Array<{ name: string, temp: number }>, mean: number }} reading
   * @returns {{ mean: number, hottest: { name: string, temp: number }, coldest: { name: string, temp: number } }}
   */
  function evaluate(reading) {
    const { rooms, mean } = reading;
    const hottest = rooms.reduce((a, b) => (b.temp > a.temp ? b : a));
    const coldest = rooms.reduce((a, b) => (b.temp < a.temp ? b : a));
    return { mean, hottest, coldest };
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
   * Mensaje de Telegram para las cuatro direcciones: calor/frío (concern) y
   * fresco/templado (relief, avisos de "ha bajado/ha subido").
   *
   * @param {{ kind: 'calor'|'frio'|'fresco'|'templado', room: string, roomTemp: number, mean: number, sinceMs?: number }} ev
   * @param {{ rising?: boolean, outdoorTemp?: number|null, humidityMean?: number|null }} [opts]
   * @returns {string}
   */
  function buildAlertMessage(ev, { rising = false, outdoorTemp = null, humidityMean = null } = {}) {
    let head;
    if (ev.kind === 'calor') head = rising ? '🌡️ Sigue subiendo: más calor en casa' : '🌡️ Hace calor en casa';
    else if (ev.kind === 'frio') head = rising ? '🥶 Sigue bajando: más frío en casa' : '🥶 Hace frío en casa';
    else if (ev.kind === 'fresco') head = `😎 Ha bajado la temperatura en casa (${fmt1(ev.mean)}º)`;
    else head = `✅ Ha subido la temperatura en casa (${fmt1(ev.mean)}º)`; // templado
    const since = rising && ev.sinceMs ? ` (desde hace ${formatDuration(ev.sinceMs)})` : '';
    return `${head}${since}\nTemperatura ${ev.room}: ${fmt1(ev.roomTemp)}º | Temperatura media: ${fmt1(ev.mean)}º`
      + buildExtraLine({ outdoorTemp, humidityMean });
  }

  /**
   * Texto hablado para Alexa: sin emojis ni HTML, grados enteros, frase natural.
   *
   * @param {{ kind: 'calor'|'frio'|'fresco'|'templado', room: string, roomTemp: number, mean: number }} ev
   * @param {{ rising?: boolean }} [opts]
   * @returns {string}
   */
  function buildVoiceMessage(ev, { rising = false } = {}) {
    if (ev.kind === 'fresco') return `La temperatura ha bajado a ${Math.round(ev.mean)} grados en casa.`;
    if (ev.kind === 'templado') return `La temperatura ha subido a ${Math.round(ev.mean)} grados en casa.`;
    const cond = ev.kind === 'calor'
      ? (rising ? 'Sigue subiendo el calor en casa' : 'Atención, hace calor en casa')
      : (rising ? 'Sigue bajando la temperatura en casa' : 'Atención, hace frío en casa');
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

    const { mean, hottest, coldest } = evaluate(reading);
    const inQuiet = isInQuietWindow(nowFn(), quietWindow);
    // Contexto extra para los mensajes: exterior (si hay lectura) + humedad media.
    const ctx = { outdoorTemp: readOutdoorTemp(), humidityMean: readHumidityMean() };

    if (season === 'summer') {
      // CALOR (concern): media ≥ umbral o alguna habitación caliente.
      await handleDirection(
        'concern',
        { kind: 'calor', room: hottest.name, roomTemp: hottest.temp, mean },
        mean >= summerMeanThreshold || hottest.temp >= summerRoomThreshold,
        mean < summerMeanThreshold - hysteresis && hottest.temp < summerRoomThreshold - hysteresis,
        { worsen: true, inQuiet, ctx },
      );
      // FRESCO (relief): media ≤ umbral. INDEPENDIENTE de que hubiera calor antes.
      await handleDirection(
        'relief',
        { kind: 'fresco', room: coldest.name, roomTemp: coldest.temp, mean },
        mean <= summerRecoveryMean,
        mean > summerRecoveryMean + hysteresis,
        { inQuiet, ctx },
      );
    } else {
      // FRÍO (concern).
      await handleDirection(
        'concern',
        { kind: 'frio', room: coldest.name, roomTemp: coldest.temp, mean },
        mean <= winterMeanThreshold || coldest.temp <= winterRoomThreshold,
        mean > winterMeanThreshold + hysteresis && coldest.temp > winterRoomThreshold + hysteresis,
        { worsen: true, inQuiet, ctx },
      );
      // TEMPLADO (relief): media ≥ umbral. INDEPENDIENTE del frío.
      await handleDirection(
        'relief',
        { kind: 'templado', room: hottest.name, roomTemp: hottest.temp, mean },
        mean >= winterRecoveryMean,
        mean < winterRecoveryMean - hysteresis,
        { inQuiet, ctx },
      );
    }
  }

  /**
   * Gestiona UNA dirección de alerta (concern o relief) de forma independiente:
   * edge-trigger al cruzar el umbral, re-armado por histéresis, y —sólo si
   * `worsen`— re-aviso cuando empeora. Respeta la franja silenciosa.
   *
   * @param {'concern'|'relief'} dir
   * @param {{ kind: 'calor'|'frio'|'fresco'|'templado', room: string, roomTemp: number, mean: number }} ev
   * @param {boolean} on     ¿se cumple el umbral de disparo?
   * @param {boolean} rearm  ¿ha vuelto lo bastante (histéresis) para re-armar?
   * @param {{ worsen?: boolean, inQuiet: boolean, ctx: object }} opts
   */
  async function handleDirection(dir, ev, on, rearm, { worsen = false, inQuiet, ctx }) {
    const st = alerts[dir];
    const now = nowFn().getTime();
    const level = (ev.kind === 'fresco' || ev.kind === 'templado') ? 'success' : 'warn';

    if (!st.active) {
      if (!on) return;
      st.active = true; st.since = now; st.notifiedAt = 0; st.lastMean = null;
      if (inQuiet) {
        logger.info({ kind: ev.kind }, 'Temperature alert en franja silenciosa — suprimida');
        return;
      }
      logger.warn({ kind: ev.kind, room: ev.room, roomTemp: ev.roomTemp, mean: ev.mean }, 'Temperature alert');
      await notify(buildAlertMessage(ev, ctx), level);
      await announceVoice(ev);
      st.notifiedAt = now; st.lastMean = ev.mean;
      return;
    }

    // Activa: re-armar al volver la temperatura (histéresis) → un futuro cruce vuelve a avisar.
    if (rearm) {
      alerts[dir] = { active: false, since: 0, notifiedAt: 0, lastMean: null };
      return;
    }
    if (inQuiet) return;
    if (st.notifiedAt === 0) {
      // Se abrió durante la franja silenciosa; ahora fuera → primer aviso.
      await notify(buildAlertMessage(ev, ctx), level);
      await announceVoice(ev);
      st.notifiedAt = now; st.lastMean = ev.mean;
    } else if (worsen && isWorsening(ev, st, reAlertRiseDelta)) {
      // Re-aviso SÓLO si EMPEORA (calor sube / frío baja) ≥ delta sobre lo avisado.
      await notify(buildAlertMessage({ ...ev, sinceMs: now - st.since }, { rising: true, ...ctx }), 'warn');
      await announceVoice(ev, { rising: true });
      st.notifiedAt = now; st.lastMean = ev.mean;
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

  return {
    start,
    stop,
    checkOnce,
    getState: () => ({ concern: { ...alerts.concern }, relief: { ...alerts.relief } }),
  };
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
 * ¿La alerta ha EMPEORADO respecto al último valor avisado? Para calor, la media
 * sube ≥ delta; para frío, baja ≥ delta. Si aún no hay valor avisado, no.
 *
 * @param {{ kind: 'calor'|'frio', mean: number }} ev
 * @param {{ lastMean: number|null }} alert
 * @param {number} delta
 * @returns {boolean}
 */
function isWorsening(ev, alert, delta) {
  if (alert.lastMean == null) return false;
  return ev.kind === 'calor'
    ? ev.mean >= alert.lastMean + delta
    : ev.mean <= alert.lastMean - delta;
}

/**
 * @param {number} n
 * @returns {string}
 */
function fmt1(n) {
  return n.toFixed(1);
}

/**
 * @typedef {Object} DirState
 * @property {boolean} active
 * @property {number} since - epoch ms del inicio de la alerta actual
 * @property {number} notifiedAt - epoch ms del último aviso enviado (0 = no notificado)
 * @property {number|null} lastMean - media avisada en el último aviso (re-aviso solo si empeora este valor)
 */

/**
 * @typedef {Object} TemperatureWatcher
 * @property {() => void} start
 * @property {() => void} stop
 * @property {() => Promise<void>} checkOnce
 * @property {() => { concern: DirState, relief: DirState }} getState
 */
