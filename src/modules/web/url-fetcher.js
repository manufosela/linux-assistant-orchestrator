import { lookup } from 'node:dns/promises';

const DEFAULT_MAX_BYTES = 500 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const ALLOWED_CONTENT_TYPES = ['text/html', 'text/plain', 'application/xhtml+xml', 'application/json', 'text/markdown'];

/**
 * Creates a URL fetcher that downloads remote content, caps size and timeout, blocks SSRF
 * targets and extracts a plain-text view of HTML pages.
 *
 * Designed for `luis fetch <url>` and the `/fetch` slash command. The fetched text becomes
 * conversational context for the LLM — never executed, never persisted.
 *
 * @param {{
 *   logger: import('pino').Logger,
 *   allowPrivateNetworks?: boolean,
 *   privateAllowlist?: string[],
 *   maxBytes?: number,
 *   timeoutMs?: number,
 * }} [deps]
 * @returns {UrlFetcher}
 */
export function createUrlFetcher(deps = {}) {
  const {
    logger,
    allowPrivateNetworks = false,
    privateAllowlist = [],
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps;

  /**
   * Downloads a URL and returns its title, plain-text content and final URL after redirects.
   *
   * Throws on:
   *  - Invalid URL or non-http(s) scheme
   *  - SSRF target (private IP) unless explicitly allowed
   *  - Non-supported content type
   *  - HTTP error status
   *  - Body exceeding maxBytes
   *  - Timeout
   *
   * @param {string} input
   * @returns {Promise<UrlFetchResult>}
   */
  async function fetchUrl(input) {
    const url = parseAndValidate(input);
    await ensureNotSsrf(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'luis/1.0 (+local)',
          accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.5',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.some((allowed) => contentType.startsWith(allowed))) {
        throw new Error(`Unsupported content-type: ${contentType || '(none)'}`);
      }

      const finalUrl = new URL(response.url);
      // After redirects, the final host might still be private — re-check.
      await ensureNotSsrf(finalUrl);

      const buffer = await readWithCap(response, maxBytes);
      const rawText = buffer.toString('utf8');
      const isHtml = contentType.startsWith('text/html') || contentType.startsWith('application/xhtml+xml');

      const { title, text } = isHtml ? extractFromHtml(rawText) : { title: '', text: rawText.trim() };

      logger?.info({ url: finalUrl.toString(), bytes: buffer.byteLength, contentType }, 'URL fetched');

      return { url: finalUrl.toString(), title, text, contentType, bytes: buffer.byteLength };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Timeout after ${timeoutMs}ms while fetching ${url.toString()}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Validates a URL string and ensures the scheme is http or https.
   *
   * @param {string} input
   * @returns {URL}
   */
  function parseAndValidate(input) {
    /** @type {URL} */
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new Error(`Invalid URL: ${input}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Unsupported scheme: ${url.protocol}`);
    }
    return url;
  }

  /**
   * Resolves the URL hostname and rejects if it points to a private network unless explicitly
   * allowed via `allowPrivateNetworks` or `privateAllowlist`.
   *
   * @param {URL} url
   */
  async function ensureNotSsrf(url) {
    const host = url.hostname;
    if (privateAllowlist.includes(host)) return;

    /** @type {string[]} */
    const addresses = [];
    try {
      const lookups = await lookup(host, { all: true });
      addresses.push(...lookups.map((entry) => entry.address));
    } catch (error) {
      throw new Error(`DNS lookup failed for ${host}: ${error?.message ?? 'unknown error'}`);
    }

    for (const address of addresses) {
      if (isPrivateAddress(address) && !allowPrivateNetworks) {
        throw new Error(`Refusing to fetch private/loopback address ${address} (${host})`);
      }
    }
  }

  return { fetchUrl };
}

/**
 * Returns true for loopback, private (RFC1918), link-local and ULA addresses (IPv4 + IPv6).
 *
 * @param {string} address
 * @returns {boolean}
 */
export function isPrivateAddress(address) {
  if (!address) return false;
  // IPv6 loopback / link-local / ULA
  if (address === '::1' || address === '::') return true;
  if (address.toLowerCase().startsWith('fe80:')) return true;
  if (address.toLowerCase().startsWith('fc') || address.toLowerCase().startsWith('fd')) return true;
  if (address.toLowerCase().startsWith('::ffff:')) {
    return isPrivateAddress(address.slice(7));
  }
  // IPv4
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  return false;
}

/**
 * Reads a fetch Response body, aborting if it exceeds the byte cap.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readWithCap(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`Body exceeds ${maxBytes} bytes`);
    }
    return Buffer.from(arrayBuffer);
  }

  /** @type {Uint8Array[]} */
  const chunks = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalSize += value.byteLength;
    if (totalSize > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(`Body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/**
 * Extracts a title and a plain-text representation from an HTML document.
 * No DOM parser dependency: regex-based, conservative; sufficient for LLM context.
 *
 * @param {string} html
 * @returns {{ title: string, text: string }}
 */
export function extractFromHtml(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().replace(/\s+/g, ' ') : '';

  let body = html;
  // Drop everything that is definitely not content
  body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  body = body.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  body = body.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  body = body.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ');
  body = body.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');

  // Preserve a separator on block elements so words don't run together
  body = body.replace(/<\/(p|div|h[1-6]|li|tr|br|hr|section|article|header|footer|nav)>/gi, '\n');
  body = body.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining tags
  body = body.replace(/<[^>]+>/g, ' ');
  body = decodeEntities(body);
  body = body.replace(/ /g, ' ');
  body = body.replace(/[ \t]+/g, ' ');
  // Inline tags like <b>x</b> leave a stray space before punctuation — collapse it.
  body = body.replace(/[ \t]+([.,;:!?)\]}])/g, '$1');
  body = body.replace(/([(\[{])\s+/g, '$1');
  body = body.replace(/\n[ \t]*\n+/g, '\n\n');
  body = body.split('\n').map((line) => line.trim()).join('\n');
  body = body.trim();

  return { title, text: body };
}

/**
 * Decodes the small set of HTML entities that actually appear in real content.
 *
 * @param {string} input
 * @returns {string}
 */
function decodeEntities(input) {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}

/**
 * @typedef {Object} UrlFetchResult
 * @property {string} url - final URL after redirects
 * @property {string} title - page title (empty for non-HTML)
 * @property {string} text - extracted plain text
 * @property {string} contentType
 * @property {number} bytes - body size in bytes
 */

/**
 * @typedef {Object} UrlFetcher
 * @property {(input: string) => Promise<UrlFetchResult>} fetchUrl
 */
