import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerWebRoutes } from './web-routes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = resolve(HERE, 'public');

/**
 * Composition root for the local web interface.
 *
 * Wires the HTTP server with the supplied internal services. The server is meant to run on a
 * trusted local network and has no authentication: the operator chooses where to bind it
 * (`host` parameter) and which network can reach it. Calls go through
 * {@link import('../../modules/llm/llm-service.js').LlmService} so the same privacy policies
 * apply as in the CLI and Telegram bot.
 *
 * @param {{
 *   llmService: import('../../modules/llm/llm-service.js').LlmService,
 *   statusService: import('../../modules/assistant/assistant-status-service.js').AssistantStatusService,
 *   rulesRepository: import('../../modules/downloads/download-rules-repository.js').DownloadRulesRepository,
 *   urlFetcher?: import('../../modules/web/url-fetcher.js').UrlFetcher,
 *   webSearch?: import('../../modules/web/web-search.js').WebSearchService,
 *   homeAssistant?: import('../../modules/home-assistant/ha-client.js').HomeAssistantClient,
 *   logger: import('pino').Logger,
 *   host: string,
 *   port: number,
 *   publicDir?: string,
 * }} deps
 * @returns {WebApp}
 */
export function createWebApp(deps) {
  const { llmService, statusService, rulesRepository, urlFetcher, webSearch, homeAssistant, logger, host, port } = deps;
  const publicDir = deps.publicDir ?? DEFAULT_PUBLIC_DIR;

  /** @type {Map<string, import('./web-routes.js').WebRouteHandler>} */
  const routes = new Map();
  const registry = {
    register: (method, path, handler) => {
      routes.set(routeKey(method, path), handler);
    },
  };

  registerWebRoutes({ registry, llmService, statusService, rulesRepository, urlFetcher, webSearch, homeAssistant, logger });

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      logger.error({ err: error?.message, url: req.url }, 'Unhandled web error');
      sendJson(res, 500, { error: 'Internal server error' });
    });
  });

  /**
   * Top-level request dispatcher: routes API calls and serves static files.
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handleRequest(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApiRequest(req, res, url);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  }

  /**
   * Dispatches an /api/* request to the registered handler.
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {URL} url
   */
  async function handleApiRequest(req, res, url) {
    const handler = routes.get(routeKey(req.method ?? 'GET', url.pathname));
    if (!handler) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: 'Invalid JSON body', detail: error?.message });
      return;
    }

    try {
      const response = await handler(req, body);
      sendJson(res, response.status, response.body);
    } catch (error) {
      logger.error({ err: error?.message, path: url.pathname }, 'Web route handler threw');
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  /**
   * Serves a static file from the public directory. Defaults `/` to `index.html`.
   * Refuses any path that escapes the public directory.
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {URL} url
   */
  async function serveStatic(req, res, url) {
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const safePath = normalize(join(publicDir, requested));

    if (!safePath.startsWith(publicDir)) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }

    if (!existsSync(safePath) || !statSync(safePath).isFile()) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const data = await readFile(safePath);
    res.writeHead(200, { 'content-type': contentTypeFor(safePath) });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(data);
    }
  }

  /**
   * Starts listening on the configured host and port.
   *
   * @returns {Promise<{ address: string }>}
   */
  function start() {
    return new Promise((resolveStart, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const address = server.address();
        const printable = typeof address === 'object' && address ? `http://${host}:${address.port}` : `${host}:${port}`;
        logger.info({ host, port }, 'Web app listening (no auth, LAN-only by design)');
        resolveStart({ address: printable });
      });
    });
  }

  /**
   * Stops the HTTP server.
   *
   * @returns {Promise<void>}
   */
  function stop() {
    return new Promise((resolveStop) => {
      server.close(() => resolveStop());
    });
  }

  return { start, stop, server };
}

/**
 * Builds the internal map key for a method + path combination.
 *
 * @param {string} method
 * @param {string} path
 * @returns {string}
 */
function routeKey(method, path) {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Reads and parses a JSON body. Returns undefined for empty bodies. Throws on invalid JSON.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolveRead, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      resolveRead(undefined);
      return;
    }

    /** @type {Buffer[]} */
    const chunks = [];
    let totalSize = 0;
    const maxSize = 1024 * 1024; // 1 MiB cap

    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolveRead(undefined);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveRead(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

/**
 * Writes a JSON response with the given status code.
 *
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {object | string} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * Returns a content-type for the given filename based on its extension.
 *
 * @param {string} filePath
 * @returns {string}
 */
function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

/**
 * @typedef {Object} WebApp
 * @property {() => Promise<{ address: string }>} start
 * @property {() => Promise<void>} stop
 * @property {http.Server} server
 */
