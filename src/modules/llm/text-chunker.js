/**
 * Divide texto en chunks de hasta `maxChars`. Si encuentra un fin de frase
 * (`. `, `? `, `! `) razonablemente cerca del final del chunk (≥50% del
 * tamaño objetivo), corta ahí; si no, corta duro al máximo. Devuelve chunks
 * trimeados, sin entradas vacías.
 *
 * Compartido por inbox-reader (resúmenes de artículos guardados) y
 * youtube-service (resúmenes de transcripciones).
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
export function chunkText(text, maxChars) {
  if (typeof text !== 'string' || text.length === 0) return [];
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error('chunkText: maxChars must be a positive number');
  }

  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + maxChars, text.length);
    let breakAt = end;
    if (end < text.length) {
      const slice = text.slice(i, end);
      const lastSentenceEnd = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('! '),
      );
      if (lastSentenceEnd > maxChars * 0.5) {
        breakAt = i + lastSentenceEnd + 1;
      }
    }
    const chunk = text.slice(i, breakAt).trim();
    if (chunk.length > 0) chunks.push(chunk);
    i = breakAt;
  }
  return chunks;
}
