import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createLocalLlmProvider } from '../../../src/modules/llm/local-llm-provider.js';

function noopLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

/**
 * Builds a Response-like object whose body is a ReadableStream emitting the
 * given chunks (each a Uint8Array). Matches the shape of `fetch().body`
 * sufficient for the provider to read it.
 */
function streamingResponse(textChunks, { ok = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  const queue = textChunks.map((c) => encoder.encode(c));
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of queue) controller.enqueue(chunk);
      controller.close();
    },
  });
  return {
    ok,
    status,
    body,
    async text() {
      return textChunks.join('');
    },
  };
}

describe('local-llm-provider chatStream', () => {
  it('yield deltas decodificadas de los chunks SSE OpenAI', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      assert.ok(url.endsWith('/v1/chat/completions'));
      const body = JSON.parse(options.body);
      assert.equal(body.stream, true);
      assert.equal(body.model, 'fast');

      return streamingResponse([
        'data: {"choices":[{"delta":{"content":"Hola"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"mundo"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    };

    try {
      const provider = createLocalLlmProvider(
        { baseUrl: 'http://localhost:8080/v1', model: 'fast', apiKey: '', timeoutMs: 10_000 },
        noopLogger(),
      );
      const out = [];
      for await (const chunk of provider.chatStream({
        messages: [{ role: 'user', content: 'hola' }],
        metadata: { module: 'test', operation: 'test', correlationId: 'abc' },
      })) {
        out.push(chunk);
      }
      assert.deepEqual(out, ['Hola', ' ', 'mundo']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('soporta chunks SSE que cruzan límites de buffer', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => streamingResponse([
      'data: {"choices":[{"delta":{"content":"par',
      'te1"}}]}\n\ndata: {"choices":[{"delta":{"content":"parte2"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    try {
      const provider = createLocalLlmProvider(
        { baseUrl: 'http://x:1', model: 'm', apiKey: '', timeoutMs: 1000 },
        noopLogger(),
      );
      const out = [];
      for await (const chunk of provider.chatStream({
        messages: [{ role: 'user', content: 'x' }],
        metadata: { module: 't', operation: 't', correlationId: '1' },
      })) {
        out.push(chunk);
      }
      assert.deepEqual(out, ['parte1', 'parte2']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('ignora chunks JSON inválidos sin abortar', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => streamingResponse([
      'data: NO_JSON\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    try {
      const provider = createLocalLlmProvider(
        { baseUrl: 'http://x:1', model: 'm', apiKey: '', timeoutMs: 1000 },
        noopLogger(),
      );
      const out = [];
      for await (const chunk of provider.chatStream({
        messages: [{ role: 'user', content: 'x' }],
        metadata: { module: 't', operation: 't', correlationId: '1' },
      })) {
        out.push(chunk);
      }
      assert.deepEqual(out, ['ok']);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('lanza si la respuesta HTTP no es 2xx', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 502,
      body: null,
      async text() { return 'bad gateway'; },
    });
    try {
      const provider = createLocalLlmProvider(
        { baseUrl: 'http://x:1', model: 'm', apiKey: '', timeoutMs: 1000 },
        noopLogger(),
      );
      await assert.rejects(async () => {
        for await (const _ of provider.chatStream({
          messages: [{ role: 'user', content: 'x' }],
          metadata: { module: 't', operation: 't', correlationId: '1' },
        })) {
          // unreachable
        }
      }, /HTTP 502/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
