/**
 * Guardián Tuya (LUI-TSK-0093).
 *
 * La integración Tuya de HA se degrada sola cada pocos días: los dispositivos
 * (persiana, válvulas de riego) dejan de reportar y de responder (HA acepta el
 * comando con 200 pero el estado no cambia y el last_updated se congela). Este
 * guardián vigila periódicamente el last_updated de los dispositivos Tuya y, si
 * alguno lleva mudo más de `staleHours`, RECARGA la integración
 * (homeassistant.reload_config_entry) y avisa por Telegram. Rate-limit para no
 * entrar en bucle de recargas.
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
 *   notificationService: import('../notifications/notification-service.js').NotificationService,
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
  notificationService,
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
      const worst = Math.max(...stale.map((s) => (Number.isFinite(s.hours) ? s.hours : 0)));
      await notificationService.sendNotification({
        text: `🔧 La integración Tuya se había colgado (${stale.map((s) => s.id).join(', ')} sin responder ~${worst} h). He recargado Tuya automáticamente; la persiana y el riego deberían volver.`,
        level: 'warn',
      });
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
