/**
 * Formatea el payload de un webhook de Prometheus Alertmanager en un mensaje
 * de Telegram claro y en español (LUI-TSK-0073).
 *
 * Alertmanager envía (v4):
 *   {
 *     status: 'firing' | 'resolved',
 *     alerts: [{
 *       status: 'firing'|'resolved',
 *       labels: { alertname, severity, instance, job, ... },
 *       annotations: { summary, description },
 *       startsAt, endsAt
 *     }],
 *     commonLabels, commonAnnotations, ...
 *   }
 *
 * Defensivo: cualquier cosa que no reconozca se muestra sin romper, para no
 * perder un aviso.
 *
 * @param {unknown} payload
 * @returns {{ text: string, level: 'info'|'warn'|'error'|'success' }}
 */
export function formatAlertmanagerNotification(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const alerts = Array.isArray(data.alerts) ? data.alerts : [];

  if (alerts.length === 0) {
    return { text: '🔔 <b>Alerta</b>\nSin detalles en el payload.', level: 'info' };
  }

  const firing = alerts.filter((a) => a?.status === 'firing');
  const resolved = alerts.filter((a) => a?.status === 'resolved');
  // Si ningún alert trae status individual, usamos el status global.
  const bucket = firing.length === 0 && resolved.length === 0
    ? (data.status === 'resolved' ? { firing: [], resolved: alerts } : { firing: alerts, resolved: [] })
    : { firing, resolved };

  const lines = [];
  if (bucket.firing.length > 0) {
    lines.push(`⚠️ <b>${bucket.firing.length} alerta${bucket.firing.length > 1 ? 's' : ''} activa${bucket.firing.length > 1 ? 's' : ''}</b>`);
    for (const a of bucket.firing) lines.push('• ' + escapeHtml(describeAlert(a)));
  }
  if (bucket.resolved.length > 0) {
    lines.push(`✅ <b>${bucket.resolved.length} recuperada${bucket.resolved.length > 1 ? 's' : ''}</b>`);
    for (const a of bucket.resolved) lines.push('• ' + escapeHtml(describeAlert(a)));
  }

  const hasCritical = bucket.firing.some((a) => severityOf(a) === 'critical');
  const level = bucket.firing.length === 0
    ? 'success'
    : (hasCritical ? 'error' : 'warn');

  return { text: lines.join('\n'), level };
}

/**
 * @param {any} a
 * @returns {string}
 */
function describeAlert(a) {
  const labels = a?.labels ?? {};
  const ann = a?.annotations ?? {};
  const name = oneLine(labels.alertname) || 'alerta';
  const sev = severityOf(a);
  const sevTxt = sev ? ` (${translateSeverity(sev)})` : '';
  const where = oneLine(labels.instance) || oneLine(labels.job) || oneLine(labels.nodename);
  const whereTxt = where ? ` [${where}]` : '';
  const detail = oneLine(ann.summary) || oneLine(ann.description);
  const detailTxt = detail ? `: ${detail}` : '';
  return `${name}${sevTxt}${whereTxt}${detailTxt}`;
}

/**
 * @param {any} a
 * @returns {string}
 */
function severityOf(a) {
  return String(a?.labels?.severity ?? '').toLowerCase();
}

/**
 * @param {string} sev
 * @returns {string}
 */
function translateSeverity(sev) {
  switch (sev) {
    case 'critical': return 'crítico';
    case 'warning': return 'aviso';
    case 'info': return 'info';
    default: return sev;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function oneLine(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} input
 * @returns {string}
 */
function escapeHtml(input) {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
