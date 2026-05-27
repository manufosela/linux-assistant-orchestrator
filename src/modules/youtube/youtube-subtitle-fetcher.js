import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { srtToPlainText } from './subtitle-parser.js';
import { defaultRunCommand, mapYtDlpError, YoutubeError } from './ytdlp-runner.js';

export { YoutubeError };

const DEFAULT_LANGS = ['es', 'en'];
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Cliente para extraer subtítulos de un vídeo de YouTube vía yt-dlp.
 *
 * Devuelve `null` si el vídeo no tiene subtítulos (ni manuales ni
 * auto-generados) en ninguno de los idiomas preferidos: el caller debe
 * caer al fallback de descarga de audio + Whisper.
 *
 * @param {{
 *   ytdlpBin?: string,
 *   preferredLangs?: string[],
 *   timeoutMs?: number,
 *   logger?: import('pino').Logger,
 *   runCommand?: typeof defaultRunCommand,
 * }} [deps]
 * @returns {YoutubeSubtitleFetcher}
 */
export function createYoutubeSubtitleFetcher({
  ytdlpBin = 'yt-dlp',
  preferredLangs = DEFAULT_LANGS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger,
  runCommand = defaultRunCommand,
} = {}) {
  /**
   * @param {string} url
   * @param {{ langs?: string[] }} [opts]
   * @returns {Promise<{videoId: string|null, title: string|null, lang: string|null, text: string} | null>}
   */
  async function fetchSubtitles(url, opts = {}) {
    if (typeof url !== 'string' || url.trim() === '') {
      throw new YoutubeError('fetchSubtitles requires a non-empty URL', { code: 'INVALID_ARGS' });
    }
    const langs = opts.langs ?? preferredLangs;
    const workdir = await mkdtemp(join(tmpdir(), 'luis-yt-subs-'));
    try {
      const args = [
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs', langs.map((l) => `${l}.*`).join(','),
        '--convert-subs', 'srt',
        '--no-warnings',
        '--print', '%(id)s\t%(title)s',
        '-o', join(workdir, '%(id)s'),
        url,
      ];
      const { code, stdout, stderr } = await runCommand({
        bin: ytdlpBin, args, timeoutMs, logger,
      });
      if (code !== 0) throw mapYtDlpError(stderr);

      const srtFiles = (await readdir(workdir)).filter((f) => f.endsWith('.srt'));
      if (srtFiles.length === 0) {
        logger?.debug({ url }, 'no subtitles available for video');
        return null;
      }
      const chosen = pickByLang(srtFiles, langs);
      const srt = await readFile(join(workdir, chosen), 'utf8');
      const { videoId, title } = parseMetadata(stdout);
      return {
        videoId,
        title,
        lang: extractLang(chosen),
        text: srtToPlainText(srt),
      };
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  return { fetchSubtitles };
}

function pickByLang(files, preferredLangs) {
  for (const lang of preferredLangs) {
    const exact = files.find((f) => f.includes(`.${lang}.`));
    if (exact) return exact;
    const family = files.find((f) => new RegExp(`\\.${lang}[-.]`).test(f));
    if (family) return family;
  }
  return files[0];
}

function extractLang(filename) {
  const match = filename.match(/\.([a-zA-Z-]+)\.srt$/);
  return match ? match[1] : null;
}

function parseMetadata(stdout) {
  const firstLine = (stdout ?? '').split('\n').find((l) => l.trim().length > 0);
  if (!firstLine) return { videoId: null, title: null };
  const [videoId, title] = firstLine.split('\t');
  return {
    videoId: videoId?.trim() || null,
    title: title?.trim() || null,
  };
}

/**
 * @typedef {Object} YoutubeSubtitleFetcher
 * @property {(url: string, opts?: {langs?: string[]}) => Promise<{
 *   videoId: string|null,
 *   title: string|null,
 *   lang: string|null,
 *   text: string,
 * } | null>} fetchSubtitles
 */
