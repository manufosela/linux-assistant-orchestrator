import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createUrlFetcher, isPrivateAddress, extractFromHtml } from '../../../src/modules/web/url-fetcher.js';

/**
 * @returns {object}
 */
function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/**
 * Spins up a local HTTP server with deterministic routes and returns its base URL.
 *
 * Routes:
 *  GET /html       → small HTML page
 *  GET /big        → 600KB body
 *  GET /redirect   → 302 to /html
 *  GET /image      → image/png content-type
 *  GET /404        → 404 status
 *  GET /slow       → never sends a response (used for timeout test)
 *
 * @returns {Promise<{ baseUrl: string, stop: () => Promise<void> }>}
 */
async function startTestServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`
<!doctype html>
<html><head>
  <title>Hola &amp; bienvenido</title>
  <style>body { color: red; }</style>
  <script>alert('boo');</script>
</head>
<body>
  <h1>Encabezado</h1>
  <p>Primer párrafo con <b>negrita</b> y un <a href="x">enlace</a>.</p>
  <script>window.x=1</script>
  <p>Segundo párrafo.</p>
</body></html>
      `);
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('a'.repeat(600 * 1024));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/html' });
      res.end();
      return;
    }
    if (req.url === '/image') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end('not-really-a-png');
      return;
    }
    if (req.url === '/404') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (req.url === '/slow') {
      // Hang forever (until timeout)
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('default');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('url-fetcher — pure helpers', () => {
  it('isPrivateAddress recognises common private ranges', () => {
    assert.equal(isPrivateAddress('127.0.0.1'), true);
    assert.equal(isPrivateAddress('192.168.1.5'), true);
    assert.equal(isPrivateAddress('10.0.0.1'), true);
    assert.equal(isPrivateAddress('172.16.0.1'), true);
    assert.equal(isPrivateAddress('169.254.169.254'), true);
    assert.equal(isPrivateAddress('::1'), true);
    assert.equal(isPrivateAddress('fe80::1'), true);
    assert.equal(isPrivateAddress('fd00::1'), true);
  });

  it('isPrivateAddress recognises public addresses', () => {
    assert.equal(isPrivateAddress('8.8.8.8'), false);
    assert.equal(isPrivateAddress('1.1.1.1'), false);
    assert.equal(isPrivateAddress('151.101.0.1'), false);
  });

  it('extractFromHtml strips scripts/styles and yields a plain title and body', () => {
    const result = extractFromHtml(`
      <html><head><title>Mi  página &amp; tal</title>
      <style>body{}</style></head>
      <body><h1>Saludo</h1><p>Hola <b>mundo</b>.</p>
      <script>alert(1)</script><p>Otra línea.</p></body></html>
    `);
    assert.equal(result.title, 'Mi página & tal');
    assert.match(result.text, /Saludo/);
    assert.match(result.text, /Hola mundo\./);
    assert.match(result.text, /Otra línea\./);
    assert.doesNotMatch(result.text, /alert/);
    assert.doesNotMatch(result.text, /<\/?[a-z]/i);
  });
});

describe('url-fetcher — fetchUrl against a local server', () => {
  /** @type {Awaited<ReturnType<typeof startTestServer>>} */
  let server;

  before(async () => { server = await startTestServer(); });
  after(async () => { await server.stop(); });

  it('refuses to fetch a private IP by default (anti-SSRF)', async () => {
    const fetcher = createUrlFetcher({ logger: silentLogger() });
    await assert.rejects(
      () => fetcher.fetchUrl(`${server.baseUrl}/html`),
      /private|loopback/i
    );
  });

  it('allows fetching a private IP when explicitly opted in', async () => {
    const fetcher = createUrlFetcher({ logger: silentLogger(), allowPrivateNetworks: true });
    const result = await fetcher.fetchUrl(`${server.baseUrl}/html`);
    assert.equal(result.title, 'Hola & bienvenido');
    assert.match(result.text, /Encabezado/);
    assert.match(result.text, /Primer párrafo/);
    assert.doesNotMatch(result.text, /alert/);
  });

  it('respects the allowlist for a specific private host', async () => {
    const fetcher = createUrlFetcher({ logger: silentLogger(), privateAllowlist: ['127.0.0.1'] });
    const result = await fetcher.fetchUrl(`${server.baseUrl}/html`);
    assert.match(result.text, /Encabezado/);
  });

  it('rejects non-text content types', async () => {
    const fetcher = createUrlFetcher({ logger: silentLogger(), allowPrivateNetworks: true });
    await assert.rejects(
      () => fetcher.fetchUrl(`${server.baseUrl}/image`),
      /content-type/i
    );
  });

  it('rejects HTTP errors', async () => {
    const fetcher = createUrlFetcher({ logger: silentLogger(), allowPrivateNetworks: true });
    await assert.rejects(
      () => fetcher.fetchUrl(`${server.baseUrl}/404`),
      /HTTP 404/
    );
  });

  it('caps the body size and rejects oversized responses', async () => {
    const fetcher = createUrlFetcher({
      logger: silentLogger(),
      allowPrivateNetworks: true,
      maxBytes: 50 * 1024,
    });
    await assert.rejects(
      () => fetcher.fetchUrl(`${server.baseUrl}/big`),
      /exceeds/i
    );
  });

  it('follows redirects and returns the final URL', async () => {
    const fetcher = createUrlFetcher({ logger: silentLogger(), allowPrivateNetworks: true });
    const result = await fetcher.fetchUrl(`${server.baseUrl}/redirect`);
    assert.match(result.url, /\/html$/);
    assert.equal(result.title, 'Hola & bienvenido');
  });

  it('rejects invalid URLs and unsupported schemes', async () => {
    const fetcher = createUrlFetcher({ logger: silentLogger() });
    await assert.rejects(() => fetcher.fetchUrl('not-a-url'), /Invalid URL/);
    await assert.rejects(() => fetcher.fetchUrl('ftp://example.com'), /scheme/i);
  });

  it('times out when the server never responds', async () => {
    const fetcher = createUrlFetcher({
      logger: silentLogger(),
      allowPrivateNetworks: true,
      timeoutMs: 200,
    });
    await assert.rejects(
      () => fetcher.fetchUrl(`${server.baseUrl}/slow`),
      /Timeout/
    );
  });
});
