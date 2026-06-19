/**
 * Creates the cluster watcher.
 *
 * Behaviour:
 *  - Every `checkIntervalMs` it probes every target.
 *  - A healthy → failing transition does NOT notify immediately: the service is
 *    marked `pending` and a single retry is scheduled `retryDelayMs` later.
 *  - If the retry still fails → state `down`, Telegram notification + incident.
 *  - If the retry succeeds → back to `up` silently (transient blip, no spam).
 *  - A `down` service that answers again → state `up`, recovery notification.
 *  - A `down` service that keeps failing → nothing (no 60s spam), debug only.
 *
 * Follows the project factory pattern: createClusterWatcher({ logger, ...deps }).
 *
 * @param {{
 *   logger: import('pino').Logger,
 *   scheduler: import('../../infrastructure/scheduler/scheduler.js').Scheduler,
 *   notificationService: import('../notifications/notification-service.js').NotificationService,
 *   healthChecker: import('./cluster-health-checker.js').ClusterHealthChecker,
 *   targets: import('./cluster-targets.js').ClusterTarget[],
 *   historyStore: import('./cluster-history-store.js').ClusterHistoryStore,
 *   checkIntervalMs?: number,
 *   retryDelayMs?: number,
 * }} deps
 * @returns {ClusterWatcher}
 */
export function createClusterWatcher({
  logger,
  scheduler,
  notificationService,
  healthChecker,
  targets,
  historyStore,
  checkIntervalMs = 60_000,
  retryDelayMs = 30_000,
  quietWindowStart = '',
  quietWindowEnd = '',
  nowFn = () => new Date(),
}) {
  /** @type {Map<string, ServiceState>} */
  const states = new Map(
    targets.map((target) => [target.id, {
      state: 'up',
      since: Date.now(),
      lastChecked: null,
      lastDetail: null,
      notifiedDown: false,
    }]),
  );

  const quietWindow = parseQuietWindow(quietWindowStart, quietWindowEnd);
  if (quietWindow) {
    logger.info(
      { start: quietWindowStart, end: quietWindowEnd },
      'Cluster quiet window habilitada: avisos suprimidos en franja nocturna',
    );
  }

  /** @type {{ stop: () => void } | null} */
  let job = null;

  /** @param {import('./cluster-targets.js').ClusterTarget} target */
  const label = (target) => `${target.service} en ${target.node}`;
  /** @param {import('./cluster-targets.js').ClusterTarget} target */
  const addr = (target) => `${target.host}:${target.port}`;

  /**
   * @param {string} text
   * @param {'warn'|'success'} level
   */
  async function notify(text, level) {
    try {
      await notificationService.sendNotification({ text, level });
    } catch (error) {
      logger.error({ err: error?.message }, 'Cluster notification failed to dispatch');
    }
  }

  /**
   * @param {'down'|'recovered'} type
   * @param {import('./cluster-targets.js').ClusterTarget} target
   * @param {string|null} [detail]
   */
  async function recordIncident(type, target, detail = null) {
    await historyStore.append({
      timestamp: new Date().toISOString(),
      node: target.node,
      service: target.service,
      address: addr(target),
      type,
      detail,
    });
  }

  /**
   * Regular tick evaluation for one target.
   *
   * @param {import('./cluster-targets.js').ClusterTarget} target
   */
  async function evaluate(target) {
    const st = states.get(target.id);

    // A pending service is owned by its scheduled retry — don't double-probe it.
    if (st.state === 'pending') return;

    const { ok, detail } = await healthChecker.check(target);
    st.lastChecked = Date.now();

    if (st.state === 'up') {
      if (ok) {
        logger.debug({ target: target.id }, 'Cluster service OK');
        return;
      }
      st.state = 'pending';
      st.lastDetail = detail ?? null;
      logger.warn(
        { target: target.id, detail },
        `Cluster ${label(target)} no responde — reintentando en ${retryDelayMs / 1000}s`,
      );
      scheduler.delay(() => retry(target), retryDelayMs);
      return;
    }

    // st.state === 'down'
    if (ok) {
      st.state = 'up';
      st.since = Date.now();
      st.lastDetail = null;
      const wasNotified = st.notifiedDown;
      st.notifiedDown = false;
      // Sólo notificamos recovered si el DOWN se notificó en su momento.
      // Si fue silenciado por quiet hours (blip nocturno), también suprimimos
      // el recovered — el usuario no se enteró del down, no necesita el up.
      if (wasNotified) {
        logger.warn({ target: target.id }, `Cluster ${label(target)} recuperado`);
        await recordIncident('recovered', target);
        await notify(`✅ CLUSTER: ${label(target)} recuperado`, 'success');
      } else {
        logger.info({ target: target.id }, `Cluster ${label(target)} recuperado (down suprimido, sin notif)`);
      }
    } else if (!st.notifiedDown && !isInQuietWindow(nowFn(), quietWindow)) {
      // Servicio sigue down, no notificamos antes (suprimido por quiet hours)
      // y AHORA ya estamos fuera de la franja → notificar ahora.
      logger.warn({ target: target.id, detail }, `Cluster ${label(target)} sigue caído tras quiet hours — notificando`);
      await recordIncident('down', target, detail ?? null);
      await notify(`⚠️ CLUSTER: ${label(target)} no responde (${addr(target)})`, 'warn');
      st.notifiedDown = true;
    } else {
      logger.debug({ target: target.id, detail }, 'Cluster service still down (no notification — anti-spam)');
    }
  }

  /**
   * The one-shot retry scheduled after the first failure.
   *
   * @param {import('./cluster-targets.js').ClusterTarget} target
   */
  async function retry(target) {
    const st = states.get(target.id);
    if (st.state !== 'pending') return;

    const { ok, detail } = await healthChecker.check(target);
    st.lastChecked = Date.now();

    if (ok) {
      st.state = 'up';
      st.since = Date.now();
      st.lastDetail = null;
      logger.debug({ target: target.id }, 'Cluster service recovered on retry (transient — no notification)');
      return;
    }

    st.state = 'down';
    st.since = Date.now();
    st.lastDetail = detail ?? null;

    // Quiet hours: suprimir la notificación pero seguir marcando state=down.
    // El siguiente tick (cuando salgamos de la franja) ya lo notificará si
    // el servicio sigue down.
    if (isInQuietWindow(nowFn(), quietWindow)) {
      st.notifiedDown = false;
      logger.info(
        { target: target.id, detail },
        `Cluster ${label(target)} caído durante quiet hours — notificación suprimida`,
      );
      return;
    }

    logger.warn({ target: target.id, detail }, `Cluster ${label(target)} no responde tras reintento`);
    await recordIncident('down', target, detail ?? null);
    await notify(`⚠️ CLUSTER: ${label(target)} no responde (${addr(target)})`, 'warn');
    st.notifiedDown = true;
  }

  /**
   * Probes every target once. Failures in one target never block the others.
   */
  async function checkAll() {
    await Promise.allSettled(targets.map((target) => evaluate(target)));
  }

  /**
   * Starts the periodic check. Idempotent.
   */
  function start() {
    if (job) return;
    job = scheduler.schedule(checkAll, checkIntervalMs, 'cluster-watcher');
    logger.info(
      { targets: targets.length, intervalMs: checkIntervalMs },
      'Cluster watcher started',
    );
  }

  /**
   * Stops the periodic check.
   */
  function stop() {
    job?.stop();
    job = null;
  }

  /**
   * Current in-memory state of every target (used by the daemon-side callers).
   *
   * @returns {ClusterStatusEntry[]}
   */
  function getStatus() {
    return targets.map((target) => {
      const st = states.get(target.id);
      return {
        node: target.node,
        service: target.service,
        address: addr(target),
        state: st.state,
        since: st.since,
        lastChecked: st.lastChecked,
        detail: st.lastDetail,
      };
    });
  }

  /**
   * @returns {Promise<import('./cluster-history-store.js').ClusterIncident[]>}
   */
  async function getHistory() {
    return historyStore.read();
  }

  return { start, stop, checkAll, getStatus, getHistory };
}

