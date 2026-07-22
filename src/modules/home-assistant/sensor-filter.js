/**
 * Filtro compartido de sensores para la "media de la casa" (LUI-TSK-0081).
 *
 * La media de temperatura/humedad se calcula en dos sitios distintos:
 *  - `temperature-watcher.js`, para decidir si avisa por calor/frío.
 *  - `ha-fast-path.js`, cuando el usuario pregunta "qué temperatura media hace en casa".
 *
 * Ambos deben usar EXACTAMENTE el mismo criterio, o el aviso y la respuesta se
 * contradirían. Este módulo es esa única fuente de verdad.
 *
 * Se excluyen de la media:
 *  - Los sensores que casan con `excludePattern` (p.ej. la cocina, que no tiene
 *    salida de aire acondicionado y siempre marca varios grados de más, o los
 *    exteriores tipo "Terraza Cocina" / "Ext 5").
 *  - El sensor exterior configurado (`outdoorEntity`), que se sigue leyendo
 *    aparte para mostrar la temperatura de fuera en el mensaje.
 *  - Con `requireArea`, los sensores sin habitación asignada, que suelen dar
 *    valores basura (0.0) y falsearían la media.
 *
 * @param {{ excludePattern?: string, outdoorEntity?: string, requireArea?: boolean }} options
 * @returns {(sensor: { entity_id?: string, friendly_name?: string, area_name?: string }) => boolean}
 *   Predicado: `true` si el sensor cuenta para la media interior.
 */
export function createHouseAverageFilter({ excludePattern = '', outdoorEntity = '', requireArea = false } = {}) {
  const excludeRe = buildExcludeRegex(excludePattern);

  return function keepForHouseAverage(sensor) {
    if (outdoorEntity && sensor?.entity_id === outdoorEntity) return false;
    if (isExcluded(sensor, excludeRe)) return false;
    if (requireArea && !String(sensor?.area_name ?? '').trim()) return false;
    return true;
  };
}

/**
 * Compila el patrón de exclusión. Un patrón inválido se ignora (no excluye nada)
 * en lugar de tumbar el watcher.
 *
 * @param {string} pattern
 * @returns {RegExp|null}
 */
export function buildExcludeRegex(pattern) {
  const p = String(pattern ?? '').trim();
  if (!p) return null;
  try {
    return new RegExp(p, 'i');
  } catch {
    return null;
  }
}

/**
 * Un sensor está excluido si el patrón casa con su nombre, su entity_id o su área.
 * Mirar también el área permite excluir una habitación entera (p.ej. "cocina")
 * sin enumerar cada sensor.
 *
 * @param {{ entity_id?: string, friendly_name?: string, area_name?: string }} sensor
 * @param {RegExp|null} excludeRe
 * @returns {boolean}
 */
export function isExcluded(sensor, excludeRe) {
  if (!excludeRe) return false;
  const haystack = `${sensor?.friendly_name ?? ''} ${sensor?.entity_id ?? ''} ${sensor?.area_name ?? ''}`;
  return excludeRe.test(haystack);
}
