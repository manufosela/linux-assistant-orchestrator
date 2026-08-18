/**
 * Parte diario de salud (LUI-TSK-0092).
 *
 * Sustituye el "todo correcto" ciego del cron persiana-check-matinal.sh por una
 * comprobación REAL que lista con ✅/⚠️: HA responde, watchers de LUIS activos,
 * persianas de verano, RIEGO (detecta válvula muerta comparando el last_changed
 * del switch contra un umbral de horas) y temperatura interior/exterior.
 *
 * Mensajes en español, claros (norma del proyecto). Se envía una vez al día a la
 * hora configurada; el tick de 60s se auto-limita con la fecha del último envío.
 */

const WATCHER_LABELS = {
  temperature: 'temperatura',
  dishwasher: 'lavavajillas',
  battery: 'batería',
  weather: 'tiempo',
  cluster: 'clúster',
  prometheus: 'prometheus',
};
const REPORTED_WATCHERS = Object.keys(WATCHER_LABELS);

const isNum = (s) => s != null && s !== 'unknown' && s !== 'unavailable' && Number.isFinite(Number(s));

/**
 * Construye el parte a partir de los datos (función pura, testeable).
 *
 * @param {{
 *   states: Array<object>|null,
 *   capabilities?: Array<{ name: string, status: string }>,
 *   config?: object,
 *   now?: Date,
 * }} input
 * @returns {{ message: string, hasWarning: boolean }}
 */
export function collectHealth({ states, capabilities = [], config = {}, now = new Date(), tuyaOutages24h = null, downloadReports = [] }) {
  const {
    coverEntity = 'cover.persiana_salon_cortina',
    persianaPrefix = 'automation.persiana_verano_',
    riegoValves = [],
    riegoStaleHours = 36,
    coverStaleHours = 12,
    outdoorEntity = '',
    excludeRe = /exterior|outdoor|fuera|terraza|jard|calle|balc|nevera|frigo|congelador|fridge|freezer|cpu|bater|battery|coche|\bext\b/i,
    plausibleMin = 5,
  } = config;

  const dateStr = now.toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Madrid',
  });
  const lines = [`🌅 Parte diario — ${dateStr}`];

  if (!states || states.length === 0) {
    lines.push('⚠️ Home Assistant NO responde — no puedo comprobar la casa. Conviene revisarlo.');
    return { message: lines.join('\n'), hasWarning: true };
  }
  lines.push('✅ Home Assistant: OK');

  let hasWarning = false;
  const byId = new Map(states.map((s) => [s.entity_id, s]));

  // Watchers de LUIS habilitados.
  const enabled = capabilities.filter((c) => c.status === 'enabled' && REPORTED_WATCHERS.includes(c.name));
  if (enabled.length > 0) {
    lines.push(`✅ Watchers: ${enabled.map((c) => WATCHER_LABELS[c.name]).join(' · ')}`);
  }

  // Persianas de verano.
  const pers = states.filter((s) => s.entity_id.startsWith(persianaPrefix));
  if (pers.length > 0) {
    const on = pers.filter((s) => s.state === 'on').length;
    const cov = coverEntity ? byId.get(coverEntity) : null;
    const pos = cov?.attributes?.current_position;
    const fisico = pos != null ? `${100 - pos}%` : '?';
    const allOn = on === pers.length;
    if (!allOn) hasWarning = true;
    lines.push(`${allOn ? '✅' : '⚠️'} Persianas verano: ${on}/${pers.length} activas · salón al ${fisico}`);
    // Frescura del cover: si Tuya se cuelga, el last_updated deja de refrescarse.
    if (cov) {
      const hours = (now.getTime() - new Date(cov.last_updated).getTime()) / 3_600_000;
      if (!Number.isFinite(hours) || hours > coverStaleHours) {
        lines.push(`⚠️ Persiana: sin actualizar desde hace ${Math.round(hours)} h (¿integración Tuya congelada?).`);
        hasWarning = true;
      }
    }
  }

  // Estabilidad de Tuya en las últimas 24h (LUI-TSK-0094): se resume aquí en vez
  // de avisar de cada recarga por Telegram (que llegaba de madrugada).
  if (tuyaOutages24h != null) {
    if (tuyaOutages24h === 0) {
      lines.push('✅ Tuya: estable (0 caídas en 24h)');
    } else {
      const veces = tuyaOutages24h === 1 ? 'vez' : 'veces';
      lines.push(`🔧 Tuya: se cayó y se recuperó ${tuyaOutages24h} ${veces} en 24h (recuperación automática).`);
    }
  }

  // Riego: detecta válvula que no actúa (last_changed viejo).
  for (const v of riegoValves) {
    const sw = byId.get(v.entity);
    if (!sw) {
      lines.push(`⚠️ Riego ${v.label}: no encuentro el interruptor de la válvula.`);
      hasWarning = true;
      continue;
    }
    const ms = now.getTime() - new Date(sw.last_changed).getTime();
    const hours = ms / 3_600_000;
    if (!Number.isFinite(hours) || hours > riegoStaleHours) {
      lines.push(`⚠️ Riego ${v.label}: la válvula no se activa desde hace ${Math.round(hours)} h (¿dispositivo KO?).`);
      hasWarning = true;
    } else {
      lines.push(`✅ Riego ${v.label}: válvula OK (última activación hace ${Math.round(hours)} h).`);
    }
  }

  // Temperatura interior media (con suelo de cordura) + exterior.
  const indoor = states.filter((s) =>
    s.attributes?.device_class === 'temperature'
    && s.entity_id !== outdoorEntity
    && isNum(s.state)
    && Number(s.state) >= plausibleMin
    && !excludeRe.test(`${s.entity_id} ${s.attributes?.friendly_name ?? ''}`));
  if (indoor.length > 0) {
    const mean = indoor.reduce((a, s) => a + Number(s.state), 0) / indoor.length;
    const out = outdoorEntity ? byId.get(outdoorEntity) : null;
    const outStr = out && isNum(out.state) ? ` (exterior ${Math.round(Number(out.state))}°)` : '';
    lines.push(`✅ Temperatura: ${mean.toFixed(1)}° de media${outStr}`);
  }

  // Descargas movidas al NAS en las últimas 24h (LUI-TSK-0095): desglose completo
  // tal cual llega de move-tg-to-nas, en vez de avisar de madrugada.
  if (Array.isArray(downloadReports) && downloadReports.length > 0) {
    lines.push('📥 Descargas al NAS (24h):');
    for (const report of downloadReports) lines.push(report);
  }

  return { message: lines.join('\n'), hasWarning };
}

