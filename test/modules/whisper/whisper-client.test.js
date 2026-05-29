import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from 'undici';
import {
  createWhisperClient,
  WhisperError,
} from '../../../src/modules/whisper/whisper-client.js';

function fakeReadFile() {
  return async () => Buffer.from('fake-audio');
}

function fakeFetch({ status = 200, body = 'transcribed text  ', throwError = null, abort = false } = {}) {
  return async (url, init) => {
    if (throwError) throw throwError;
    if (abort) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
}

describe('createWhisperClient', () => {
  it('falta baseUrl → throw constructor', () => {
    assert.throws(() => createWhisperClient({}), /baseUrl/);
  });

  it('audioPath vacío → WhisperError INVALID_ARGS', async () => {
    const client = createWhisperClient({
      baseUrl: 'http://x',
      fetchImpl: fakeFetch(),
      readFileImpl: fakeReadFile(),
    });
    await assert.rejects(
      client.transcribe(''),
      (err) => err instanceof WhisperError && err.code === 'INVALID_ARGS',
    );
  });

  it('happy path: devuelve texto sin espacios extra', async () => {
    const client = createWhisperClient({
      baseUrl: 'http://x',
      fetchImpl: fakeFetch({ body: '  hola mundo  ' }),
      readFileImpl: fakeReadFile(),
    });
    const result = await client.transcribe('/tmp/a.mp3');
    assert.deepEqual(result, { text: 'hola mundo' });
  });

  it('llama al endpoint /v1/audio/transcriptions con method POST y form multipart', async () => {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const client = createWhisperClient({
      baseUrl: 'http://x/',  // con barra final, debe normalizarse
      apiKey: 'sk-test',
      fetchImpl,
      readFileImpl: fakeReadFile(),
    });
    await client.transcribe('/tmp/a.mp3', { language: 'es' });
    assert.equal(captured.url, 'http://x/v1/audio/transcriptions');
    assert.equal(captured.init.method, 'POST');
    assert.equal(captured.init.headers.Authorization, 'Bearer sk-test');
    assert.ok(captured.init.body instanceof FormData);
    assert.equal(captured.init.body.get('language'), 'es');
    assert.equal(captured.init.body.get('response_format'), 'text');
    assert.equal(captured.init.body.get('model'), 'whisper-1');
  });

  it('sin apiKey: no envía Authorization', async () => {
    let captured = null;
    const fetchImpl = async (_url, init) => {
      captured = init;
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const client = createWhisperClient({
      baseUrl: 'http://x',
      fetchImpl,
      readFileImpl: fakeReadFile(),
    });
    await client.transcribe('/tmp/a.mp3');
    assert.equal(captured.headers.Authorization, undefined);
  });

  it('5xx → WhisperError HTTP_ERROR', async () => {
    const client = createWhisperClient({
      baseUrl: 'http://x',
      fetchImpl: fakeFetch({ status: 502, body: 'bad gateway' }),
      readFileImpl: fakeReadFile(),
    });
    await assert.rejects(
      client.transcribe('/tmp/a.mp3'),
      (err) => err instanceof WhisperError && err.code === 'HTTP_ERROR',
    );
  });

  it('abort por timeout → WhisperError TIMEOUT', async () => {
    const client = createWhisperClient({
      baseUrl: 'http://x',
      timeoutMs: 10,
      fetchImpl: fakeFetch({ abort: true }),
      readFileImpl: fakeReadFile(),
    });
    await assert.rejects(
      client.transcribe('/tmp/a.mp3'),
      (err) => err instanceof WhisperError && err.code === 'TIMEOUT',
    );
  });

  it('fetch throw genérico → WhisperError NETWORK', async () => {
    const client = createWhisperClient({
      baseUrl: 'http://x',
      fetchImpl: fakeFetch({ throwError: new Error('ECONNREFUSED') }),
      readFileImpl: fakeReadFile(),
    });
    await assert.rejects(
      client.transcribe('/tmp/a.mp3'),
      (err) => err instanceof WhisperError && err.code === 'NETWORK',
    );
  });

  it('pasa un dispatcher undici al fetch para evitar el timeout de 5 min (LUI-BUG-0003)', async () => {
    let captured = null;
    const fetchImpl = async (_url, init) => {
      captured = init;
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const client = createWhisperClient({
      baseUrl: 'http://x',
      timeoutMs: 1_800_000,
      fetchImpl,
      readFileImpl: fakeReadFile(),
    });
    await client.transcribe('/tmp/a.mp3');
    assert.ok(captured.dispatcher, 'fetch init must include a dispatcher');
    assert.ok(captured.dispatcher instanceof Agent, 'dispatcher must be an undici Agent');
  });

  it('respeta un dispatcher inyectado (mismo objeto pasa a fetch)', async () => {
    const customDispatcher = new Agent({ headersTimeout: 999, bodyTimeout: 999 });
    let captured = null;
    const fetchImpl = async (_url, init) => {
      captured = init;
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const client = createWhisperClient({
      baseUrl: 'http://x',
      fetchImpl,
      readFileImpl: fakeReadFile(),
      dispatcher: customDispatcher,
    });
    await client.transcribe('/tmp/a.mp3');
    assert.strictEqual(captured.dispatcher, customDispatcher);
    await customDispatcher.close();
  });

  it('checkHealth: 200 → true', async () => {
    const client = createWhisperClient({
      baseUrl: 'http://x',
      fetchImpl: fakeFetch({ status: 200 }),
      readFileImpl: fakeReadFile(),
    });
    assert.equal(await client.checkHealth(), true);
  });

  it('checkHealth: throw → false (no propaga)', async () => {
    const client = createWhisperClient({
      baseUrl: 'http://x',
      fetchImpl: fakeFetch({ throwError: new Error('down') }),
      readFileImpl: fakeReadFile(),
    });
    assert.equal(await client.checkHealth(), false);
  });
});
