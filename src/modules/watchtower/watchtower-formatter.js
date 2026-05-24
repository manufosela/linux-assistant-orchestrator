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
  let data = typeof payload === 'string' ? (tryJson(payload) ?? { message: payload }) : (payload ?? {});
  // shoutrrr `generic` envuelve la plantilla de Watchtower en el campo
  // `message` (un string que, con nuestra plantilla, ES JSON). Lo abrimos.
  if (data && typeof data.message === 'string') {
    const inner = tryJson(data.message.trim());
    if (inner && typeof inner === 'object') data = inner;
  }

  const host = typeof data.host === 'string' && data.host ? data.host : 'desconocido';
  const updated = Array.isArray(data.updated) ? data.updated : [];
  const failed = Array.isArray(data.failed) ? data.failed : [];
  const scanned = Number.isFinite(data.scanned) ? data.scanned : undefined;
  const nameOf = (e) => (typeof e === 'string' ? e : oneLine(e?.name));

  // Reporte estructurado: hubo actualizaciones y/o fallos.
  if (updated.length > 0 || failed.length > 0) {
    const lines = [];
    if (updated.length > 0) {
      lines.push(`✅ ${updated.length} actualizado${updated.length > 1 ? 's' : ''}: ${updated.map(nameOf).join(', ')}`);
    }
    if (failed.length > 0) {
      lines.push(`⚠️ ${failed.length} con fallo: ${failed.map(nameOf).join(', ')}`);
    }
    return {
      text: `🐳 <b>Watchtower · ${escapeHtml(host)}</b>\n${escapeHtml(lines.join('\n'))}`,
      level: failed.length > 0 ? 'warn' : 'success',
    };
  }

  // Reporte estructurado sin cambios.
  if (scanned !== undefined || (typeof data.host === 'string' && data.host)) {
    return {
      text:
        `🐳 <b>Watchtower · ${escapeHtml(host)}</b>\nSin cambios` +
        (scanned !== undefined ? ` (${scanned} contenedores revisados).` : '.'),
      level: 'info',
    };
  }

  // Sin plantilla / texto plano (banner u otros): resumen corto en una línea.
  const raw = (
    typeof data.message === 'string'
      ? data.message
      : typeof data.text === 'string'
        ? data.text
        : JSON.stringify(data)
  ).trim();
  const firstLine = raw.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '(sin contenido)';
  const level = /\b(error|fail(ed)?|fatal)\b/i.test(raw) ? 'warn' : 'info';
  return { text: `🐳 <b>Watchtower</b>\n${escapeHtml(firstLine)}`, level };
}

/**
 * Intenta parsear JSON; devuelve null si no lo es.
 *
 * @param {string} s
 * @returns {any|null}
 */
function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
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
