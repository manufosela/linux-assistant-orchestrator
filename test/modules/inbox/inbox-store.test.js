import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInboxStore } from '../../../src/modules/inbox/inbox-store.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'luis-inbox-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('inboxStore.add', () => {
  it('crea estructura YYYY-MM-DD/<uuid>/meta.json sin fichero adjunto', async () => {
    const fixedDate = new Date('2026-05-24T10:30:00Z');
    const store = createInboxStore({ inboxPath: tmpDir, now: () => fixedDate });

    const item = await store.add({
      origin: { type: 'telegram', chatId: 37272 },
      textCaption: 'nota suelta',
    });

    assert.match(item.dir, /2026-05-24/);
    assert.equal(item.meta.status, 'pending');
    assert.equal(item.meta.textCaption, 'nota suelta');
    assert.equal(item.meta.fileName, null);
    const written = JSON.parse(await readFile(join(item.dir, 'meta.json'), 'utf8'));
    assert.equal(written.id, item.id);
    assert.equal(written.origin.chatId, 37272);
  });

  it('descarga el fichero adjunto via callback y persiste fileName', async () => {
    const store = createInboxStore({ inboxPath: tmpDir });
    const item = await store.add({
      origin: { type: 'telegram' },
      mimeType: 'application/pdf',
      fileName: 'factura.pdf',
      downloadFileTo: async (target) => {
        await writeFile(target, 'PDF FAKE CONTENT');
      },
    });
    assert.equal(item.meta.fileName, 'factura.pdf');
    const filePath = join(item.dir, 'factura.pdf');
    const fileStat = await stat(filePath);
    assert.ok(fileStat.size > 0);
  });

  it('lanza si falta origin', async () => {
    const store = createInboxStore({ inboxPath: tmpDir });
    await assert.rejects(() => store.add({}), /origin/);
  });
});

describe('inboxStore.list + markRouted/markError', () => {
  it('lista items recién creados como pending y filtra por status', async () => {
    const store = createInboxStore({ inboxPath: tmpDir });
    const a = await store.add({ origin: { type: 't' } });
    const b = await store.add({ origin: { type: 't' } });

    let items = await store.list();
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.meta.status === 'pending'));

    await store.markRouted(a.id, 'notes/2026-05-24');
    items = await store.list({ status: 'routed' });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, a.id);
    assert.equal(items[0].meta.routedTo, 'notes/2026-05-24');

    items = await store.list({ status: 'pending' });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, b.id);
  });

  it('markError marca status error con mensaje', async () => {
    const store = createInboxStore({ inboxPath: tmpDir });
    const item = await store.add({ origin: { type: 't' } });
    await store.markError(item.id, 'algo salió mal');

    const items = await store.list({ status: 'error' });
    assert.equal(items.length, 1);
    assert.equal(items[0].meta.error, 'algo salió mal');
  });

  it('markRouted con id desconocido lanza', async () => {
    const store = createInboxStore({ inboxPath: tmpDir });
    await assert.rejects(() => store.markRouted('no-existe', 'x'), /not found/);
  });
});