/**
 * Parsea una franja silenciosa de formato HH:MM-HH:MM. Devuelve null si
 * cualquiera de los dos está vacío o mal formado. Se permite franja que
 * cruza medianoche (start > end), p.ej. 23:00-08:00.
 *
 * @param {string} startRaw
 * @param {string} endRaw
 * @returns {{ startMin: number, endMin: number } | null}
 */
function parseQuietWindow(startRaw, endRaw) {
  const start = parseHHMM(startRaw);
  const end = parseHHMM(endRaw);
  if (start === null || end === null) return null;
  if (start === end) return null; // ventana vacía = desactivada
  return { startMin: start, endMin: end };
}

function parseHHMM(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * @param {Date} now
 * @param {{ startMin: number, endMin: number } | null} window
 * @returns {boolean}
 */
export function isInQuietWindow(now, window) {
  if (!window) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const { startMin, endMin } = window;
  if (startMin < endMin) {
    // Mismo día (ej 02:00-08:00)
    return nowMin >= startMin && nowMin < endMin;
  }
  // Cruza medianoche (ej 23:00-08:00)
  return nowMin >= startMin || nowMin < endMin;
}

/**
 * @typedef {Object} ServiceState
 * @property {'up'|'pending'|'down'} state
 * @property {number} since - epoch ms of the last state change
 * @property {number|null} lastChecked - epoch ms of the last probe
 * @property {string|null} lastDetail
 * @property {boolean} notifiedDown - si se envió la notificación del down actual
 */

/**
 * @typedef {Object} ClusterStatusEntry
 * @property {string} node
 * @property {string} service
 * @property {string} address
 * @property {'up'|'pending'|'down'} state
 * @property {number} since
 * @property {number|null} lastChecked
 * @property {string|null} detail
 */

/**
 * @typedef {Object} ClusterWatcher
 * @property {() => void} start
 * @property {() => void} stop
 * @property {() => Promise<void>} checkAll
 * @property {() => ClusterStatusEntry[]} getStatus
 * @property {() => Promise<import('./cluster-history-store.js').ClusterIncident[]>} getHistory
 */
