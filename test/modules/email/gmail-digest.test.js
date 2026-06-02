import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGmailDigest, scheduleDaily } from '../../../src/modules/email/gmail-digest.js';

/**
 * Builds a stub gmail API with a configurable message list and metadata.
 */
function buildGmailStub({ ids = [], messages = {} } = {}) {
  const calls = { list: [], get: [] };
  const api = {
    users: {
      messages: {
        async list(params) {
          calls.list.push(params);
          return { data: { messages: ids.map((id) => ({ id })) } };
        },
        async get(params) {
          calls.get.push(params);
          const msg = messages[params.id];
          if (!msg) return { data: { payload: { headers: [] }, snippet: '' } };
          return {
            data: {
              snippet: msg.snippet,
              payload: {
                headers: [
                  { name: 'From', value: msg.from },
                  { name: 'Subject', value: msg.subject },
                  { name: 'Date', value: msg.date },
                ],
              },
            },
          };
        },
      },
    },
  };
  return { api, calls };
}

function buildLabelsStub() {
  const calls = { removeLabels: [] };
  const client = {
    async removeLabels({ messageId, labelIds }) {
      calls.removeLabels.push({ messageId, labelIds });
    },
  };
  return { client, calls };
}

function fakeLlm(reply = 'RESUMEN_OK') {
  return {
    calls: [],
    generateText: async function (prompt, meta) {
      this.calls.push({ prompt, meta });
      return reply;
    },
  };
}

describe('createGmailDigest.build', () => {
  it('devuelve objeto vacío si no hay correos', async () => {
    const { api } = buildGmailStub({ ids: [] });
    const digest = createGmailDigest({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => api,
    });
    const result = await digest.build({ query: 'label:Estudio is:unread' });
    assert.deepEqual(result, { ids: [], emails: [], summary: '', truncated: false });
  });

  it('extrae ids, fetcha cada mensaje y delega el resumen al LLM', async () => {
    const { api } = buildGmailStub({
      ids: ['m1', 'm2'],
      messages: {
        m1: { from: 'udemy@example.com', subject: 'Curso nuevo', date: 'Mon', snippet: 'Curso de ML' },
        m2: { from: 'paper@example.com', subject: 'Nueva paper', date: 'Mon', snippet: 'Transformers' },
      },
    });
    const llm = fakeLlm('Hoy llegan: curso ML y paper sobre transformers.');
    const digest = createGmailDigest({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => api,
      llmService: llm,
    });
    const result = await digest.build({ query: 'label:Estudio', maxResults: 20 });
    assert.deepEqual(result.ids, ['m1', 'm2']);
    assert.equal(result.emails.length, 2);
    assert.match(result.summary, /transformers/i);
    assert.equal(llm.calls.length, 1);
    assert.equal(llm.calls[0].meta.module, 'gmail-digest');
  });

  it('rechaza query vacía sin llamar al API', async () => {
    const { api, calls } = buildGmailStub();
    const digest = createGmailDigest({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => api,
    });
    await assert.rejects(digest.build({ query: '' }), /query Gmail/);
    assert.equal(calls.list.length, 0);
  });

  it('cap maxResults a 50', async () => {
    const { api, calls } = buildGmailStub({ ids: [] });
    const digest = createGmailDigest({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => api,
    });
    await digest.build({ query: 'q', maxResults: 1000 });
    assert.equal(calls.list[0].maxResults, 50);
  });

  it('cae a lista plana si el LLM falla', async () => {
    const { api } = buildGmailStub({
      ids: ['m1'],
      messages: { m1: { from: 'x@y.com', subject: 'asunto', date: '', snippet: 's' } },
    });
    const brokenLlm = {
      generateText: async () => {
        throw new Error('LLM down');
      },
    };
    const digest = createGmailDigest({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => api,
      llmService: brokenLlm,
    });
    const result = await digest.build({ query: 'q' });
    assert.match(result.summary, /asunto/);
    assert.match(result.summary, /x@y\.com/);
  });

  it('divide en chunks de máximo 5 correos cuando hay más (evita truncamiento del LLM)', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const messages = Object.fromEntries(
      ids.map((id, i) => [id, { from: `a${i}`, subject: `s${i}`, date: '', snippet: 't' }]),
    );
    const { api } = buildGmailStub({ ids, messages });
    const llm = fakeLlm('parcial');
    const digest = createGmailDigest({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => api,
      llmService: llm,
    });
    await digest.build({ query: 'q', maxResults: 12 });
    // 12 correos en chunks de 5 → 3 llamadas al LLM (5+5+2)
    assert.equal(llm.calls.length, 3);
    // Y cada llamada lleva maxTokens elevado, no el default
    for (const call of llm.calls) {
      assert.equal(call.meta.maxTokens, 2048, 'maxTokens debe estar elevado para no truncar');
    }
  });

  it('truncated=true si llega al maxResults configurado', async () => {
    const { api } = buildGmailStub({
      ids: ['a', 'b'],
      messages: {
        a: { from: 'a', subject: 'A', date: '', snippet: '' },
        b: { from: 'b', subject: 'B', date: '', snippet: '' },
      },
    });
    const digest = createGmailDigest({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => api,
    });
    const result = await digest.build({ query: 'q', maxResults: 2 });
    assert.equal(result.truncated, true);
  });
});

