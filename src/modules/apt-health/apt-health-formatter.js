/**
 * Formats an apt-health event into a Telegram-ready notification.
 *
 * Eventos soportados:
 *   - upgrade-failed   → unattended-upgrade terminó con error (dpkg roto,
 *                        post-install fallido, etc.).
 *   - pending-old      → hay paquetes pendientes de aplicar desde hace
 *                        más de N días (early warning).
 *   - reboot-pending   → /var/run/reboot-required existe desde hace más
 *                        de 7 días.
 *
 * Sigue el mismo contrato que watchtower-formatter: { text, level }, HTML
 * parse mode, defensivo ante payload desconocido (jamás silenciado).
 *
 * @param {unknown} payload
 * @returns {{ text: string, level: 'info' | 'warn' | 'success' }}
 */
export function formatAptHealthNotification(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const host = typeof data.host === 'string' && data.host ? data.host : 'desconocido';
  const event = typeof data.event === 'string' ? data.event : 'unknown';
  const detail = typeof data.detail === 'string' ? data.detail.trim() : '';

  switch (event) {
    case 'upgrade-failed':
      return {
        text:
          `⚠️ <b>APT</b> · ${escapeHtml(host)}: unattended-upgrade falló\n` +
          (detail ? `<pre>${escapeHtml(truncate(detail, 600))}</pre>` : ''),
        level: 'warn',
      };
    case 'pending-old': {
      const { count, days } = parsePendingOld(data);
      return {
        text:
          `⚠️ <b>APT</b> · ${escapeHtml(host)}: ${count} paquete${count === 1 ? '' : 's'} pendiente${count === 1 ? '' : 's'} ` +
          `desde hace ${days} día${days === 1 ? '' : 's'}` +
          (detail ? `\n<pre>${escapeHtml(truncate(detail, 600))}</pre>` : ''),
        level: 'warn',
      };
    }
    case 'reboot-pending': {
      const days = Number.isFinite(data.days) ? Math.floor(data.days) : null;
      const daysPart = days !== null ? ` desde hace ${days} día${days === 1 ? '' : 's'}` : '';
      return {
        text:
          `⚠️ <b>APT</b> · ${escapeHtml(host)}: reboot pendiente${daysPart}` +
          (detail ? `\n<pre>${escapeHtml(truncate(detail, 600))}</pre>` : ''),
        level: 'warn',
      };
    }
    default:
      return {
        text:
          `⚠️ <b>APT</b> · ${escapeHtml(host)}: evento desconocido <code>${escapeHtml(event)}</code>` +
          (detail ? `\n<pre>${escapeHtml(truncate(detail, 600))}</pre>` : ''),
        level: 'warn',
      };
  }
}

/**
 * @param {{ count?: unknown, days?: unknown }} data
 */
function parsePendingOld(data) {
  const count = Number.isFinite(data.count) && data.count >= 0 ? Math.floor(data.count) : 0;
  const days = Number.isFinite(data.days) && data.days >= 0 ? Math.floor(data.days) : 0;
  return { count, days };
}

/**
 * @param {string} input
 * @returns {string}
 */
function escapeHtml(input) {
  return String(input).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {string} input
 * @param {number} max
 * @returns {string}
 */
function truncate(input, max) {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}
