import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWebApp } from '../../../src/apps/web/create-web-app.js';

/**
 * @returns {object}
 */
function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/**
 * Builds default fake services. Override individual ones via the override argument.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function makeServices(overrides = {}) {
  return {
    llmService: {
      generateText: async (prompt, options) => `echo:${prompt}:${options.module}`,
      chat: async (messages, options) => `chat-echo:${messages[messages.length - 1]?.content ?? ''}:${options.module}`,
      checkHealth: async () => ({ healthy: true, provider: 'local', model: 'test', baseUrl: 'http://x' }),
    },
    statusService: {
      getStatus: () => ({
        name: 'web-test-bot',
        startedAt: new Date(0).toISOString(),
        uptimeMs: 1000,
        uptimeFormatted: '1s',
        environment: 'test',
        modules: [{ name: 'web', status: 'enabled' }],
      }),
    },
    rulesRepository: {
      loadRules: async () => [
        { name: 'PDFs', extensions: ['.pdf'], targetPath: '/tmp/pdf' },
        { name: 'Images', extensions: ['.png', '.jpg'], targetPath: '/tmp/img' },
      ],
      invalidateCache: () => {},
    },
    urlFetcher: undefined,
    webSearch: undefined,
    ...overrides,
  };
}

/**
 * Spins up the web app on a random port. Returns the base URL and a stop function.
 *
 * @param {object} [overrides]
 * @returns {Promise<{ baseUrl: string, stop: () => Promise<void>, services: object }>}
 */
async function startApp(overrides = {}) {
  const services = makeServices(overrides);
  const app = createWebApp({
    llmService: services.llmService,
    statusService: services.statusService,
    rulesRepository: services.rulesRepository,
    urlFetcher: services.urlFetcher,
    webSearch: services.webSearch,
    logger: silentLogger(),
    host: '127.0.0.1',
    port: 0, // ephemeral
  });
  await app.start();
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => app.stop(),
    services,
  };
}

/**
 * Helper for JSON POST requests.
 *
 * @param {string} url
 * @param {unknown} body
 * @returns {Promise<Response>}
 */
