import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MODEL = 'whisper-1';

// NOTA (LUI-BUG-0003/0004): undici (el fetch interno de Node) impone
// headersTimeout/bodyTimeout de 5 min por defecto. La forma "obvia" de
// extenderlos — pasar un Agent custom como `dispatcher` en `fetch` — rompe
// con FormData multipart (UND_ERR_INVALID_ARG: invalid onRequestStart
// method). La solución correcta es llamar a `setGlobalDispatcher` en el
// bootstrap del proceso, antes de crear ningún cliente. Ver main.js y
// cli/bin/luis.js.

export class WhisperError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = 'WhisperError';
    this.code = code ?? 'UNKNOWN';
  }
}

/**
 * Cliente HTTP genérico para un endpoint compatible con OpenAI
 * (`/v1/audio/transcriptions`). Probado contra LiteLLM con whisper.cpp
 * por debajo. Idéntica forma a `markitdown-client`: factory + deps
 * inyectables, soft errors para que el caller decida cómo degradar.
 *
 * @param {{
 *   baseUrl: string,
 *   model?: string,
 *   apiKey?: string,
 *   timeoutMs?: number,
 *   logger?: import('pino').Logger,
 *   fetchImpl?: typeof fetch,
 *   readFileImpl?: typeof readFile,
 * }} deps
 * @returns {WhisperClient}
 */
export function createWhisperClient({
  baseUrl,
  model = DEFAULT_MODEL,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger,
  fetchImpl = fetch,
  readFileImpl = readFile,
} = {}) {
  if (!baseUrl) throw new Error('createWhisperClient requires baseUrl');
  const root = baseUrl.replace(/\/+$/, '');

  /**
   * Transcribe un fichero de audio local. Devuelve el texto plano sin
   * marcas de tiempo (response_format=text).
   *
   * @param {string} audioPath  Ruta absoluta al audio.
   * @param {{ language?: string }} [opts]  ISO 639-1 hint para el modelo.
   * @returns {Promise<{ text: string }>}
   */
  async function transcribe(audioPath, opts = {}) {
    if (typeof audioPath !== 'string' || audioPath === '') {
      throw new WhisperError('transcribe requires an audio path', { code: 'INVALID_ARGS' });
    }
    const buffer = await readFileImpl(audioPath);
    const filename = basename(audioPath);

    const form = new FormData();
    form.append('file', new Blob([buffer]), filename);
    form.append('model', model);
    form.append('response_format', 'text');
    if (opts.language) form.append('language', opts.language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${root}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new WhisperError('Whisper timed out', { code: 'TIMEOUT', cause: err });
      }
      throw new WhisperError(`Whisper request failed: ${err.message}`, { code: 'NETWORK', cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new WhisperError(`Whisper HTTP ${response.status}: ${body.slice(0, 200)}`, {
        code: 'HTTP_ERROR',
        cause: body,
      });
    }
    const text = (await response.text()).trim();
    return { text };
  }

  async function checkHealth() {
    try {
      const r = await fetchImpl(`${root}/v1/models`, { method: 'GET' });
      return r.ok;
    } catch (err) {
      logger?.debug({ err: err.message }, 'whisper health check failed');
      return false;
    }
  }

  return { transcribe, checkHealth };
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * @typedef {Object} WhisperClient
 * @property {(audioPath: string, opts?: {language?: string}) => Promise<{text: string}>} transcribe
 * @property {() => Promise<boolean>} checkHealth
 */
