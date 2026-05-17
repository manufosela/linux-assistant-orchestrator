/**
 * Detects a natural-language cluster query so phrases like "estado del cluster"
 * or "status cluster" work in Telegram without typing the `/cluster` command.
 *
 * Returns `null` when the text is not about the cluster, so the caller can fall
 * back to the normal LLM conversation.
 *
 * @param {string} text
 * @returns {ClusterIntent | null}
 */
export function parseClusterIntent(text) {
  if (!text) return null;

  const normalised = stripAccents(text.toLowerCase()).trim();

  if (!/\bcluster\b/.test(normalised)) return null;

  if (/\b(historial|historico|incidencias|incidencia|caidas)\b/.test(normalised)) {
    return { kind: 'history' };
  }

  if (/\b(estado|status|salud|como esta|que tal|monitor)\b/.test(normalised)) {
    return { kind: 'status' };
  }

  // Bare "cluster" defaults to a status request.
  return { kind: 'status' };
}

/**
 * Removes diacritics (NFD + strip the combining-marks block U+0300–U+036F)
 * so "histórico" and "historico" match the same way.
 *
 * @param {string} value
 * @returns {string}
 */
function stripAccents(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * @typedef {Object} ClusterIntent
 * @property {'status'|'history'} kind
 */
