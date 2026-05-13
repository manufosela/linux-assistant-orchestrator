/**
 * Lightweight intent detector for natural-language calendar requests in Telegram.
 *
 * Patterns recognised (Spanish):
 *  - "agenda de hoy" / "qué tengo hoy" / "eventos de hoy"  → today
 *  - "agenda de mañana" / "qué tengo mañana"               → tomorrow
 *  - "agenda de la semana" / "agenda esta semana"          → week
 *  - "próxima reunión" / "próximo evento" / "siguiente cita" → next
 *
 * Conservador: si dudamos, devolvemos null y el flujo pasa al LLM general.
 *
 * @param {string} text
 * @returns {CalendarIntent | null}
 */
export function parseCalendarIntent(text) {
  const lower = normalise(text);
  if (!lower) return null;

  // Filtro rápido: si no contiene términos del dominio calendario, salimos sin más.
  if (!/(agenda|evento|eventos|reunion|reuniones|cita|citas|calendario|que\s+tengo|que\s+hay|proximo|proxima|siguiente)/i.test(lower)) {
    return null;
  }

  // "próximo evento" / "próxima reunión" / "siguiente cita" / "cuándo es mi próxima reunión"
  if (/(?:proxim[oa]|siguiente)\s+(?:reunion|evento|cita)/.test(lower)
      || /(?:cuando|cual)\s+(?:es|sera)\s+(?:mi|la)\s+(?:proxima|siguiente)/.test(lower)) {
    return { intent: 'next' };
  }

  // Semana: "agenda de la semana", "qué tengo esta semana", "eventos esta semana"
  if (/(?:semana)/.test(lower)
      && /(?:agenda|evento|reunion|cita|calendario|tengo|hay)/.test(lower)) {
    return { intent: 'week' };
  }

  // Mañana: "agenda de mañana", "qué tengo mañana", "eventos mañana"
  if (/\bmanana\b/.test(lower)
      && /(?:agenda|evento|reunion|cita|calendario|tengo|hay)/.test(lower)) {
    return { intent: 'tomorrow' };
  }

  // Hoy: "agenda de hoy", "qué tengo hoy", "eventos hoy"
  if (/\bhoy\b/.test(lower)
      && /(?:agenda|evento|reunion|cita|calendario|tengo|hay)/.test(lower)) {
    return { intent: 'today' };
  }

  // "qué hay en mi agenda" / "mi agenda" → today por defecto
  if (/(?:mi\s+agenda|que\s+hay\s+en\s+(?:mi|la)\s+agenda)/.test(lower)) {
    return { intent: 'today' };
  }

  return null;
}

/**
 * Lowercases and strips Spanish accents.
 *
 * @param {string} input
 * @returns {string}
 */
function normalise(input) {
  return String(input ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @typedef {{ intent: 'today' | 'tomorrow' | 'week' | 'next' }} CalendarIntent
 */