/**
 * @param {{
 *   logger?: import('pino').Logger,
 *   scheduler: import('../../infrastructure/scheduler/scheduler.js').Scheduler,
 *   notificationService: import('../notifications/notification-service.js').NotificationService,
 *   fetchStates: () => Promise<Array<object>>,
 *   fetchTuyaOutages?: () => Promise<number|null>,
 *   fetchDownloadReports?: () => Promise<string[]>,
 *   capabilities?: Array<{ name: string, status: string }>,
 *   config?: object,
 *   reportHour?: number,
 *   reportMinute?: number,
 *   nowFn?: () => Date,
 * }} deps
 */
export function createDailyHealthReport({
  logger,
  scheduler,
  notificationService,
  fetchStates,
  fetchTuyaOutages,
  fetchDownloadReports,
  capabilities = [],
  config = {},
  reportHour = 7,
  reportMinute = 30,
  nowFn = () => new Date(),
}) {
  if (typeof fetchStates !== 'function') throw new Error('createDailyHealthReport requires fetchStates');
  let job = null;
  let lastRunDay = null;

  async function run() {
    let states = null;
    try {
      states = await fetchStates();
    } catch (error) {
      logger?.warn({ err: error?.message }, 'Daily health report: no se pudo leer Home Assistant');
      states = null; // collectHealth lo reporta como HA no responde
    }
    let tuyaOutages24h = null;
    if (typeof fetchTuyaOutages === 'function') {
      try {
        tuyaOutages24h = await fetchTuyaOutages();
      } catch (error) {
        logger?.warn({ err: error?.message }, 'Daily health report: no se pudo contar las caídas de Tuya');
      }
    }
    let downloadReports = [];
    if (typeof fetchDownloadReports === 'function') {
      try {
        downloadReports = await fetchDownloadReports();
      } catch (error) {
        logger?.warn({ err: error?.message }, 'Daily health report: no se pudieron leer los reports de descargas');
      }
    }
    const { message, hasWarning } = collectHealth({ states, capabilities, config, now: nowFn(), tuyaOutages24h, downloadReports });
    try {
      await notificationService.sendNotification({ text: message, level: hasWarning ? 'warn' : 'info' });
    } catch (error) {
      logger?.error({ err: error?.message }, 'Daily health report notification failed');
    }
    logger?.info({ hasWarning }, 'Daily health report sent');
  }

  function tick() {
    const now = nowFn();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() === reportHour && now.getMinutes() >= reportMinute && lastRunDay !== day) {
      lastRunDay = day;
      run().catch((error) => logger?.error({ err: error?.message }, 'Daily health report run failed'));
    }
  }

  return {
    run,
    start() {
      if (job) return;
      job = scheduler.schedule(tick, 60 * 1000, 'daily-health-report');
      logger?.info({ reportHour, reportMinute }, 'Daily health report scheduled');
    },
    stop() {
      job?.stop();
      job = null;
    },
  };
}
