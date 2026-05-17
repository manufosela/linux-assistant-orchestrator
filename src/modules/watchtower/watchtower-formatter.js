/**
 * Formats a Watchtower webhook payload into a Telegram-ready message that
 * matches the look of `/cluster` (header + monospaced `<pre>` block).
 *
 * Watchtower can post either:
 *  - a structured JSON object `{ host?, updated?:[], failed?:[], scanned? }`
 *    (recommended — see DEPLOYMENT.md for the template), or
 *  - shoutrrr's default `{ "message": "<rendered text>" }`, or
 *  - a raw string.
 *
 * The function is defensive: anything it does not recognise is shown verbatim
 * inside the `<pre>` block so a notification is never silently dropped.
 *
 * @param {unknown} payload
 * @returns {{ text: string, level: 'info' | 'warn' | 'success' }}
 */
export function formatWatchtowerNotification(payload) {
  const data = typeof payload === 'string' ? { message: payload } : (payload ?? {});
  const host = typeof data.host === 'string' && data.host ? data.host : undefined;
  const header = `🐳 <b>Watchtower${host ? ` · ${escapeHtml(host)}` : ''}</b>`;

  const updated = Array.isArray(data.updated) ? data.updated : [];
  const failed = Array.isArray(data.failed) ? data.failed : [];

  // Structured report → render the table.
  if (updated.length > 0 || failed.length > 0) {
    const lines = [];
    for (const entry of updated) {
      lines.push(
        `✅ ${oneLine(entry?.name)}  ${oneLine(entry?.image)}  ${oneLine(entry?.old)} → ${oneLine(entry?.new)}`,
      );
    }
    for (const entry of failed) {
      lines.push(`⚠️ ${oneLine(entry?.name)}  ${oneLine(entry?.image)}  ERROR: ${oneLine(entry?.error)}`);
    }
    if (Number.isFinite(data.scanned)) {
      lines.push(`— ${data.scanned} contenedores revisados`);
    }
    return {
      text: `${header}\n<pre>${escapeHtml(lines.join('\n'))}</pre>`,
      level: failed.length > 0 ? 'warn' : 'success',
    };
  }

  // Plain message (shoutrrr default) or raw text.
  const raw =
    typeof data.message === 'string'
      ? data.message
      : typeof data.text === 'string'
        ? data.text
        : JSON.stringify(data);
  const body = raw.trim() || '(sin contenido)';
  const level = /\b(error|fail|failed|fatal)\b/i.test(body) ? 'warn' : 'info';

  return { text: `${header}\n<pre>${escapeHtml(body)}</pre>`, level };
}

/**
 * Coerces a value to a trimmed single-line string for the table.
 *
 * @param {unknown} value
 * @returns {string}
 */
function oneLine(value) {
  return String(value ?? '?').replace(/\s+/g, ' ').trim() || '?';
}

/**
 * Escapes a string for Telegram HTML parse mode.
 *
 * @param {string} input
 * @returns {string}
 */
function escapeHtml(input) {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
