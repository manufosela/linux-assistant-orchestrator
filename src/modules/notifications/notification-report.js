/**
 * Comando "informe" (LUI-TSK-0100): reúne los avisos del día que LUIS ha
 * registrado, también los que no se enviaron por Telegram por no ser urgentes.
 */

const REPORT_REQUEST = /^¿?\s*(el\s+)?informe(\s+de\s+hoy)?\s*[?!.]*$/i;

/**
 * ¿El texto libre es una petición del informe? Solo frases cortas y exactas,
 * para no robar al LLM peticiones como "hazme un informe de ventas".
 *
 * @param {string} text
 */
export function isReportRequest(text) {
  return REPORT_REQUEST.test((text ?? '').trim());
}

/** @param {string} html */
function toPlainText(html) {
  return html
    .replaceAll(/<[^>]*>/g, '')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

/** @param {string} text */
function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Cuerpo del aviso listo para el informe. Los textos registrados ya son HTML de
 * Telegram (contrato del NotificationService: así se enviaron o se habrían
 * enviado). Si uno no cabe en un mensaje, se pasa a texto plano y se recorta de
 * forma explícita: recortar el HTML dejaría etiquetas sin cerrar.
 *
 * @param {string} text
 * @param {number} maxBody
 */
function reportBody(text, maxBody) {
  if (text.length <= maxBody) return text;
  const marker = '\n… (recortado)';
  const plain = toPlainText(text);
  let cut = plain.slice(0, maxBody - marker.length);
  while (escapeHtml(cut).length + marker.length > maxBody) cut = cut.slice(0, -100);
  return `${escapeHtml(cut)}${marker}`;
}

/** @param {string} iso */
function hourLabel(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Mensajes HTML de Telegram con los avisos del día, en orden. Un aviso nunca
 * se parte entre mensajes (su HTML quedaría roto); se agrupan hasta `maxChars`.
 *
 * @param {Array<{ ts: string, text: string, urgent?: boolean }>} entries
 * @param {{ maxChars?: number }} [options]
 * @returns {string[]}
 */
export function buildReportMessages(entries, { maxChars = 3800 } = {}) {
  if (entries.length === 0) return ['📋 <b>Informe de hoy</b>\nNo hay avisos.'];

  const blocks = entries.map((e) => {
    const sent = e.urgent ? ' · <i>enviado</i>' : '';
    // 200 de margen para la línea de hora y la cabecera del informe.
    return `🕒 <b>${hourLabel(e.ts)}</b>${sent}\n${reportBody(e.text, maxChars - 200)}`;
  });

  const header = `📋 <b>Informe de hoy</b> — ${entries.length} aviso${entries.length === 1 ? '' : 's'}`;
  const messages = [];
  let current = header;
  for (const block of blocks) {
    const candidate = `${current}\n\n${block}`;
    if (candidate.length > maxChars && current !== header) {
      messages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  messages.push(current);
  return messages;
}
