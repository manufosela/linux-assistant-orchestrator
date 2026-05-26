import { YoutubeError } from './ytdlp-runner.js';

// Umbral por defecto en caracteres para decidir si chunkear el resumen.
// ~8K chars ≈ ~2K tokens — seguro para casi cualquier modelo local
// (Llama 3 8B con 8K ctx, Mistral, etc.). El caller puede subirlo si
// usa modelos con context window mayor.
const DEFAULT_SUMMARY_CHUNK_CHARS = 8000;
const DEFAULT_LANGUAGE = 'es';

/**
 * Orquesta el procesado de un vídeo de YouTube en cascada:
 *   1. subtítulos (yt-dlp --write-subs) → texto
 *   2. si no hay subs: audio (yt-dlp -x) → Whisper → texto
 *   3. texto → llmService.generateText → resumen (con chunking si supera el umbral)
 *
 * Todas las dependencias son inyectables — los tests construyen el
 * service con stubs.
 *
 * @param {{
 *   subtitleFetcher: import('./youtube-subtitle-fetcher.js').YoutubeSubtitleFetcher,
 *   audioFetcher: import('./youtube-audio-fetcher.js').YoutubeAudioFetcher,
 *   whisperClient: import('../whisper/whisper-client.js').WhisperClient,
 *   llmService: { generateText: (prompt: string, opts?: object) => Promise<string> },
 *   defaultLanguage?: string,
 *   summaryChunkChars?: number,
 *   logger?: import('pino').Logger,
 * }} deps
 * @returns {YoutubeService}
 */
export function createYoutubeService({
  subtitleFetcher,
  audioFetcher,
  whisperClient,
  llmService,
  defaultLanguage = DEFAULT_LANGUAGE,
  summaryChunkChars = DEFAULT_SUMMARY_CHUNK_CHARS,
  logger,
} = {}) {
  if (!subtitleFetcher || !audioFetcher || !whisperClient || !llmService) {
    throw new Error('createYoutubeService requires subtitleFetcher, audioFetcher, whisperClient and llmService');
  }

  /**
   * @param {string} url
   * @param {{ language?: string, withSummary?: boolean }} [opts]
   * @returns {Promise<{
   *   videoId: string|null,
   *   title: string|null,
   *   lang: string|null,
   *   durationSec: number|null,
   *   source: 'subtitles'|'whisper',
   *   transcript: string,
   *   summary: string|null,
   * }>}
   */
  async function processVideo(url, opts = {}) {
    const language = opts.language ?? defaultLanguage;
    const withSummary = opts.withSummary !== false;

    const { transcript, source, videoId, title, lang, durationSec } = await fetchTranscript(url, language);
    if (!transcript || transcript.length === 0) {
      throw new YoutubeError('Transcript vacío', { code: 'EMPTY_TRANSCRIPT' });
    }

    const summary = withSummary ? await summarise(transcript, { language, title }) : null;
    return { videoId, title, lang, durationSec, source, transcript, summary };
  }

  async function fetchTranscript(url, language) {
    logger?.debug({ url }, 'youtube: trying subtitles first');
    const subs = await subtitleFetcher.fetchSubtitles(url, { langs: [language, 'en'] });
    if (subs) {
      return {
        transcript: subs.text,
        source: 'subtitles',
        videoId: subs.videoId,
        title: subs.title,
        lang: subs.lang,
        durationSec: null,
      };
    }
    logger?.info({ url }, 'youtube: no subtitles, falling back to audio + Whisper');
    const audio = await audioFetcher.fetchAudio(url);
    try {
      const { text } = await whisperClient.transcribe(audio.audioPath, { language });
      return {
        transcript: text,
        source: 'whisper',
        videoId: audio.videoId,
        title: audio.title,
        lang: language,
        durationSec: audio.durationSec,
      };
    } finally {
      await audio.cleanup();
    }
  }

  async function summarise(text, { language, title }) {
    if (text.length <= summaryChunkChars) {
      return summariseChunk(text, { language, title, isFinal: true });
    }
    const chunks = chunkText(text, summaryChunkChars);
    logger?.info({ chunks: chunks.length, totalChars: text.length }, 'youtube: chunking summary');
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
      module: 'youtube',
      operation: isFinal ? 'summary-final' : 'summary-chunk',
      private: true,
    });
  }

  return { processVideo };
}

/**
 * Divide texto en chunks de hasta `maxChars`, intentando cortar en fin
 * de frase (`. `, `? `, `! `) si hay uno razonablemente cerca del final
 * (>50% del chunk), si no corta directo. Devuelve chunks trimeados.
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
 * @typedef {Object} YoutubeService
 * @property {(url: string, opts?: {language?: string, withSummary?: boolean}) => Promise<{
 *   videoId: string|null,
 *   title: string|null,
 *   lang: string|null,
 *   durationSec: number|null,
 *   source: 'subtitles'|'whisper',
 *   transcript: string,
 *   summary: string|null,
 * }>} processVideo
 */
