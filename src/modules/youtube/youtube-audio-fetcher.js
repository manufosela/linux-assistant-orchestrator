import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRunCommand, mapYtDlpError, YoutubeError } from './ytdlp-runner.js';

export { YoutubeError };

// Vídeos largos pueden tardar varios minutos en descargarse + extraerse;
// 10 minutos cubre cómodamente vídeos de hasta ~2h con conexión decente.
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_AUDIO_FORMAT = 'mp3';

/**
 * Descarga el audio de un vídeo de YouTube como fichero local. El caller
 * recibe la ruta del fichero y un `cleanup()` que borra el workdir
 * temporal; debe invocarlo cuando termine de usar el audio (típicamente
 * después de transcribirlo con Whisper).
 *
 * El audio NO se borra en `finally` para permitir su consumo por el
 * caller; en error sí se limpia automáticamente.
 *
 * @param {{
 *   ytdlpBin?: string,
 *   timeoutMs?: number,
 *   audioFormat?: string,
 *   logger?: import('pino').Logger,
 *   runCommand?: typeof defaultRunCommand,
 * }} [deps]
 * @returns {YoutubeAudioFetcher}
 */
export function createYoutubeAudioFetcher({
  ytdlpBin = 'yt-dlp',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  audioFormat = DEFAULT_AUDIO_FORMAT,
  logger,
  runCommand = defaultRunCommand,
} = {}) {
  /**
   * @param {string} url
   * @returns {Promise<{
   *   audioPath: string,
   *   videoId: string|null,
   *   title: string|null,
   *   durationSec: number|null,
   *   cleanup: () => Promise<void>,
   * }>}
   */
  async function fetchAudio(url) {
    if (typeof url !== 'string' || url.trim() === '') {
      throw new YoutubeError('fetchAudio requires a non-empty URL', { code: 'INVALID_ARGS' });
    }
    const workdir = await mkdtemp(join(tmpdir(), 'luis-yt-audio-'));
    try {
      const args = [
        '-x',
        '--audio-format', audioFormat,
        '--no-warnings',
        // `--print` implies `--simulate` (no download) unless --no-simulate is set:
        // https://github.com/yt-dlp/yt-dlp#output-template — sin esto yt-dlp imprime
        // la metadata, termina con exit 0 y NO descarga, dejando el workdir vacío.
        '--no-simulate',
        '--print', '%(id)s\t%(title)s\t%(duration)s',
        '-o', join(workdir, '%(id)s.%(ext)s'),
        url,
      ];
      const { code, stdout, stderr } = await runCommand({
        bin: ytdlpBin, args, timeoutMs, logger,
      });
      if (code !== 0) throw mapYtDlpError(stderr);

      const audioFiles = (await readdir(workdir)).filter((f) => f.endsWith(`.${audioFormat}`));
      if (audioFiles.length === 0) {
        throw new YoutubeError('yt-dlp did not produce an audio file', {
          code: 'NO_AUDIO',
          cause: stderr,
        });
      }
      const audioPath = join(workdir, audioFiles[0]);
      const meta = parseMetadata(stdout);
      return {
        audioPath,
        ...meta,
        cleanup: async () => { await rm(workdir, { recursive: true, force: true }); },
      };
    } catch (err) {
      await rm(workdir, { recursive: true, force: true });
      throw err;
    }
  }

  return { fetchAudio };
}

function parseMetadata(stdout) {
  const firstLine = (stdout ?? '').split('\n').find((l) => l.trim().length > 0);
  if (!firstLine) return { videoId: null, title: null, durationSec: null };
  const [videoId, title, duration] = firstLine.split('\t');
  const durationSec = Number.parseFloat(duration);
  return {
    videoId: videoId?.trim() || null,
    title: title?.trim() || null,
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
  };
}

/**
 * @typedef {Object} YoutubeAudioFetcher
 * @property {(url: string) => Promise<{
 *   audioPath: string,
 *   videoId: string|null,
 *   title: string|null,
 *   durationSec: number|null,
 *   cleanup: () => Promise<void>,
 * }>} fetchAudio
 */
