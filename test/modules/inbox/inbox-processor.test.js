import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInboxProcessor } from '../../../src/modules/inbox/inbox-processor.js';

let tmpDir;
let notesDir;
let itemDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'luis-inbox-proc-'));
  notesDir = join(tmpDir, 'notes');
  itemDir = join(tmpDir, 'inbox', '2026-05-24', 'abc-id');
  await mkdir(itemDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeItem({ textCaption = null, kind = 'photo', fileName = null } = {}) {
  return {
    id: 'abc-id',
    dir: itemDir,
    meta: {
      id: 'abc-id',
      receivedAt: '2026-05-24T10:00:00Z',
      status: 'pending',
      origin: { type: 'telegram', chatId: 1, kind },
      mimeType: 'image/jpeg',
      fileName,
      textCaption,
    },
  };
}

function fakeRouter(classification) {
  return { classify: async () => classification };
}

function fakeInboxStore() {
  const calls = { markRouted: [], markError: [] };
  return {
    calls,
    markRouted: async (id, routedTo) => { calls.markRouted.push({ id, routedTo }); },
    markError: async (id, error) => { calls.markError.push({ id, error }); },
  };
}

async function seedMeta(item) {
  await writeFile(join(item.dir, 'meta.json'), JSON.stringify(item.meta, null, 2), 'utf8');
}

const fixedDate = new Date('2026-05-24T12:00:00Z');

describe('inbox-processor — idea / tarea', () => {
  it('idea → escribe note.md con párrafo y marca routed', async () => {
    const item = makeItem({ textCaption: 'aprender Rust en un mes' });
    await seedMeta(item);
    const router = fakeRouter({ category: 'idea', confidence: 0.9, reasoning: 'observación' });
    const store = fakeInboxStore();
    const proc = createInboxProcessor({ router, inboxStore: store, notesPath: notesDir, now: () => fixedDate });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'idea');
    assert.equal(store.calls.markRouted.length, 1);
    assert.match(store.calls.markRouted[0].routedTo, /^note:/);
    const noteContent = await readFile(join(notesDir, '2026-05-24', 'abc-id.md'), 'utf8');
    assert.match(noteContent, /# Idea/);
    assert.match(noteContent, /aprender Rust/);
    assert.doesNotMatch(noteContent, /\[ \]/); // sin checkbox
  });

  it('tarea → escribe note.md con checkbox', async () => {
    const item = makeItem({ textCaption: 'comprar SAI para pueblo' });
    await seedMeta(item);
    const router = fakeRouter({ category: 'tarea', confidence: 0.95, reasoning: 'acción' });
    const store = fakeInboxStore();
    const proc = createInboxProcessor({ router, inboxStore: store, notesPath: notesDir, now: () => fixedDate });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'tarea');
    const noteContent = await readFile(join(notesDir, '2026-05-24', 'abc-id.md'), 'utf8');
    assert.match(noteContent, /# Tarea/);
    assert.match(noteContent, /- \[ \] comprar SAI/);
  });

  it('nota incluye referencia al fichero adjunto cuando existe', async () => {
    const item = makeItem({ textCaption: 'factura del SAI', fileName: 'factura.pdf' });
    await seedMeta(item);
    const router = fakeRouter({ category: 'idea', confidence: 0.9, reasoning: 'x' });
    const proc = createInboxProcessor({
      router, inboxStore: fakeInboxStore(), notesPath: notesDir, now: () => fixedDate,
    });

    await proc.processItem(item);

    const noteContent = await readFile(join(notesDir, '2026-05-24', 'abc-id.md'), 'utf8');
    assert.match(noteContent, /adjunto:.*factura\.pdf/);
  });
});

describe('inbox-processor — descartar', () => {
  it('descartar → markRouted con routedTo=discarded, sin escribir nota', async () => {
    const item = makeItem();
    await seedMeta(item);
    const router = fakeRouter({ category: 'descartar', confidence: 0.99, reasoning: 'ruido' });
    const store = fakeInboxStore();
    const proc = createInboxProcessor({ router, inboxStore: store, notesPath: notesDir, now: () => fixedDate });

    await proc.processItem(item);

    assert.equal(store.calls.markRouted.length, 1);
    assert.equal(store.calls.markRouted[0].routedTo, 'discarded');
    await assert.rejects(() => stat(join(notesDir, '2026-05-24', 'abc-id.md')));
  });
});

describe('inbox-processor — categorías pendientes de cards posteriores', () => {
  for (const category of ['voz', 'foto', 'documento', 'estudio', 'revisar']) {
    it(`${category} → no markRouted, no fichero, solo annotation`, async () => {
      const item = makeItem();
      await seedMeta(item);
      const router = fakeRouter({ category, confidence: 0.9, reasoning: 'x' });
      const store = fakeInboxStore();
      const proc = createInboxProcessor({ router, inboxStore: store, notesPath: notesDir, now: () => fixedDate });

      const result = await proc.processItem(item);

      assert.equal(result.classification.category, category);
      assert.equal(store.calls.markRouted.length, 0);
      const meta = JSON.parse(await readFile(join(item.dir, 'meta.json'), 'utf8'));
      assert.equal(meta.classification.category, category);
      assert.equal(meta.classification.confidence, 0.9);
    });
  }
});

describe('inbox-processor — annotation', () => {
  it('meta.json mantiene campos previos y añade classification', async () => {
    const item = makeItem({ textCaption: 'idea cualquiera' });
    await seedMeta(item);
    const router = fakeRouter({ category: 'idea', confidence: 0.9, reasoning: 'r' });
    const proc = createInboxProcessor({
      router, inboxStore: fakeInboxStore(), notesPath: notesDir, now: () => fixedDate,
    });

    await proc.processItem(item);

    const meta = JSON.parse(await readFile(join(item.dir, 'meta.json'), 'utf8'));
    assert.equal(meta.origin.type, 'telegram');
    assert.equal(meta.textCaption, 'idea cualquiera');
    assert.equal(meta.classification.category, 'idea');
    assert.equal(meta.classification.at, fixedDate.toISOString());
  });
});

describe('inbox-processor — errores', () => {
  it('router lanza → markError, classification null', async () => {
    const item = makeItem();
    await seedMeta(item);
    const router = { classify: async () => { throw new Error('llm down'); } };
    const store = fakeInboxStore();
    const proc = createInboxProcessor({ router, inboxStore: store, notesPath: notesDir, now: () => fixedDate });

    const result = await proc.processItem(item);

    assert.equal(result.classification, null);
    assert.equal(store.calls.markError.length, 1);
    assert.match(store.calls.markError[0].error, /llm down/);
  });

  it('writeFile falla (notesPath bajo un fichero) → markError', async () => {
    const item = makeItem({ textCaption: 'algo' });
    await seedMeta(item);
    const masqueradingFile = join(tmpDir, 'not-a-dir');
    await writeFile(masqueradingFile, 'soy un fichero');
    const router = fakeRouter({ category: 'idea', confidence: 0.9, reasoning: 'r' });
    const store = fakeInboxStore();
    const proc = createInboxProcessor({
      router, inboxStore: store,
      notesPath: join(masqueradingFile, 'imposible'),
      now: () => fixedDate,
    });

    await proc.processItem(item);

    assert.equal(store.calls.markError.length, 1);
    assert.equal(store.calls.markRouted.length, 0);
  });
});

describe('inbox-processor — constructor', () => {
  it('lanza si falta router', () => {
    assert.throws(() => createInboxProcessor({ inboxStore: {}, notesPath: '/tmp' }), /router/);
  });
  it('lanza si falta inboxStore', () => {
    assert.throws(() => createInboxProcessor({ router: {}, notesPath: '/tmp' }), /inboxStore/);
  });
  it('lanza si falta notesPath', () => {
    assert.throws(() => createInboxProcessor({ router: {}, inboxStore: {} }), /notesPath/);
  });
});