describe('createGmailDigest.dispatch', () => {
  it('llama a notify con el texto y marca como leídos quitando UNREAD', async () => {
    const { api } = buildGmailStub({
      ids: ['m1', 'm2'],
      messages: {
        m1: { from: 'a', subject: 'A', date: '', snippet: '' },
        m2: { from: 'b', subject: 'B', date: '', snippet: '' },
      },
    });
    const labels = buildLabelsStub();
    const llm = fakeLlm('hola');
    const digest = createGmailDigest({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => api,
      gmailLabels: labels.client,
      llmService: llm,
    });
    /** @type {string[]} */
    const sent = [];
    const result = await digest.dispatch({
      query: 'q',
      notify: async (text) => { sent.push(text); },
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Digest de estudio/);
    assert.equal(result.count, 2);
    assert.equal(result.notified, true);
    assert.equal(result.markedAsRead, 2);
    assert.deepEqual(
      labels.calls.removeLabels.map((c) => c.messageId).sort(),
      ['m1', 'm2'],
    );
    // Y siempre quita UNREAD, sólo UNREAD
    for (const c of labels.calls.removeLabels) {
      assert.deepEqual(c.labelIds, ['UNREAD']);
    }
  });

  it('si notify falla, NO marca como leídos y propaga el error', async () => {
    const { api } = buildGmailStub({
      ids: ['m1'],
      messages: { m1: { from: 'a', subject: 'A', date: '', snippet: '' } },
    });
    const labels = buildLabelsStub();
    const digest = createGmailDigest({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => api,
      gmailLabels: labels.client,
    });
    await assert.rejects(
      digest.dispatch({
        query: 'q',
        notify: async () => { throw new Error('telegram caído'); },
      }),
      /telegram/,
    );
    assert.equal(labels.calls.removeLabels.length, 0);
  });

  it('si no hay correos, devuelve count=0 sin llamar a notify', async () => {
    const { api } = buildGmailStub({ ids: [] });
    const labels = buildLabelsStub();
    const digest = createGmailDigest({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => api,
      gmailLabels: labels.client,
    });
    let called = 0;
    const result = await digest.dispatch({
      query: 'q',
      notify: async () => { called += 1; },
    });
    assert.equal(called, 0);
    assert.equal(result.count, 0);
    assert.equal(result.notified, false);
    assert.equal(result.markedAsRead, 0);
  });

  it('markAsRead=false → notifica pero NO toca labels', async () => {
    const { api } = buildGmailStub({
      ids: ['m1'],
      messages: { m1: { from: 'a', subject: 'A', date: '', snippet: '' } },
    });
    const labels = buildLabelsStub();
    const digest = createGmailDigest({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => api,
      gmailLabels: labels.client,
    });
    await digest.dispatch({
      query: 'q',
      markAsRead: false,
      notify: async () => {},
    });
    assert.equal(labels.calls.removeLabels.length, 0);
  });
});

describe('scheduleDaily', () => {
  function fakeScheduler() {
    const delays = [];
    return {
      scheduler: {
        delay(task, ms) {
          delays.push({ task, ms });
          return { cancel() {} };
        },
        schedule() { return { stop() {} }; },
        stopAll() {},
      },
      delays,
    };
  }

  it('arma el delay inicial al próximo HH:MM local (si aún no ha pasado, hoy)', () => {
    const fakeNow = new Date(2026, 5, 2, 6, 0, 0); // 06:00
    const { scheduler, delays } = fakeScheduler();
    scheduleDaily({
      scheduler,
      hour: 8,
      minute: 30,
      run: () => {},
      nowFn: () => fakeNow,
    });
    assert.equal(delays.length, 1);
    // 2h 30m = 9000000 ms
    assert.equal(delays[0].ms, 2 * 60 * 60 * 1000 + 30 * 60 * 1000);
  });

  it('si HH:MM ya pasó hoy, programa para mañana', () => {
    const fakeNow = new Date(2026, 5, 2, 10, 0, 0); // 10:00
    const { scheduler, delays } = fakeScheduler();
    scheduleDaily({
      scheduler,
      hour: 8,
      minute: 30,
      run: () => {},
      nowFn: () => fakeNow,
    });
    // 24h - 1h30m = 22h30m
    const expected = (22 * 60 + 30) * 60 * 1000;
    assert.equal(delays[0].ms, expected);
  });
});
