/**
 * Formats a Prometheus {@link import('./prometheus-client.js').DownReport}
 * into a human answer.
 *
 * Returns both a plain-text variant (web / CLI) and an HTML variant
 * (Telegram `parse_mode: 'HTML'`), so the same report works on every channel.
 *
 * @param {import('./prometheus-client.js').DownReport} report
 * @returns {{ text: string, html: string }}
 */
export function formatDownReport(report) {
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
      const summary = alert.summary ? ` — ${alert.summary}` : '';
      return `${alert.name}${severity}${summary}`;
    }),
  );

  return { text: textLines.join('\n'), html: htmlLines.join('\n') };
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
