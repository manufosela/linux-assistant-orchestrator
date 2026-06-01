import { YoutubeError } from './ytdlp-runner.js';
import { createTranscriptSummariser, chunkText } from '../summarisation/transcript-summariser.js';

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

  const summariser = createTranscriptSummariser({
    llmService, chunkChars: summaryChunkChars, logger, module: 'youtube',
  });

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

    const summary = withSummary ? await summariser.summarise(transcript, { language, title }) : null;
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

  return { processVideo };
}

// `chunkText` se reexporta por compatibilidad con tests y consumidores externos
// que lo importaban desde aquí antes del refactor LUI-TSK-0059.
export { chunkText };

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
