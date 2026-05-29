/**
 * Formats a Prometheus {@link import('./prometheus-client.js').DownReport}
 * into a human answer.
 *
 * Returns both a plain-text variant (web / CLI) and an HTML variant
 * (Telegram `parse_mode: 'HTML'`), so the same report works on every channel.
 *
 * @param {import('./prometheus-client.js').DownReport} report
 * @param {{ now?: number }} [options] - `now` is injectable for deterministic tests
 * @returns {{ text: string, html: string }}
 */
export function formatDownReport(report, { now = Date.now() } = {}) {
  if (!report.anythingDown) {
    const detail =
      `${report.totalTargets} targets y ${report.totalProbes} servicios HTTP monitorizados: ` +
      'ninguno caído y sin alertas activas.';
    return {
      text: `✅ Todo en orden. ${detail}`,
      html: `✅ <b>Todo en orden</b>\n${escapeHtml(detail)}`,
    };
  }

  const textLines = ['⚠️ Hay cosas caídas:'];
  const htmlLines = ['⚠️ <b>Hay cosas caídas</b>'];

  /**
   * Appends a titled section to both the text and HTML outputs.
   *
   * @param {string} title
   * @param {string[]} items
   */
  const addSection = (title, items) => {
    if (items.length === 0) return;
    textLines.push('', `${title}:`);
    htmlLines.push('', `<b>${escapeHtml(title)}:</b>`);
    for (const item of items) {
      textLines.push(`  • ${item}`);
      htmlLines.push(`  • ${escapeHtml(item)}`);
    }
  };

  addSection(
    'Targets caídos',
    report.downTargets.map((target) => `${target.job} (${target.instance})`),
  );
  addSection(
    'Servicios HTTP caídos',
    report.downProbes.map((probe) => `${probe.job} (${probe.instance})`),
  );
  addSection(
    'Alertas activas',
    report.firingAlerts.map((alert) => {
      const severity = alert.severity ? ` [${alert.severity}]` : '';
      const cleanSummary = stripDurationMarkers(alert.summary);
      const summary = cleanSummary ? ` — ${cleanSummary}` : '';
      const duration = formatActiveDuration(alert.activeAt, now);
      const tail = duration ? ` (lleva ${duration})` : '';
      return `${alert.name}${severity}${summary}${tail}`;
    }),
  );

  return { text: textLines.join('\n'), html: htmlLines.join('\n') };
}

/**
 * Removes static "for"-style duration markers that Prometheus rule templates
 * usually hard-code in their summary (e.g. ">2m", "> 5 min", ">10m"). Those
 * markers come from the alert's `for:` clause and stay constant forever, so
 * keeping them next to the real elapsed duration would be contradictory.
 *
 * @param {string|null|undefined} summary
 * @returns {string}
 */
function stripDurationMarkers(summary) {
  if (!summary) return '';
  return summary
    .replace(/\s*>\s*\d+\s*(?:m|min|minutos?|h|hora?s?|s|seg|segundos?|d|d[ií]as?)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Computes a humanised elapsed duration from `activeAt` to `now`.
 * Returns `''` when `activeAt` is missing or unparseable so the caller can
 * skip the "(lleva ...)" suffix entirely.
 *
 * @param {string|null|undefined} activeAt - ISO timestamp from Prometheus
 * @param {number} now - epoch ms (injected so tests are deterministic)
 * @returns {string}
 */
function formatActiveDuration(activeAt, now) {
  if (!activeAt) return '';
  const startedAt = Date.parse(activeAt);
  if (!Number.isFinite(startedAt)) return '';
  const elapsedMs = now - startedAt;
  if (elapsedMs < 0) return '';
  return formatHumanDuration(elapsedMs);
}

/**
 * Formats a positive millisecond duration as a short two-unit string:
 *   < 1 min          → "<1m"
 *   < 1 hour         → "Nm"
 *   < 1 day          → "Hh Mm"  (M omitted when 0)
 *   ≥ 1 day          → "Dd Hh"  (H omitted when 0)
 *
 * @param {number} ms
 * @returns {string}
 */
function formatHumanDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 1) return '<1m';
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 1) return `${totalMin}m`;
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays < 1) {
    const minutes = totalMin - totalHours * 60;
    return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  }
  const hours = totalHours - totalDays * 24;
  return hours > 0 ? `${totalDays}d ${hours}h` : `${totalDays}d`;
}

/**
 * Escapes a string for safe inclusion inside Telegram's HTML parse mode.
 *
 * @param {string} input
 * @returns {string}
 */
function escapeHtml(input) {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
