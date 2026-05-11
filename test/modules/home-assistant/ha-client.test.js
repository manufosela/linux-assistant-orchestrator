import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHomeAssistantClient } from '../../../src/modules/home-assistant/ha-client.js';

/**
 * @returns {object}
 */
function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/**
 * Spins up a fake HA instance.
 *
 * @param {{ status?: number, body?: any, requireToken?: string, delayMs?: number }} [opts]
 * @returns {Promise<{ baseUrl: string, calls: Array<{path: string, body: any, auth: string}>, stop: () => Promise<void> }>}
 */
async function startFakeHa(opts = {}) {
  const { status = 200, body = null, requireToken, delayMs = 0 } = opts;
  /** @type {Array<{ path: string, body: any, auth: string }>} */
  const calls = [];

  const server = http.createServer((req, res) => {
    const auth = req.headers['authorization'] ?? '';
    if (requireToken && auth !== `Bearer ${requireToken}`) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      let parsed = {};
      try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { _raw: raw }; }
      calls.push({ path: req.url ?? '', body: parsed, auth });

      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

      if (req.url === '/api/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'API running.' }));
        return;
      }
      if (req.url === '/api/conversation/process' && req.method === 'POST') {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body ?? {
          response: {
            speech: { plain: { speech: 'OK', extra_data: null } },
            response_type: 'action_done',
            language: 'es',
          },
          conversation_id: 'abc-123',
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
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

describe('home-assistant — client', () => {
  /** @type {Awaited<ReturnType<typeof startFakeHa>>} */
  let server;

  before(async () => { server = await startFakeHa(); });
  after(async () => { await server.stop(); });

  it('processConversation forwards text and language to HA, returns speech + ids', async () => {
    const client = createHomeAssistantClient({
      baseUrl: server.baseUrl,
      token: 'tok',
      logger: silentLogger(),
    });
    const result = await client.processConversation('enciende el termostato');
    assert.equal(result.speech, 'OK');
    assert.equal(result.responseType, 'action_done');
    assert.equal(result.conversationId, 'abc-123');
    const last = server.calls[server.calls.length - 1];
    assert.equal(last.path, '/api/conversation/process');
    assert.equal(last.body.text, 'enciende el termostato');
    assert.equal(last.body.language, 'es');
    assert.equal(last.auth, 'Bearer tok');
  });

  it('passes the conversationId so HA can keep multi-turn context', async () => {
    const client = createHomeAssistantClient({
      baseUrl: server.baseUrl,
      token: 'tok',
      logger: silentLogger(),
    });
    await client.processConversation('y ahora apágalo', { conversationId: 'prev-99' });
    const last = server.calls[server.calls.length - 1];
    assert.equal(last.body.conversation_id, 'prev-99');
  });

  it('rejects empty text', async () => {
    const client = createHomeAssistantClient({
      baseUrl: server.baseUrl,
      token: 'tok',
      logger: silentLogger(),
    });
    await assert.rejects(() => client.processConversation('   '), /empty/i);
  });

  it('throws when baseUrl is missing', async () => {
    const client = createHomeAssistantClient({ baseUrl: '', token: 't', logger: silentLogger() });
    await assert.rejects(() => client.processConversation('hi'), /not configured/i);
  });

  it('throws when token is missing', async () => {
    const client = createHomeAssistantClient({ baseUrl: server.baseUrl, token: '', logger: silentLogger() });
    await assert.rejects(() => client.processConversation('hi'), /token/i);
  });

  it('returns error code when HA does not understand', async () => {
    const local = await startFakeHa({
      body: {
        response: {
          speech: { plain: { speech: 'Lo siento, no he entendido', extra_data: null } },
          response_type: 'error',
          data: { code: 'no_valid_targets' },
          language: 'es',
        },
        conversation_id: 'x',
      },
    });
    try {
      const client = createHomeAssistantClient({ baseUrl: local.baseUrl, token: 't', logger: silentLogger() });
      const result = await client.processConversation('algo raro');
      assert.equal(result.responseType, 'error');
      assert.equal(result.errorCode, 'no_valid_targets');
      assert.match(result.speech, /no he entendido/);
    } finally {
      await local.stop();
    }
  });

  it('throws when HA returns 5xx', async () => {
    const local = await startFakeHa({ status: 502, body: { error: 'down' } });
    try {
      const client = createHomeAssistantClient({ baseUrl: local.baseUrl, token: 't', logger: silentLogger() });
      await assert.rejects(() => client.processConversation('hi'), /HTTP 502/);
    } finally {
      await local.stop();
    }
  });

  it('throws when HA rejects the token (401)', async () => {
    const local = await startFakeHa({ requireToken: 'good' });
    try {
      const client = createHomeAssistantClient({ baseUrl: local.baseUrl, token: 'bad', logger: silentLogger() });
      await assert.rejects(() => client.processConversation('hi'), /HTTP 401/);
    } finally {
      await local.stop();
    }
  });

  it('checkHealth returns true for a reachable HA instance', async () => {
    const client = createHomeAssistantClient({ baseUrl: server.baseUrl, token: 't', logger: silentLogger() });
    assert.equal(await client.checkHealth(), true);
  });

  it('checkHealth returns false when token is missing', async () => {
    const client = createHomeAssistantClient({ baseUrl: server.baseUrl, token: '', logger: silentLogger() });
    assert.equal(await client.checkHealth(), false);
  });
});
