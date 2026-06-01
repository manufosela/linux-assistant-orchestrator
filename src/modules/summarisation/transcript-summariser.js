/**
 * Resume un transcript usando un LLM, con chunking automático cuando el
 * texto supera `chunkChars` (típicamente ~8000 chars ≈ ~2000 tokens).
 *
 * Estrategia:
 *   - Texto corto → 1 sola llamada con prompt "final".
 *   - Texto largo → trocea en N chunks, resume cada uno con prompt "parcial"
 *     (preservando datos clave), y luego resume la unión con prompt "final".
 *
 * Extraído de youtube-service.js para reutilizar desde media-transcriber.
 *
 * @param {{
 *   llmService: { generateText: (prompt: string, opts?: object) => Promise<string> },
 *   chunkChars?: number,
 *   logger?: import('pino').Logger,
 *   module?: string,  // identificador para telemetría LLM
 * }} deps
 * @returns {TranscriptSummariser}
 */
export function createTranscriptSummariser({
  llmService,
  chunkChars = 8000,
  logger,
  module = 'summarisation',
} = {}) {
  if (!llmService) throw new Error('createTranscriptSummariser requires llmService');

  /**
   * @param {string} text
   * @param {{ language?: string, title?: string|null }} [opts]
   * @returns {Promise<string>}
   */
  async function summarise(text, opts = {}) {
    const language = opts.language ?? 'es';
    const title = opts.title ?? null;
    if (!text || text.length === 0) return '';
    if (text.length <= chunkChars) {
      return summariseChunk(text, { language, title, isFinal: true });
    }
    const chunks = chunkText(text, chunkChars);
    logger?.info({ chunks: chunks.length, totalChars: text.length, module }, 'transcript: chunking summary');
    const partials = [];
    for (const chunk of chunks) {
      partials.push(await summariseChunk(chunk, { language, title, isFinal: false }));
    }
    return summariseChunk(partials.join('\n\n'), { language, title, isFinal: true });
  }

  async function summariseChunk(text, { language, title, isFinal }) {
    const titleLine = title ? `Título: ${title}\n\n` : '';
    const prompt = isFinal
      ? `${titleLine}Resume el siguiente texto en ${language}. Devuelve solo el resumen, sin meta-comentarios. Si hay varios temas, usa bullets cortos.\n\n${text}`
      : `${titleLine}Resume brevemente este fragmento en ${language}, preservando datos clave (nombres, números, decisiones).\n\n${text}`;
    return llmService.generateText(prompt, {
      module,
      operation: isFinal ? 'summary-final' : 'summary-chunk',
      private: true,
    });
  }

  return { summarise };
}

/**
 * Divide texto en chunks de hasta `maxChars`, intentando cortar en fin de
 * frase (`. `, `? `, `! `) si hay uno razonablemente cerca del final
 * (>50% del chunk); si no, corta directo. Devuelve chunks trimeados.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
export function chunkText(text, maxChars) {
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

/**
 * @typedef {Object} TranscriptSummariser
 * @property {(text: string, opts?: { language?: string, title?: string|null }) => Promise<string>} summarise
 */
