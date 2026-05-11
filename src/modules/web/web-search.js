/**
 * Creates a web search service backed by a SearXNG instance running on the local network.
 *
 * Uses SearXNG's JSON output format. Requests are constrained to the configured baseUrl;
 * no fallback to public engines is performed. If SearXNG is unreachable, callers receive
 * a controlled error.
 *
 * @param {{
 *   baseUrl: string,
 *   logger: import('pino').Logger,
 *   timeoutMs?: number,
 *   maxResults?: number,
 *   apiKey?: string,
 * }} deps
 * @returns {WebSearchService}
 */
export function createWebSearchService({ baseUrl, logger, timeoutMs = 15_000, maxResults = 5, apiKey = '' }) {
  const normalisedBase = String(baseUrl ?? '').replace(/\/+$/, '');

  /**
   * Runs a search query against SearXNG and returns the top N results.
   *
   * @param {string} query
   * @param {{ maxResults?: number }} [options]
   * @returns {Promise<WebSearchResult[]>}
   */
  async function search(query, options = {}) {
    if (!normalisedBase) {
      throw new Error('Web search base URL is not configured.');
    }
    const trimmed = String(query ?? '').trim();
    if (!trimmed) {
      throw new Error('Search query is empty.');
    }

    const limit = options.maxResults ?? maxResults;
    const url = new URL(`${normalisedBase}/search`);
    url.searchParams.set('q', trimmed);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '0');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = { accept: 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`SearXNG returned HTTP ${response.status} ${response.statusText}`);
      }

      const data = /** @type {SearxngResponse} */ (await response.json());
      const results = Array.isArray(data?.results) ? data.results : [];

      logger?.info({ query: trimmed, count: results.length }, 'Web search completed');

      return results.slice(0, limit).map(toWebSearchResult);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Search timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Health-checks the SearXNG instance by fetching its root URL.
   *
   * @returns {Promise<boolean>}
   */
  async function checkHealth() {
    if (!normalisedBase) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`${normalisedBase}/healthz`, { signal: controller.signal }).catch(() => null);
        if (response && response.ok) return true;
        const fallback = await fetch(normalisedBase, { signal: controller.signal });
        return fallback.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  return { search, checkHealth };
}

/**
 * Coerces a SearXNG result row into our normalised shape.
 *
 * @param {SearxngResultRow} row
 * @returns {WebSearchResult}
 */
function toWebSearchResult(row) {
  return {
    title: String(row?.title ?? '').trim(),
    url: String(row?.url ?? '').trim(),
    snippet: String(row?.content ?? row?.snippet ?? '').trim(),
    engine: String(row?.engine ?? '').trim(),
  };
}

/**
 * @typedef {Object} WebSearchResult
 * @property {string} title
 * @property {string} url
 * @property {string} snippet
 * @property {string} engine - the SearXNG engine that produced the result
 */

/**
 * @typedef {Object} WebSearchService
 * @property {(query: string, options?: { maxResults?: number }) => Promise<WebSearchResult[]>} search
 * @property {() => Promise<boolean>} checkHealth
 */

/**
 * @typedef {Object} SearxngResultRow
 * @property {string} [title]
 * @property {string} [url]
 * @property {string} [content]
 * @property {string} [snippet]
 * @property {string} [engine]
 */

/**
 * @typedef {Object} SearxngResponse
 * @property {SearxngResultRow[]} [results]
 */
