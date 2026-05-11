import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWebSearchService } from '../../../src/modules/web/web-search.js';

/**
 * @returns {object}
 */
function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/**
 * Spins up a fake SearXNG that returns deterministic JSON results.
 *
 * @param {{ status?: number, body?: object | null, delayMs?: number }} [options]
 * @returns {Promise<{ baseUrl: string, calls: { query: string, format: string }[], stop: () => Promise<void> }>}
 */
async function startFakeSearxng(options = {}) {
  const { status = 200, body = null, delayMs = 0 } = options;
  /** @type {{ query: string, format: string }[]} */
  const calls = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/search') {
      calls.push({
        query: url.searchParams.get('q') ?? '',
        format: url.searchParams.get('format') ?? '',
      });

      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      res.writeHead(status, { 'content-type': 'application/json' });
      const payload = body ?? {
        results: [
          { title: 'First', url: 'https://example.com/a', content: 'snippet a', engine: 'duckduckgo' },
          { title: 'Second', url: 'https://example.com/b', content: 'snippet b', engine: 'bing' },
          { title: 'Third', url: 'https://example.com/c', content: 'snippet c', engine: 'wikipedia' },
        ],
      };
      res.end(JSON.stringify(payload));
      return;
    }
    if (url.pathname === '/healthz' || url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('web-search — SearXNG backend', () => {
  /** @type {Awaited<ReturnType<typeof startFakeSearxng>>} */
  let server;

  before(async () => { server = await startFakeSearxng(); });
  after(async () => { await server.stop(); });

  it('queries /search with format=json and returns normalised results', async () => {
    const service = createWebSearchService({ baseUrl: server.baseUrl, logger: silentLogger() });
    const results = await service.search('astro framework');

    assert.equal(results.length, 3);
    assert.equal(results[0].title, 'First');
    assert.equal(results[0].url, 'https://example.com/a');
    assert.equal(results[0].snippet, 'snippet a');
    assert.equal(results[0].engine, 'duckduckgo');

    const lastCall = server.calls[server.calls.length - 1];
    assert.equal(lastCall.query, 'astro framework');
    assert.equal(lastCall.format, 'json');
  });

  it('caps the number of results returned (default 5)', async () => {
    const local = await startFakeSearxng({
      body: {
        results: Array.from({ length: 10 }, (_, i) => ({
          title: `r${i}`, url: `https://x/${i}`, content: 's', engine: 'e',
        })),
      },
    });
    try {
      const service = createWebSearchService({ baseUrl: local.baseUrl, logger: silentLogger() });
      const results = await service.search('q');
      assert.equal(results.length, 5);
    } finally {
      await local.stop();
    }
  });

  it('honours maxResults override', async () => {
    const service = createWebSearchService({ baseUrl: server.baseUrl, logger: silentLogger() });
    const results = await service.search('q', { maxResults: 1 });
    assert.equal(results.length, 1);
  });

  it('rejects empty queries', async () => {
    const service = createWebSearchService({ baseUrl: server.baseUrl, logger: silentLogger() });
    await assert.rejects(() => service.search('   '), /empty/i);
  });

  it('throws controlled error when SearXNG returns 5xx', async () => {
    const local = await startFakeSearxng({ status: 502, body: { error: 'down' } });
    try {
      const service = createWebSearchService({ baseUrl: local.baseUrl, logger: silentLogger() });
      await assert.rejects(() => service.search('q'), /HTTP 502/);
    } finally {
      await local.stop();
    }
  });

  it('throws controlled error when SearXNG is unreachable', async () => {
    const service = createWebSearchService({
      baseUrl: 'http://127.0.0.1:1', // nothing listening here
      logger: silentLogger(),
      timeoutMs: 1000,
    });
    await assert.rejects(() => service.search('q'));
  });

  it('rejects when baseUrl is empty', async () => {
    const service = createWebSearchService({ baseUrl: '', logger: silentLogger() });
    await assert.rejects(() => service.search('q'), /not configured/i);
  });

  it('checkHealth returns true for a reachable instance', async () => {
    const service = createWebSearchService({ baseUrl: server.baseUrl, logger: silentLogger() });
    assert.equal(await service.checkHealth(), true);
  });

  it('checkHealth returns false when baseUrl is empty', async () => {
    const service = createWebSearchService({ baseUrl: '', logger: silentLogger() });
    assert.equal(await service.checkHealth(), false);
  });
});
