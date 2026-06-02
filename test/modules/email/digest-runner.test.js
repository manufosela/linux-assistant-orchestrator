import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDigestRunner } from '../../../src/modules/email/digest-runner.js';
import { createDigestLastRunStore } from '../../../src/modules/email/digest-last-run-store.js';

function buildGmailDigest({ resultsByQuery = {} } = {}) {
  const calls = { fetchList: [] };
  return {
    calls,
    digest: {
      async fetchList({ query, maxResults }) {
        calls.fetchList.push({ query, maxResults });
        return resultsByQuery[query] ?? { ids: [], emails: [], truncated: false };
      },
      async build() { throw new Error('not used'); },
      async dispatch() { throw new Error('not used'); },
    },
  };
}

function buildGmailLabels() {
  const calls = { removeLabels: [] };
  return {
    calls,
    client: {
      async removeLabels({ messageId, labelIds }) {
        calls.removeLabels.push({ messageId, labelIds });
      },
      async listLabels() { return []; },
      async findLabelByName() { return null; },
      async createLabel() { return null; },
      async ensureLabel() { return null; },
      async addLabels() {},
      async applyToQuery() { throw new Error('not used'); },
      async suggestLabel() { return null; },
    },
  };
}

describe('createDigestRunner.runListLabel', () => {
  let tmp;
  let store;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'luis-digest-runner-'));
    store = createDigestLastRunStore({ dir: tmp });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('primera vez (sin last-run previo) y sin correos → no envía, last-run vacío', async () => {
    const digest = buildGmailDigest();
    const labels = buildGmailLabels();
    const runner = createDigestRunner({
      gmailDigest: digest.digest,
      gmailLabels: labels.client,
      lastRunStore: store,
    });
    let notified = 0;
    const r = await runner.runListLabel({
      labelName: 'INBOX',
      notify: async () => { notified += 1; },
    });
    assert.equal(r.sent, false);
    assert.equal(r.count, 0);
    assert.equal(notified, 0);
    assert.equal(labels.calls.removeLabels.length, 0);
  });

  it('con correos: envía y guarda last-run', async () => {
    const digest = buildGmailDigest({
      resultsByQuery: {
        'is:unread label:Trabajo': {
          ids: ['m1', 'm2'],
          emails: [
            { id: 'm1', from: 'a@x.com', subject: 'A', date: '', snippet: '' },
            { id: 'm2', from: 'b@x.com', subject: 'B', date: '', snippet: '' },
          ],
          truncated: false,
        },
      },
    });
    const labels = buildGmailLabels();
    const runner = createDigestRunner({
      gmailDigest: digest.digest,
      gmailLabels: labels.client,
      lastRunStore: store,
    });
    const sent = [];
    const r = await runner.runListLabel({
      labelName: 'Trabajo',
      notify: async (t) => { sent.push(t); },
    });
    assert.equal(r.sent, true);
    assert.equal(r.count, 2);
    assert.deepEqual(r.ids, ['m1', 'm2']);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Trabajo/);
    assert.match(sent[0], /2 correos sin leer/);

    // last-run persistido
    const persisted = await store.read('Trabajo');
    assert.deepEqual(persisted.ids, ['m1', 'm2']);
  });

  it('día siguiente: marca como leídos los del envío anterior antes de fetch', async () => {
    // Pre-condición: ayer enviamos m1, m2 → guardado en store
    await store.write('Estudio', ['m1', 'm2'], '2026-06-01T08:30:00Z');

    const digest = buildGmailDigest({
      resultsByQuery: {
        'is:unread label:Estudio': {
          ids: ['m3'],
          emails: [{ id: 'm3', from: 'c@x.com', subject: 'C', date: '', snippet: '' }],
          truncated: false,
        },
      },
    });
    const labels = buildGmailLabels();
    const runner = createDigestRunner({
      gmailDigest: digest.digest,
      gmailLabels: labels.client,
      lastRunStore: store,
    });
    const r = await runner.runListLabel({
      labelName: 'Estudio',
      notify: async () => {},
    });
    // Marcó m1 y m2 como leídos (quitando UNREAD)
    assert.equal(r.markedAsRead, 2);
    assert.deepEqual(
      labels.calls.removeLabels.map((c) => c.messageId).sort(),
      ['m1', 'm2'],
    );
    // Y el last-run nuevo contiene m3
    const persisted = await store.read('Estudio');
    assert.deepEqual(persisted.ids, ['m3']);
  });

  it('si el mark-as-read falla para uno, sigue con los demás (no aborta)', async () => {
    await store.write('X', ['ok1', 'fail', 'ok2'], '');
    const digest = buildGmailDigest();
    const labels = buildGmailLabels();
    // override para que 'fail' lance
    labels.client.removeLabels = async ({ messageId, labelIds }) => {
      labels.calls.removeLabels.push({ messageId, labelIds });
      if (messageId === 'fail') throw new Error('not found');
    };
    const runner = createDigestRunner({
      gmailDigest: digest.digest,
      gmailLabels: labels.client,
      lastRunStore: store,
    });
    const r = await runner.runListLabel({
      labelName: 'X',
      notify: async () => {},
    });
    assert.equal(r.markedAsRead, 2, 'cuenta sólo los ok');
    assert.equal(labels.calls.removeLabels.length, 3, 'se intentaron los 3');
  });

  it('si notify falla: NO actualiza el last-run (reintento al día siguiente)', async () => {
    await store.write('Daily', ['old1'], '');
    const digest = buildGmailDigest({
      resultsByQuery: {
        'is:unread label:Daily': {
          ids: ['new1'],
          emails: [{ id: 'new1', from: 'x', subject: 'x', date: '', snippet: '' }],
          truncated: false,
        },
      },
    });
    const labels = buildGmailLabels();
    const runner = createDigestRunner({
      gmailDigest: digest.digest,
      gmailLabels: labels.client,
      lastRunStore: store,
    });
    await assert.rejects(
      runner.runListLabel({
        labelName: 'Daily',
        notify: async () => { throw new Error('telegram down'); },
      }),
      /telegram down/,
    );
    // Pero ya marcamos old1 como leído ANTES de notify
    assert.equal(labels.calls.removeLabels[0].messageId, 'old1');
    // El last-run NO se actualizó al nuevo, sigue siendo old1 (porque write ocurre después de notify)
    const persisted = await store.read('Daily');
    assert.deepEqual(persisted.ids, ['old1'],
      'last-run no debe actualizarse si la notificación falló');
  });

  it('labels con espacios: la query las entrecomilla', async () => {
    const digest = buildGmailDigest();
    const labels = buildGmailLabels();
    const runner = createDigestRunner({
      gmailDigest: digest.digest,
      gmailLabels: labels.client,
      lastRunStore: store,
    });
    await runner.runListLabel({ labelName: 'Mi Etiqueta', notify: async () => {} });
    assert.equal(digest.calls.fetchList[0].query, 'is:unread label:"Mi Etiqueta"');
  });
});

