import { spawn } from 'node:child_process';

/**
 * Compartido por subtitle-fetcher y audio-fetcher. Modela un error de
 * negocio con un `code` discriminable para que los frontends (CLI /
 * Telegram) puedan elegir el mensaje a mostrar.
 */
export class YoutubeError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = 'YoutubeError';
    this.code = code ?? 'UNKNOWN';
  }
}

/**
 * Ejecuta yt-dlp (u otro binario compatible) y captura stdout/stderr.
 * Mata el proceso al expirar `timeoutMs`. No procesa errores de negocio;
 * eso es responsabilidad del caller (vía `mapYtDlpError`).
 *
 * Se exporta como dependencia inyectable: los tests pueden sustituir esta
 * función por un fake para evitar invocar el binario real.
 *
 * @param {{
 *   bin: string,
 *   args: string[],
 *   timeoutMs: number,
 *   logger?: import('pino').Logger,
 * }} params
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function defaultRunCommand({ bin, args, timeoutMs, logger }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      logger?.warn({ bin, timeoutMs }, 'yt-dlp timed out, killing process');
      proc.kill('SIGKILL');
      reject(new YoutubeError('yt-dlp timed out', { code: 'TIMEOUT' }));
    }, timeoutMs);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * Convierte el stderr de yt-dlp en un YoutubeError tipado.
 * @param {string} stderr
 * @returns {YoutubeError}
 */
export function mapYtDlpError(stderr) {
  const text = (stderr ?? '').toLowerCase();
  if (text.includes('video unavailable')) {
    return new YoutubeError('Vídeo no disponible', { code: 'UNAVAILABLE', cause: stderr });
  }
  if (text.includes('private video')) {
    return new YoutubeError('Vídeo privado', { code: 'PRIVATE', cause: stderr });
  }
  if (text.includes('is not a valid url')) {
    return new YoutubeError('URL no válida', { code: 'INVALID_URL', cause: stderr });
  }
  return new YoutubeError(`yt-dlp falló: ${(stderr ?? '').slice(0, 200)}`, { code: 'YTDLP_ERROR', cause: stderr });
}
