/**
 * Convierte un .srt (formato que pedimos a yt-dlp via --convert-subs srt) en
 * texto plano apto para pasar al LLM. Elimina índices de cue, líneas de timing,
 * tags HTML simples y deduplica líneas consecutivas idénticas (típico de los
 * subtítulos auto-generados por YouTube).
 *
 * No intenta deduplicar el "rolling caption" más complejo de los auto-subs
 * (cada cue repite las últimas palabras del anterior); eso se delega al LLM.
 *
 * @param {string} srt
 * @returns {string}
 */
export function srtToPlainText(srt) {
  if (typeof srt !== 'string' || srt.length === 0) return '';

  const withoutBom = srt.charCodeAt(0) === 0xfeff ? srt.slice(1) : srt;
  const lines = withoutBom.split(/\r?\n/);

  const out = [];
  let prev = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (CUE_INDEX_RE.test(line)) continue;
    if (TIMING_RE.test(line)) continue;
    const cleaned = stripTags(line);
    if (cleaned === '') continue;
    if (cleaned === prev) continue;
    out.push(cleaned);
    prev = cleaned;
  }
  return out.join(' ').replace(/\s{2,}/g, ' ').trim();
}

const CUE_INDEX_RE = /^\d+$/;
const TIMING_RE = /-->/;
const TAG_RE = /<[^>]+>/g;

function stripTags(line) {
  return line.replace(TAG_RE, '').trim();
}
