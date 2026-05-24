import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * Tiny client for the Markitdown sidecar (markitdown-server). The sidecar
 * exposes /convert (multipart upload → JSON {text, title}) and /health.
 *
 * Markitdown is *optional* in the LUIS stack: if the sidecar is down or
 * unreachable, callers should treat the convertFile call as a soft failure
 * and skip extraction without aborting their flow.
 *
 * @param {{
 *   baseUrl: string,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   logger?: import('pino').Logger,
 * }} deps
 * @returns {MarkitdownClient}
 */
export function createMarkitdownClient({ baseUrl, timeoutMs = 60000, fetchImpl = fetch, logger }) {
  if (!baseUrl) throw new Error('createMarkitdownClient requires baseUrl');
  const root = baseUrl.replace(/\/+$/, '');

  /**
   * Sends a file to the sidecar and returns the extracted text.
   *
   * @param {string} filePath  Absolute path to the file to convert.
   * @returns {Promise<{ text: string, title: string | null, filename: string }>}
   */
  async function convertFile(filePath) {
    const buffer = await readFile(filePath);
    const filename = basename(filePath);
    const form = new FormData();
    form.append('file', new Blob([buffer]), filename);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${root}/convert`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new Error(`markitdown HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = await response.json();
    return {
      text: typeof data.text === 'string' ? data.text : '',
      title: typeof data.title === 'string' ? data.title : null,
      filename: typeof data.filename === 'string' ? data.filename : filename,
    };
  }

  async function checkHealth() {
    try {
      const response = await fetchImpl(`${root}/health`, { method: 'GET' });
      return response.ok;
    } catch (error) {
      logger?.debug({ err: error.message }, 'markitdown health check failed');
      return false;
    }
  }

  return { convertFile, checkHealth };
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * @typedef {Object} MarkitdownClient
 * @property {(filePath: string) => Promise<{ text: string, title: string | null, filename: string }>} convertFile
 * @property {() => Promise<boolean>} checkHealth
 */
