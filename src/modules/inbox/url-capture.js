import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * URL capture — when the user pastes a link, fetch it (with anti-SSRF via
 * urlFetcher) and store it in the inbox as a routed 'estudio' item with the
 * extracted text already written as extracted.md.
 *
 * URLs follow a *different* flow from file attachments:
 *
 *   1. urlFetcher.fetchUrl(url) already returns plain text + title (no need
 *      for Markitdown).
 *   2. We hardcode the classification to 'estudio' — articles are study
 *      material by default. The user can re-classify by hand if they want.
 *   3. The item is marked 'routed' immediately (no waiting for downstream
 *      cards like Drive upload — that's TSK-0049's job once it lands).
 *
 * Returning a structured result lets the calling layer (Telegram, CLI, web)
 * format its own reply without re-reading the meta.
 *
 * @param {{
 *   urlFetcher: { fetchUrl: (url: string) => Promise<{ url: string, title: string, text: string, contentType?: string }> },
 *   inboxStore: { add: Function, markRouted: Function },
 *   logger?: import('pino').Logger,
 *   now?: () => Date,
 * }} deps
 * @returns {UrlCapture}
 */
export function createUrlCapture({ urlFetcher, inboxStore, logger, now = () => new Date() }) {
  if (!urlFetcher) throw new Error('createUrlCapture requires urlFetcher');
  if (!inboxStore) throw new Error('createUrlCapture requires inboxStore');

  /**
   * Captures a URL into the inbox.
   *
   * @param {string} url
   * @param {object} origin Origin descriptor (e.g. {type, chatId, messageId, kind:'url'}).
   * @returns {Promise<UrlCaptureResult>}
   */
  async function captureUrl(url, origin) {
    if (!isUrl(url)) throw new Error(`Not a valid URL: ${url}`);

    const fetched = await urlFetcher.fetchUrl(url);

    const item = await inboxStore.add({
      origin: { ...origin, url: fetched.url },
      mimeType: 'text/html',
      fileName: null,
      textCaption: url,
    });

    const extractedPath = join(item.dir, 'extracted.md');
    const body = [
      `# ${fetched.title || url}`,
      '',
      `> Fuente: ${fetched.url}`,
      `> Fecha: ${item.meta.receivedAt}`,
      '',
      fetched.text?.trim() || '(sin contenido extraído)',
    ].join('\n');
    await writeFile(extractedPath, body, 'utf8');

    const words = (fetched.text || '').split(/\s+/).filter(Boolean).length;
    const updated = {
      ...item.meta,
      classification: {
        category: 'estudio',
        confidence: 1,
        reasoning: 'URL capturada — clasificación hardcoded como estudio',
        at: now().toISOString(),
      },
      extraction: {
        path: extractedPath,
        words,
        title: fetched.title || null,
        source: 'urlFetcher',
        at: now().toISOString(),
      },
    };
    await writeFile(join(item.dir, 'meta.json'), JSON.stringify(updated, null, 2), 'utf8');
    await inboxStore.markRouted(item.id, `extracted:${extractedPath}`);

    logger?.info({ id: item.id, url: fetched.url, words }, 'url.capture');

    return {
      item,
      finalUrl: fetched.url,
      title: fetched.title || null,
      words,
      extractedPath,
    };
  }

  return { captureUrl };
}

/**
 * True if the trimmed text is exactly a single http(s) URL.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isUrl(text) {
  return typeof text === 'string' && /^https?:\/\/\S+$/i.test(text.trim());
}

/**
 * Returns the leading URL (if the trimmed text starts with one), else null.
 * Used to detect "the user pasted a link" with optional comment after.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function extractLeadingUrl(text) {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/^(https?:\/\/\S+)/i);
  return match ? match[1] : null;
}

/**
 * @typedef {Object} UrlCaptureResult
 * @property {{ id: string, dir: string, meta: object }} item
 * @property {string} finalUrl
 * @property {string | null} title
 * @property {number} words
 * @property {string} extractedPath
 */

/**
 * @typedef {Object} UrlCapture
 * @property {(url: string, origin: object) => Promise<UrlCaptureResult>} captureUrl
 */
