import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDigestConfigStore } from '../../../src/modules/email/digest-config-store.js';

describe('createDigestConfigStore', () => {
  /** @type {string} */
  let tmp;
  let statePath;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'luis-digest-config-'));
    statePath = join(tmp, 'state.json');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('sin fichero, get() devuelve los defaults normalizados', async () => {
    const store = createDigestConfigStore({
      statePath,
      defaults: { listLabels: ['INBOX', 'inbox', '  Trabajo  '], summaryLabels: ['Estudio'] },
    });
    const cfg = await store.get();
    // dedup case-insensitive y trim
    assert.deepEqual(cfg.listLabels, ['INBOX', 'Trabajo']);
    assert.deepEqual(cfg.summaryLabels, ['Estudio']);
  });

  it('si el fichero existe, anula los defaults', async () => {
    await writeFile(statePath, JSON.stringify({ listLabels: ['A'], summaryLabels: ['B'] }));
    const store = createDigestConfigStore({
      statePath,
      defaults: { listLabels: ['DEFAULT'], summaryLabels: ['OTRO'] },
    });
    const cfg = await store.get();
    assert.deepEqual(cfg.listLabels, ['A']);
    assert.deepEqual(cfg.summaryLabels, ['B']);
  });

  it('addLabel: añade y persiste', async () => {
    const store = createDigestConfigStore({ statePath });
    const res = await store.addLabel('list', 'INBOX');
    assert.equal(res.changed, true);
    assert.deepEqual(res.config.listLabels, ['INBOX']);
    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    assert.deepEqual(persisted.listLabels, ['INBOX']);
  });

  it('addLabel: idempotente case-insensitive', async () => {
    const store = createDigestConfigStore({ statePath, defaults: { listLabels: ['inbox'] } });
    const res = await store.addLabel('list', 'INBOX');
    assert.equal(res.changed, false, 'no debe cambiar nada');
    assert.deepEqual(res.config.listLabels, ['inbox']);
  });

  it('removeLabel: quita y persiste', async () => {
    const store = createDigestConfigStore({ statePath });
    await store.addLabel('list', 'A');
    await store.addLabel('list', 'B');
    const res = await store.removeLabel('list', 'a');
    assert.equal(res.changed, true);
    assert.deepEqual(res.config.listLabels, ['B']);
  });

  it('removeLabel: idempotente si no estaba', async () => {
    const store = createDigestConfigStore({ statePath });
    const res = await store.removeLabel('summary', 'Nope');
    assert.equal(res.changed, false);
    assert.deepEqual(res.config.summaryLabels, []);
  });

  it('clear: vacía un canal', async () => {
    const store = createDigestConfigStore({ statePath });
    await store.addLabel('summary', 'X');
    await store.addLabel('summary', 'Y');
    const res = await store.clear('summary');
    assert.equal(res.changed, true);
    assert.deepEqual(res.config.summaryLabels, []);
    assert.deepEqual(res.config.listLabels, []);
  });

  it('rechaza canal inválido', async () => {
    const store = createDigestConfigStore({ statePath });
    await assert.rejects(store.addLabel('wat', 'X'), /Canal inválido/);
    await assert.rejects(store.removeLabel('wat', 'X'), /Canal inválido/);
    await assert.rejects(store.clear('wat'), /Canal inválido/);
  });

  it('rechaza label vacío', async () => {
    const store = createDigestConfigStore({ statePath });
    await assert.rejects(store.addLabel('list', '   '), /nombre/);
    await assert.rejects(store.removeLabel('list', ''), /nombre/);
  });

  it('canales independientes: tocar list no afecta summary', async () => {
    const store = createDigestConfigStore({
      statePath,
      defaults: { listLabels: ['L1'], summaryLabels: ['S1'] },
    });
    await store.addLabel('list', 'L2');
    const cfg = await store.get();
    assert.deepEqual(cfg.listLabels, ['L1', 'L2']);
    assert.deepEqual(cfg.summaryLabels, ['S1']);
  });
});
