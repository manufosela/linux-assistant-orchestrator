import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSummaryStore } from '../../../src/modules/email/summary-store.js';

describe('createSummaryStore', () => {
  let tmp;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'luis-summary-store-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('save() devuelve un shortId determinista (sha256 truncado) y persiste el JSON', async () => {
    const store = createSummaryStore({ dir: tmp });
    const id1 = await store.save({
      messageId: 'gmail_msg_1',
      labelName: 'Estudio',
      from: 'curso@x.com',
      subject: 'Nuevo curso',
      date: '',
      summary: 'Resumen breve.',
    });
    const id2 = await store.save({
      messageId: 'gmail_msg_1',
      labelName: 'Estudio',
      from: '',
      subject: '',
      date: '',
      summary: 'overwrite',
    });
    assert.equal(id1, id2, 'shortId determinista por messageId');
    assert.equal(id1.length, 8);
    const raw = JSON.parse(await readFile(join(tmp, `${id1}.json`), 'utf8'));
    assert.equal(raw.summary, 'overwrite');
  });

  it('get() devuelve el entry persistido', async () => {
    const store = createSummaryStore({ dir: tmp });
    const id = await store.save({
      messageId: 'A',
      labelName: 'L',
      from: 'f',
      subject: 's',
      date: 'd',
      summary: 'S',
    });
    const got = await store.get(id);
    assert.equal(got.summary, 'S');
    assert.equal(got.subject, 's');
  });

  it('get() devuelve null para id inválido o desconocido', async () => {
    const store = createSummaryStore({ dir: tmp });
    assert.equal(await store.get(''), null);
    assert.equal(await store.get('not-hex'), null);
    assert.equal(await store.get('abc'), null, 'demasiado corto');
    assert.equal(await store.get('aaaaaaaaaaaaaaaaaaaaaaa'), null, 'demasiado largo');
    assert.equal(await store.get('00000000'), null, '8 hex pero no existe');
  });

  it('get() devuelve null si el TTL ha expirado y borra el fichero', async () => {
    const store = createSummaryStore({ dir: tmp, ttlMs: 1000 });
    const id = await store.save({
      messageId: 'X',
      labelName: '',
      from: '',
      subject: '',
      date: '',
      summary: 'will expire',
    });
    // Backdate file mtime to 2 seconds ago
    const past = new Date(Date.now() - 2000);
    await utimes(join(tmp, `${id}.json`), past, past);
    const got = await store.get(id);
    assert.equal(got, null);
  });

  it('gc() elimina expirados', async () => {
    const store = createSummaryStore({ dir: tmp, ttlMs: 1000 });
    const idFresh = await store.save({
      messageId: 'fresh', labelName: '', from: '', subject: '', date: '', summary: '',
    });
    const idOld = await store.save({
      messageId: 'old', labelName: '', from: '', subject: '', date: '', summary: '',
    });
    const past = new Date(Date.now() - 5000);
    await utimes(join(tmp, `${idOld}.json`), past, past);
    const removed = await store.gc();
    assert.equal(removed, 1);
    assert.ok(await store.get(idFresh));
    assert.equal(await store.get(idOld), null);
  });

  it('shortId() es la misma función pública de hash', () => {
    const store = createSummaryStore({ dir: tmp });
    const a = store.shortId('foo');
    const b = store.shortId('foo');
    const c = store.shortId('bar');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(a.length, 8);
  });
});