function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('web app — HTTP API', () => {
  /** @type {Awaited<ReturnType<typeof startApp>>} */
  let app;

  before(async () => { app = await startApp(); });
  after(async () => { await app.stop(); });

  it('GET /api/status returns the assistant status', async () => {
    const response = await fetch(`${app.baseUrl}/api/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.name, 'web-test-bot');
    assert.deepEqual(body.modules, [{ name: 'web', status: 'enabled' }]);
  });

  it('GET /api/llm/status routes to llmService.checkHealth', async () => {
    const response = await fetch(`${app.baseUrl}/api/llm/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.healthy, true);
    assert.equal(body.provider, 'local');
  });

  it('GET /api/llm/status returns 503 when the LLM is unhealthy', async () => {
    const local = await startApp({
      llmService: {
        generateText: async () => 'unused',
        chat: async () => 'unused',
        checkHealth: async () => ({ healthy: false, provider: 'local', model: '', baseUrl: 'http://x' }),
      },
    });
    try {
      const response = await fetch(`${local.baseUrl}/api/llm/status`);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.healthy, false);
    } finally {
      await local.stop();
    }
  });

  it('POST /api/ask calls llmService.generateText with module=web and private=true', async () => {
    /** @type {{ prompt: string|null, options: any }} */
    const captured = { prompt: null, options: null };
    const local = await startApp({
      llmService: {
        generateText: async (prompt, options) => {
          captured.prompt = prompt;
          captured.options = options;
          return 'web-response';
        },
        chat: async () => 'unused',
        checkHealth: async () => ({ healthy: true, provider: 'local', model: 'm', baseUrl: 'http://x' }),
      },
    });
    try {
      const response = await postJson(`${local.baseUrl}/api/ask`, { prompt: 'hola' });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.text, 'web-response');
      assert.equal(captured.prompt, 'hola');
      assert.equal(captured.options.module, 'web');
      assert.equal(captured.options.operation, 'ask');
      assert.equal(captured.options.private, true);
    } finally {
      await local.stop();
    }
  });

  it('POST /api/ask validates the prompt is non-empty', async () => {
    const response = await postJson(`${app.baseUrl}/api/ask`, { prompt: '   ' });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /Missing prompt/);
  });

  it('POST /api/ask returns 502 when the LLM throws', async () => {
    const local = await startApp({
      llmService: {
        generateText: async () => { throw new Error('fetch failed'); },
        chat: async () => 'unused',
        checkHealth: async () => ({ healthy: false, provider: 'local', model: '', baseUrl: 'http://x' }),
      },
    });
    try {
      const response = await postJson(`${local.baseUrl}/api/ask`, { prompt: 'hi' });
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.match(body.error, /LLM provider error/);
      assert.match(body.detail, /fetch failed/);
    } finally {
      await local.stop();
    }
  });

  it('GET /api/downloads/rules returns the configured rules', async () => {
    const response = await fetch(`${app.baseUrl}/api/downloads/rules`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.rules.length, 2);
    assert.equal(body.rules[0].name, 'PDFs');
  });

  it('POST /api/downloads/organize returns a safe placeholder', async () => {
    const response = await postJson(`${app.baseUrl}/api/downloads/organize`, {});
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.placeholder, true);
    assert.equal(body.ok, false);
    assert.match(body.message, /not wired/);
  });

  it('GET /api/unknown returns 404', async () => {
    const response = await fetch(`${app.baseUrl}/api/totally-unknown`);
    assert.equal(response.status, 404);
  });

  it('GET / serves the HTML UI', async () => {
    const response = await fetch(`${app.baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const text = await response.text();
    assert.match(text, /<title>luis<\/title>/);
    assert.match(text, /id="chat-form"/);
  });

  it('GET /styles.css serves the stylesheet', async () => {
    const response = await fetch(`${app.baseUrl}/styles.css`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/css/);
  });

  it('refuses path traversal outside the public directory', async () => {
    const response = await fetch(`${app.baseUrl}/../package.json`);
    assert.notEqual(response.status, 200);
  });

  it('POST /api/chat invokes llmService.chat with module=web and private=true', async () => {
    /** @type {{ messages: any, options: any }} */
    const captured = { messages: null, options: null };
    const local = await startApp({
      llmService: {
        generateText: async () => 'unused',
        chat: async (messages, options) => {
          captured.messages = messages;
          captured.options = options;
          return 'chat-reply';
        },
        checkHealth: async () => ({ healthy: true, provider: 'local', model: 'm', baseUrl: 'http://x' }),
      },
    });
    try {
      const response = await postJson(`${local.baseUrl}/api/chat`, {
        messages: [
          { role: 'system', content: 'you are luis' },
          { role: 'user', content: 'hola' },
        ],
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.text, 'chat-reply');
      assert.equal(captured.messages.length, 2);
      assert.equal(captured.options.module, 'web');
      assert.equal(captured.options.operation, 'chat');
      assert.equal(captured.options.private, true);
    } finally {
      await local.stop();
    }
  });

  it('POST /api/chat returns 400 when messages is missing or empty', async () => {
    const r1 = await postJson(`${app.baseUrl}/api/chat`, {});
    assert.equal(r1.status, 400);
    const r2 = await postJson(`${app.baseUrl}/api/chat`, { messages: [] });
    assert.equal(r2.status, 400);
  });

  it('POST /api/chat rejects invalid message shapes', async () => {
    const response = await postJson(`${app.baseUrl}/api/chat`, {
      messages: [{ role: 'wizard', content: 'mischief' }],
    });
    assert.equal(response.status, 400);
  });

  it('POST /api/fetch returns 503 when fetcher is not configured', async () => {
    const response = await postJson(`${app.baseUrl}/api/fetch`, { url: 'https://example.com' });
    assert.equal(response.status, 503);
  });

  it('POST /api/fetch invokes the URL fetcher and returns the result', async () => {
    let captured = null;
    const local = await startApp({
      urlFetcher: {
        fetchUrl: async (url) => {
          captured = url;
          return { url, title: 'T', text: 'BODY', contentType: 'text/html', bytes: 4 };
        },
      },
    });
    try {
      const response = await postJson(`${local.baseUrl}/api/fetch`, { url: 'https://example.com' });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(captured, 'https://example.com');
      assert.equal(body.text, 'BODY');
      assert.equal(body.title, 'T');
    } finally {
      await local.stop();
    }
  });

  it('POST /api/fetch returns 502 when the fetcher throws', async () => {
    const local = await startApp({
      urlFetcher: { fetchUrl: async () => { throw new Error('refused'); } },
    });
    try {
      const response = await postJson(`${local.baseUrl}/api/fetch`, { url: 'https://x' });
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.match(body.detail, /refused/);
    } finally {
      await local.stop();
    }
  });

  it('POST /api/fetch returns 400 when URL is missing', async () => {
    const local = await startApp({
      urlFetcher: { fetchUrl: async () => ({ url: '', title: '', text: '', contentType: '', bytes: 0 }) },
    });
    try {
      const response = await postJson(`${local.baseUrl}/api/fetch`, {});
      assert.equal(response.status, 400);
    } finally {
      await local.stop();
    }
  });

  it('POST /api/search returns 503 when search is not configured', async () => {
    const response = await postJson(`${app.baseUrl}/api/search`, { query: 'astro' });
    assert.equal(response.status, 503);
  });

  it('POST /api/search calls webSearch.search and returns the results', async () => {
    let captured = null;
    const local = await startApp({
      webSearch: {
        search: async (query) => {
          captured = query;
          return [{ title: 'A', url: 'https://a', snippet: 'sa', engine: 'duck' }];
        },
        checkHealth: async () => true,
      },
    });
    try {
      const response = await postJson(`${local.baseUrl}/api/search`, { query: 'astro' });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(captured, 'astro');
      assert.equal(body.results.length, 1);
      assert.equal(body.results[0].url, 'https://a');
    } finally {
      await local.stop();
    }
  });

  it('POST /api/search returns 502 when SearXNG fails', async () => {
    const local = await startApp({
      webSearch: { search: async () => { throw new Error('searxng down'); }, checkHealth: async () => false },
    });
    try {
      const response = await postJson(`${local.baseUrl}/api/search`, { query: 'astro' });
      assert.equal(response.status, 502);
    } finally {
      await local.stop();
    }
  });

  it('POST /api/search returns 400 when query is missing', async () => {
    const local = await startApp({
      webSearch: { search: async () => [], checkHealth: async () => true },
    });
    try {
      const response = await postJson(`${local.baseUrl}/api/search`, {});
      assert.equal(response.status, 400);
    } finally {
      await local.stop();
    }
  });
});