describe('createDigestRunner.runListChannel', () => {
  let tmp;
  let store;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'luis-digest-runner-batch-'));
    store = createDigestLastRunStore({ dir: tmp });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('procesa todas las etiquetas; si una falla, sigue con las demás', async () => {
    const digest = buildGmailDigest({
      resultsByQuery: {
        'is:unread label:OK': {
          ids: ['1'],
          emails: [{ id: '1', from: 'a', subject: 'a', date: '', snippet: '' }],
          truncated: false,
        },
        'is:unread label:FAIL': {
          ids: ['2'],
          emails: [{ id: '2', from: 'b', subject: 'b', date: '', snippet: '' }],
          truncated: false,
        },
      },
    });
    const labels = buildGmailLabels();
    const runner = createDigestRunner({
      gmailDigest: digest.digest,
      gmailLabels: labels.client,
      lastRunStore: store,
    });
    const sent = [];
    const notify = async (text) => {
      if (text.includes('FAIL')) throw new Error('telegram banned this label');
      sent.push(text);
    };
    const results = await runner.runListChannel({
      listLabels: ['OK', 'FAIL'],
      notify,
    });
    assert.equal(results.length, 2);
    assert.equal(results[0].sent, true);
    assert.equal(results[1].sent, false);
    assert.match(results[1].error, /banned/);
    assert.equal(sent.length, 1, 'sólo la OK llega');
  });
});
