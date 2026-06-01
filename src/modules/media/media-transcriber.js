import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_AUDIO_FORMAT = 'mp3';
const DEFAULT_FFMPEG_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;       // 500 MB
const DEFAULT_MAX_DURATION_S = 4 * 60 * 60;        // 4 horas
const DEFAULT_LANGUAGE = 'es';

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.opus', '.webm']);
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.flv', '.wmv', '.ts', '.mpg', '.mpeg']);

export class MediaError extends Error {
  constructor(message, { code = 'UNKNOWN', cause } = {}) {
    super(message, { cause });
    this.name = 'MediaError';
    this.code = code;
  }
}

/**
 * Procesa un fichero local de audio o vídeo:
 *   1. Verifica límites de tamaño/duración (rechaza fast si exceden).
 *   2. Si es vídeo (o audio en formato raro), extrae a mp3 con ffmpeg.
 *   3. Llama a whisperClient.transcribe(audioPath).
 *   4. Si withSummary, resume con el summariser.
 *
 * Diseñado simétrico a youtube-service.js: factory + deps inyectables,
 * limpieza propia del workdir temporal en `finally`.
 *
 * @param {{
 *   whisperClient: import('../whisper/whisper-client.js').WhisperClient,
 *   summariser?: import('../summarisation/transcript-summariser.js').TranscriptSummariser,
 *   ffmpegBin?: string,
 *   ffmpegTimeoutMs?: number,
 *   audioFormat?: string,
 *   maxBytes?: number,
 *   maxDurationSec?: number,
 *   defaultLanguage?: string,
 *   logger?: import('pino').Logger,
 *   runFfmpeg?: (args: string[], timeoutMs: number) => Promise<{ code: number, stderr: string }>,
 *   statFile?: typeof stat,
 * }} deps
 * @returns {MediaTranscriber}
 */
export function createMediaTranscriber({
  whisperClient,
  summariser,
  ffmpegBin = 'ffmpeg',
  ffmpegTimeoutMs = DEFAULT_FFMPEG_TIMEOUT_MS,
  audioFormat = DEFAULT_AUDIO_FORMAT,
  maxBytes = DEFAULT_MAX_BYTES,
  maxDurationSec = DEFAULT_MAX_DURATION_S,
  defaultLanguage = DEFAULT_LANGUAGE,
  logger,
  runFfmpeg = defaultRunFfmpeg,
  statFile = stat,
} = {}) {
  if (!whisperClient) throw new Error('createMediaTranscriber requires whisperClient');

  /**
   * @param {string} filePath  Ruta absoluta al audio/vídeo local.
   * @param {{ language?: string, withSummary?: boolean, title?: string|null }} [opts]
   * @returns {Promise<{
   *   transcript: string,
   *   summary: string|null,
   *   sourceKind: 'audio'|'video',
   *   audioExtracted: boolean,
   *   sizeBytes: number,
   * }>}
   */
  async function transcribe(filePath, opts = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new MediaError('transcribe requires a non-empty filePath', { code: 'INVALID_ARGS' });
    }
    const language = opts.language ?? defaultLanguage;
    const withSummary = opts.withSummary !== false;
    const title = opts.title ?? null;

    let st;
    try {
      st = await statFile(filePath);
    } catch (error) {
      throw new MediaError(`No se puede leer el fichero: ${filePath}`, { code: 'NOT_FOUND', cause: error });
    }
    if (!st.isFile()) {
      throw new MediaError(`La ruta no es un fichero: ${filePath}`, { code: 'NOT_A_FILE' });
    }
    if (st.size > maxBytes) {
      throw new MediaError(
        `Fichero demasiado grande: ${(st.size / 1024 / 1024).toFixed(1)} MB > ${(maxBytes / 1024 / 1024).toFixed(0)} MB`,
        { code: 'TOO_LARGE' },
      );
    }

    const ext = extname(filePath).toLowerCase();
    const isVideo = VIDEO_EXTS.has(ext);
    const isAudio = AUDIO_EXTS.has(ext);
    if (!isVideo && !isAudio) {
      throw new MediaError(
        `Formato no soportado: ${ext || '(sin extensión)'}. Soportados: audio (${[...AUDIO_EXTS].join(', ')}) y vídeo (${[...VIDEO_EXTS].join(', ')}).`,
        { code: 'UNSUPPORTED_FORMAT' },
      );
    }

    let audioPath = filePath;
    let workdir = null;
    let audioExtracted = false;

    try {
      if (isVideo) {
        workdir = await mkdtemp(join(tmpdir(), 'luis-media-'));
        audioPath = join(workdir, `${basename(filePath, ext)}.${audioFormat}`);
        logger?.info({ filePath, audioPath }, 'media: extracting audio with ffmpeg');
        const { code, stderr } = await runFfmpeg(
          ['-y', '-hide_banner', '-loglevel', 'error', '-i', filePath, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', audioPath],
          ffmpegTimeoutMs,
        );
        if (code !== 0) {
          throw new MediaError(`ffmpeg falló: ${stderr.slice(0, 300)}`, { code: 'FFMPEG_FAILED', cause: stderr });
        }
        audioExtracted = true;
      }

      logger?.debug({ audioPath }, 'media: sending to whisper');
      const { text } = await whisperClient.transcribe(audioPath, { language });
      if (!text || text.trim().length === 0) {
        throw new MediaError('Transcript vacío (¿audio sin habla?)', { code: 'EMPTY_TRANSCRIPT' });
      }

      let summary = null;
      if (withSummary) {
        if (!summariser) {
          throw new MediaError('Summary requested but no summariser configured', { code: 'NO_SUMMARISER' });
        }
        summary = await summariser.summarise(text, { language, title });
      }

      return {
        transcript: text,
        summary,
        sourceKind: isVideo ? 'video' : 'audio',
        audioExtracted,
        sizeBytes: st.size,
      };
    } finally {
      if (workdir) {
        await rm(workdir, { recursive: true, force: true });
      }
    }
  }

  return { transcribe };
}

/**
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{ code: number, stderr: string }>}
 */
function defaultRunFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stderr: err.message });
    });
  });
}

/**
 * @typedef {Object} MediaTranscriber
 * @property {(filePath: string, opts?: { language?: string, withSummary?: boolean, title?: string|null }) => Promise<{
 *   transcript: string,
 *   summary: string|null,
 *   sourceKind: 'audio'|'video',
 *   audioExtracted: boolean,
 *   sizeBytes: number,
 * }>} transcribe
 */
