/**
 * Parses natural-language requests for the inbox.
 *
 * Examples that match:
 *   /inbox
 *   /inbox hoy
 *   inbox de la semana
 *   qué guardaste hoy
 *   qué tengo guardado esta semana
 *   muéstrame mis notas
 *   mis estudios de la semana
 *   mis ideas de hoy
 *
 * Returns:
 *   {
 *     kind: 'inbox-query',
 *     since: Date,
 *     until: Date | null,
 *     categories: string[] | null,
 *     label: string,
 *   }
 * or null if the text isn't an inbox query.
 *
 * @param {string} text
 * @param {{ now?: () => Date }} [options]
 * @returns {{kind: string, since: Date, until: Date|null, categories: string[]|null, label: string} | null}
 */
export function parseInboxIntent(text, { now = () => new Date() } = {}) {
  if (typeof text !== 'string') return null;
  const normalized = stripAccents(text.toLowerCase().trim());
  if (!normalized) return null;

  const triggers = [
    /^\/?inbox\b/,
    /\bque\s+(guardaste|he\s+guardado|guarde|tengo(\s+guardado)?)/,
    /\b(que|cuales)\s+(notas|ideas|tareas|documentos?|estudios?|fotos?|voces?|adjuntos?|grabaciones)/,
    // Allow up to ~40 chars between "muestra" and the target keyword so that
    // phrases like "muestra todo el inbox" or "muéstrame las ideas de hoy" match.
    /\bmuestra(me)?\b.{0,40}\b(notas|ideas|tareas|documentos?|estudios?|fotos?|voces?|adjuntos?|inbox|grabaciones|todo|historial)\b/,
    /\bmis\s+(notas|ideas|tareas|documentos?|estudios?|fotos?|voces?|grabaciones)\b/,
  ];
  if (!triggers.some((rx) => rx.test(normalized))) return null;

  const range = parseTimeRange(normalized, now);
  const categories = parseCategories(normalized);

  return {
    kind: 'inbox-query',
    since: range.since,
    until: range.until,
    categories,
    label: range.label,
  };
}

const CATEGORY_KEYWORDS = Object.freeze({
  idea: ['ideas', 'idea'],
  tarea: ['tareas', 'tarea', 'todos', 'todo'],
  documento: ['documentos', 'documento', 'docs', 'doc', 'pdfs', 'pdf'],
  estudio: ['estudios', 'estudio', 'articulos', 'articulo', 'lecturas', 'lectura'],
  foto: ['fotos', 'foto', 'imagenes', 'imagen', 'fotografias', 'fotografia'],
  voz: ['voces', 'voz', 'grabaciones', 'grabacion', 'audios', 'audio'],
});

function parseCategories(normalized) {
  const cats = new Set();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (new RegExp(`\\b${kw}\\b`).test(normalized)) {
        cats.add(cat);
        break;
      }
    }
  }
  // "notas" is ambiguous — covers both idea and tarea.
  if (/\bnotas?\b/.test(normalized)) {
    cats.add('idea');
    cats.add('tarea');
  }
  return cats.size > 0 ? Array.from(cats) : null;
}

function parseTimeRange(normalized, now) {
  const today = startOfDay(now());

  if (/\bhoy\b/.test(normalized)) {
    return { since: today, until: null, label: 'hoy' };
  }
  if (/\bayer\b/.test(normalized)) {
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    return { since: yesterday, until: today, label: 'ayer' };
  }
  if (/\b(esta\s+)?semana\b/.test(normalized)) {
    const since = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { since, until: null, label: 'esta semana' };
  }
  if (/\b(este\s+)?mes\b/.test(normalized)) {
    const since = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { since, until: null, label: 'este mes' };
  }
  if (/\b(todo|siempre|historico)\b/.test(normalized)) {
    return { since: new Date(0), until: null, label: 'todo el historial' };
  }
  // Default: last 7 days. The inbox grows; "hoy" alone may be empty too often.
  const defaultSince = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { since: defaultSince, until: null, label: 'últimos 7 días' };
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Removes diacritics so the matcher works on "ítem" / "cómo" / "qué" etc.
 *
 * @param {string} s
 */
function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
