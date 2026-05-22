/**
 * Detects a natural-language "is anything down?" query so phrases like
 * "¿hay algo caído?" or "¿está todo bien?" trigger a Prometheus health check
 * instead of going through the LLM.
 *
 * Returns `null` when the text is not such a query, so the caller can fall
 * back to the normal LLM conversation.
 *
 * @param {string} text
 * @returns {PrometheusIntent | null}
 */
export function parsePrometheusIntent(text) {
  if (!text) return null;

  const normalised = stripAccents(text.toLowerCase()).trim();

  // Cluster questions have their own dedicated intent — do not hijack them.
  if (/\bcluster\b/.test(normalised)) return null;

  // Explicit mention of the monitoring stack.
  if (/\b(prometheus|monitorizacion|alerta|alertas)\b/.test(normalised)) {
    return { kind: 'down-check' };
  }

  // Something fell over: "algo caído", "se ha caído", "qué se cayó", "offline".
  if (/\b(caid[oa]s?|cae|cayo|cayeron|offline|down)\b/.test(normalised)) {
    return { kind: 'down-check' };
  }

  // "¿está todo bien / ok / levantado / funcionando / operativo / en orden?"
  if (
    /\btodo\b/.test(normalised) &&
    /\b(bien|ok|correcto|levantado|funcionando|operativo|arriba|en orden)\b/.test(normalised)
  ) {
    return { kind: 'down-check' };
  }

  // "estado de los servicios", "están los servicios bien", "servicios caídos".
  if (
    /\bservicios?\b/.test(normalised) &&
    /(estado|caid|abajo|bien|ok|levantad|funcion|operativ|arriba)/.test(normalised)
  ) {
    return { kind: 'down-check' };
  }

  return null;
}

/**
 * Removes diacritics (NFD + strip the combining-marks block U+0300–U+036F)
 * so "caído" and "caido" match the same way.
 *
 * @param {string} value
 * @returns {string}
 */
function stripAccents(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * @typedef {Object} PrometheusIntent
 * @property {'down-check'} kind
 */
