/**
 * Detecta una consulta natural a Google Drive en el fallback del LLM.
 *
 * Returns `null` cuando el texto no es sobre Drive — el llamador sigue al LLM.
 *
 * @param {string} text
 * @returns {DriveIntent | null}
 */
export function parseDriveIntent(text) {
  if (!text) return null;
  const normalised = stripAccents(text.toLowerCase()).trim();

  // Tiene que mencionar drive (o "mi unidad") para evitar falsos positivos.
  if (!/\b(drive|mi unidad|google drive)\b/.test(normalised)) return null;

  // Búsqueda: "busca X en drive", "buscar X en mi drive", "encuentra X en drive", ...
  const searchMatch = normalised.match(/(?:busca|buscar|encuentra|busqueda de)\s+(.+?)(?:\s+en\s+(?:mi\s+|google\s+)?(?:drive|unidad))?\s*$/);
  if (searchMatch) {
    let query = searchMatch[1];
    // Limpia "en (mi/google) drive/unidad" si aún quedó dentro del capturado.
    query = query.replace(/\s+en\s+(?:mi\s+|google\s+)?(?:drive|unidad)\b/g, '').trim();
    if (query.length > 0) {
      return { kind: 'search', query };
    }
  }

  // Listado: "que hay en drive", "lista drive", "drive carpeta X"
  if (/\b(que hay|listame?|lista|muestrame?|ensename?)\b/.test(normalised)) {
    return { kind: 'list-root' };
  }

  // Si solo dice "drive" o "mi drive" sin más → listar raíz.
  if (/^(drive|mi drive|mi unidad|google drive)\b\s*\??$/.test(normalised)) {
    return { kind: 'list-root' };
  }

  return null;
}

/**
 * Quita diacríticos (NFD + bloque combining U+0300–U+036F).
 *
 * @param {string} value
 * @returns {string}
 */
function stripAccents(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * @typedef {Object} DriveIntent
 * @property {'list-root' | 'search'} kind
 * @property {string} [query] solo presente cuando kind = 'search'
 */
