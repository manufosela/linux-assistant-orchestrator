import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFailoverLlmProvider,
  ClusterUnavailableError,
} from '../../../src/modules/llm/failover-llm-provider.js';

function noopLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

/**
 * Builds a stub provider with controllable behaviour for each method.
 * Counts calls per method for assertions.
 */
function buildProvider({
  healthy = true,
  generateText,
  chat,
  chatStream,
  label = 'unknown',
} = {}) {
  const calls = { generateText: 0, chat: 0, chatStream: 0, checkHealth: 0 };
  const provider = {
    async checkHealth() {
      calls.checkHealth += 1;
      return typeof healthy === 'function' ? healthy() : healthy;
    },
    async generateText(req) {
      calls.generateText += 1;
      if (!generateText) return { text: `gen:${label}` };
      return generateText(req);
    },
    async chat(req) {
      calls.chat += 1;
      if (!chat) return { text: `chat:${label}` };
      return chat(req);
    },
    chatStream: chatStream ?? (async function* defaultStream() { yield `stream:${label}`; }),
  };
  return { provider, calls };
}

describe('createFailoverLlmProvider', () => {
  it('usa primary cuando está healthy', async () => {
    const primary = buildProvider({ label: 'p' });
    const backup = buildProvider({ label: 'b' });
    const failover = createFailoverLlmProvider({
      primary: primary.provider,
      backup: backup.provider,
      logger: noopLogger(),
    });
    const result = await failover.generateText({ prompt: 'x', metadata: {} });
    assert.equal(result.text, 'gen:p');
    assert.equal(primary.calls.generateText, 1);
    assert.equal(backup.calls.generateText, 0);
  });

  it('usa backup si primary no está sano (checkHealth=false)', async () => {
    const primary = buildProvider({ label: 'p', healthy: false });
    const backup = buildProvider({ label: 'b' });
    const failover = createFailoverLlmProvider({
      primary: primary.provider,
      backup: backup.provider,
      logger: noopLogger(),
    });
    const result = await failover.generateText({ prompt: 'x', metadata: {} });
    assert.equal(result.text, 'gen:b');
    assert.equal(primary.calls.generateText, 0, 'no debe llamar al primary');
    assert.equal(backup.calls.generateText, 1);
  });

  it('si primary lanza mid-request, reintenta con backup', async () => {
    const primary = buildProvider({
      label: 'p',
      generateText: async () => { throw new Error('ECONNREFUSED'); },
    });
    const backup = buildProvider({ label: 'b' });
    const failover = createFailoverLlmProvider({
      primary: primary.provider,
      backup: backup.provider,
      logger: noopLogger(),
    });
    const result = await failover.generateText({ prompt: 'x', metadata: {} });
    assert.equal(result.text, 'gen:b');
    assert.equal(primary.calls.generateText, 1);
    assert.equal(backup.calls.generateText, 1);
  });

  it('si ambos caídos lanza ClusterUnavailableError con info de ambos', async () => {
    const primary = buildProvider({
      label: 'p',
      generateText: async () => { throw new Error('primary down'); },
    });
    const backup = buildProvider({
      label: 'b',
      generateText: async () => { throw new Error('backup down'); },
    });
    const failover = createFailoverLlmProvider({
      primary: primary.provider,
      backup: backup.provider,
      logger: noopLogger(),
    });
    await assert.rejects(
      failover.generateText({ prompt: 'x', metadata: {} }),
      (err) =>
        err instanceof ClusterUnavailableError &&
        /primary down/.test(err.message) &&
        /backup down/.test(err.message),
    );
  });

  it('cuando el primary vuelve, próxima petición lo usa sin intervención', async () => {
    let primaryAlive = false;
    const primary = buildProvider({
      label: 'p',
      healthy: () => primaryAlive,
    });
    const backup = buildProvider({ label: 'b' });
    let nowMs = 1_000_000;
    const failover = createFailoverLlmProvider({
      primary: primary.provider,
      backup: backup.provider,
      logger: noopLogger(),
      now: () => nowMs,
      primaryHealthyTtlMs: 10,
    });

    // Primer call: primary down → backup
    const r1 = await failover.generateText({ prompt: 'a', metadata: {} });
    assert.equal(r1.text, 'gen:b');

    // El primary vuelve
    primaryAlive = true;
    // Avanzamos para invalidar la (no) caché
    nowMs += 1000;

    const r2 = await failover.generateText({ prompt: 'b', metadata: {} });
    assert.equal(r2.text, 'gen:p', 'primary debe usarse cuando vuelve');
  });

  it('cachea el estado healthy del primary durante TTL (no repite checkHealth en cada call)', async () => {
    const primary = buildProvider({ label: 'p', healthy: true });
    const backup = buildProvider({ label: 'b' });
    let nowMs = 0;
    const failover = createFailoverLlmProvider({
      primary: primary.provider,
      backup: backup.provider,
      logger: noopLogger(),
      now: () => nowMs,
      primaryHealthyTtlMs: 30_000,
    });
    await failover.generateText({ prompt: 'a', metadata: {} });
    await failover.generateText({ prompt: 'b', metadata: {} });
    await failover.generateText({ prompt: 'c', metadata: {} });
    // Primer call hizo checkHealth=1. Las siguientes 2 lo usan cacheado.
    assert.equal(primary.calls.checkHealth, 1, 'sólo un checkHealth al primer call');
    assert.equal(primary.calls.generateText, 3);
  });

  it('chatStream: si primary OK, streama desde primary', async () => {
    const primary = buildProvider({
      label: 'p',
      chatStream: async function* () { yield 'a'; yield 'b'; },
    });
    const backup = buildProvider({ label: 'b' });
    const failover = createFailoverLlmProvider({
      primary: primary.provider,
      backup: backup.provider,
      logger: noopLogger(),
    });
    const out = [];
    for await (const c of failover.chatStream({ messages: [], metadata: {} })) {
      out.push(c);
    }
    assert.deepEqual(out, ['a', 'b']);
  });

  it('chatStream: si primary lanza antes del primer chunk, hace failover al backup', async () => {
    const primary = buildProvider({
      label: 'p',
      chatStream: async function* () {
        throw new Error('primary stream died');
      },
    });
    const backup = buildProvider({
      label: 'b',
      chatStream: async function* () { yield 'from-backup'; },
    });
    const failover = createFailoverLlmProvider({
      primary: primary.provider,
      backup: backup.provider,
      logger: noopLogger(),
    });
    const out = [];
    for await (const c of failover.chatStream({ messages: [], metadata: {} })) {
      out.push(c);
    }
    assert.deepEqual(out, ['from-backup']);
  });

  it('chatStream: si ambos fallan, lanza ClusterUnavailableError', async () => {
    const primary = buildProvider({
      label: 'p',
      chatStream: async function* () { throw new Error('p down'); },
    });
    const backup = buildProvider({
      label: 'b',
      chatStream: async function* () { throw new Error('b down'); },
    });
    const failover = createFailoverLlmProvider({
      primary: primary.provider,
      backup: backup.provider,
      logger: noopLogger(),
    });
    await assert.rejects(async () => {
      for await (const _ of failover.chatStream({ messages: [], metadata: {} })) {
        // unreachable
      }
    }, ClusterUnavailableError);
  });

  it('checkHealth: true si primary OK', async () => {
    const primary = buildProvider({ healthy: true });
    const backup = buildProvider({ healthy: false });
    const failover = createFailoverLlmProvider({
      primary: primary.provider,
      backup: backup.provider,
      logger: noopLogger(),
    });
    assert.equal(await failover.checkHealth(), true);
  });

  it('checkHealth: true si primary KO pero backup OK', async () => {
    const primary = buildProvider({ healthy: false });
    const backup = buildProvider({ healthy: true });
    const failover = createFailoverLlmProvider({
      primary: primary.provider,
      backup: backup.provider,
      logger: noopLogger(),
    });
    assert.equal(await failover.checkHealth(), true);
  });

  it('checkHealth: false si ambos KO', async () => {
    const primary = buildProvider({ healthy: false });
    const backup = buildProvider({ healthy: false });
    const failover = createFailoverLlmProvider({
      primary: primary.provider,
      backup: backup.provider,
      logger: noopLogger(),
    });
    assert.equal(await failover.checkHealth(), false);
  });

  it('rechaza la construcción si falta primary o backup', () => {
    assert.throws(
      () => createFailoverLlmProvider({ primary: null, backup: buildProvider().provider }),
      /requires both/,
    );
    assert.throws(
      () => createFailoverLlmProvider({ primary: buildProvider().provider, backup: null }),
      /requires both/,
    );
  });
});
