/**
 * Guardián Tuya (LUI-TSK-0093).
 *
 * La integración Tuya de HA se degrada sola cada pocos días: los dispositivos
 * (persiana, válvulas de riego) dejan de reportar y de responder (HA acepta el
 * comando con 200 pero el estado no cambia y el last_updated se congela). Este
 * guardián vigila periódicamente el last_updated de los dispositivos Tuya y, si
 * alguno lleva mudo más de `staleHours`, RECARGA la integración
 * (homeassistant.reload_config_entry). Rate-limit para no entrar en bucle de
 * recargas. NO avisa por Telegram (LUI-TSK-0094): las caídas se resumen en el
 * parte diario de salud para no despertar al usuario de madrugada.
 */

/**
 * Dispositivos Tuya cuyo last_updated lleva mudo más de `staleHours` (pura).
 *
 * @param {Array<object>|null} states
 * @param {string[]} watchedEntities
 * @param {number} staleHours
 * @param {number} nowMs
 * @returns {Array<{ id: string, hours: number }>}
 */
export function findStaleTuya(states, watchedEntities, staleHours, nowMs) {
  const stale = [];
  for (const id of watchedEntities) {
    const s = states?.find((x) => x.entity_id === id);
    if (!s) continue;
    const hours = (nowMs - new Date(s.last_updated).getTime()) / 3_600_000;
    if (!Number.isFinite(hours) || hours > staleHours) {
      stale.push({ id, hours: Number.isFinite(hours) ? Math.round(hours) : Infinity });
    }
  }
  return stale;
}

/**
 * @param {{
 *   logger?: import('pino').Logger,
 *   scheduler: import('../../infrastructure/scheduler/scheduler.js').Scheduler,
 *   fetchStates: () => Promise<Array<object>>,
 *   reloadTuya: () => Promise<unknown>,
 *   watchedEntities?: string[],
 *   staleHours?: number,
 *   checkIntervalMs?: number,
 *   minReloadGapMs?: number,
 *   nowFn?: () => Date,
 * }} deps
 */
export function createTuyaGuardian({
  logger,
  scheduler,
  fetchStates,
  reloadTuya,
  watchedEntities = [],
  staleHours = 8,
  checkIntervalMs = 4 * 60 * 60 * 1000,
  minReloadGapMs = 2 * 60 * 60 * 1000,
  nowFn = () => new Date(),
}) {
  if (typeof fetchStates !== 'function') throw new Error('createTuyaGuardian requires fetchStates');
  if (typeof reloadTuya !== 'function') throw new Error('createTuyaGuardian requires reloadTuya');

  let job = null;
  let lastReloadMs = 0;

  async function checkOnce() {
    let states;
    try {
      states = await fetchStates();
    } catch (error) {
      logger?.warn({ err: error?.message }, 'Tuya guardian: no se pudo leer Home Assistant');
      return;
    }
    const now = nowFn().getTime();
    const stale = findStaleTuya(states, watchedEntities, staleHours, now);
    if (stale.length === 0) return;

    if (now - lastReloadMs < minReloadGapMs) {
      logger?.info({ stale }, 'Tuya guardian: dispositivos mudos pero dentro del rate-limit, no recargo');
      return;
    }

    logger?.warn({ stale }, 'Tuya guardian: dispositivos Tuya mudos, recargando integración');
    try {
      await reloadTuya();
      lastReloadMs = now;
      // No se notifica por Telegram (LUI-TSK-0094): el aviso individual llegaba de
      // madrugada. El nº de caídas de Tuya se consolida en el parte diario de salud.
      logger?.info({ stale }, 'Tuya guardian: integración recargada (sin aviso; se resume en el parte diario)');
    } catch (error) {
      logger?.error({ err: error?.message }, 'Tuya guardian: reload_config_entry falló');
    }
  }

  return {
    checkOnce,
    start() {
      if (job) return;
      job = scheduler.schedule(checkOnce, checkIntervalMs, 'tuya-guardian');
      logger?.info({ staleHours, checkIntervalMs, watched: watchedEntities.length }, 'Tuya guardian started');
    },
    stop() {
      job?.stop();
      job = null;
    },
  };
}
