/**
 * Lightweight intent detector for natural-language email requests in Telegram.
 *
 * Reconoce patrones habituales en español que sugieren consulta de correos:
 *  - "correo[s] de hoy", "correo[s] no leído[s] hoy", "correos pendientes"
 *  - "correo[s] de <persona/dominio>"
 *
 * Devuelve `null` cuando el mensaje no parece tener intención de email — el llamador
 * debe entonces continuar con el flujo normal (LLM general).
 *
 * Conviene mantenerlo conservador: si dudamos, devolvemos null y dejamos que el LLM
 * conteste de forma normal. Es preferible no detectar una intención válida que disparar
 * un fetch real de Gmail con texto ambiguo.
 *
 * @param {string} text
 * @returns {EmailIntent | null}
 */
export function parseEmailIntent(text) {
  const lower = normalise(text);
  if (!lower) return null;

  // No es sobre correo. Filtra rápido para reducir falsos positivos.
  if (!/(correo|correos|email|emails|mail|mensaje|mensajes|bandeja)/i.test(lower)) {
    return null;
  }

  // "correos no leidos" / "correos sin leer" / "correos pendientes" → today
  if (/(?:no\s+leid[oa]s?|sin\s+leer|pendientes?|nuevos?)/.test(lower)) {
    return { intent: 'today' };
  }

  // "correos de hoy" / "mails de hoy" / "correos hoy"
  if (/(?:^|\s)(?:correos?|emails?|mails?|mensajes?)\s+(?:de\s+)?hoy(?:\s|$)/.test(lower)) {
    return { intent: 'today' };
  }

  // Orden flexible: "tengo correos" / "correos tengo" / "qué correos tengo hoy"
  const NOUNS = '(?:correos?|emails?|mails?|mensajes?)';
  const VERBS = '(?:tengo|tienes|hay)';
  if (new RegExp(`${VERBS}\\s+(?:algun(?:os|as)?\\s+|alguna?\\s+)?${NOUNS}`).test(lower)
      || new RegExp(`${NOUNS}\\s+${VERBS}`).test(lower)) {
    return { intent: 'today' };
  }

  // "correos de <persona>" — debe ir después de los patrones específicos para que "de hoy" gane
  const fromMatch = lower.match(/(?:correos?|emails?|mails?|mensajes?)\s+de\s+([^?¿!¡.,]+?)(?:\s+por\s+favor|\?|$)/);
  if (fromMatch) {
    const target = fromMatch[1].trim();
    if (TODAY_WORDS.has(target)) return { intent: 'today' };
    if (target.length === 0) return null;
    return { intent: 'from', sender: target };
  }

  return null;
}

const TODAY_WORDS = new Set([
  'hoy', 'ahora', 'el dia', 'esta manana', 'esta tarde',
]);

/**
 * Lowercases and strips Spanish accents so regex are stable across "Banco" / "banco" / "BÁNCO".
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
 * @typedef {{ intent: 'today' }} EmailIntentToday
 * @typedef {{ intent: 'from', sender: string }} EmailIntentFrom
 * @typedef {EmailIntentToday | EmailIntentFrom} EmailIntent
 */
