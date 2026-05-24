import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInboxQuery } from '../../../src/modules/inbox/inbox-query.js';
import { createInboxStore } from '../../../src/modules/inbox/inbox-store.js';

let tmpDir;
let store;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'luis-inbox-query-'));
  store = createInboxStore({ inboxPath: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Seed an item with custom meta (overriding fields like classification, receivedAt).
 */
async function seedItem({ receivedAt, classification, extraction, textCaption = null, fileName = null }) {
  const item = await store.add({
    origin: { type: 'telegram' },
    textCaption,
    fileName,
    mimeType: 'image/jpeg',
  });
  const meta = { ...item.meta, receivedAt };
  if (classification) meta.classification = classification;
  if (extraction) meta.extraction = extraction;
  await writeFile(join(item.dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { ...item, meta };
}

describe('inbox-query.query', () => {
  it('lista todos los items sin filtros', async () => {
    await seedItem({ receivedAt: '2026-05-24T10:00:00Z' });
    await seedItem({ receivedAt: '2026-05-23T10:00:00Z' });
    const q = createInboxQuery({ inboxStore: store });

    const results = await q.query();

    assert.equal(results.length, 2);
  });

  it('filtra por rango since/until', async () => {
    await seedItem({ receivedAt: '2026-05-24T10:00:00Z' });
    await seedItem({ receivedAt: '2026-05-20T10:00:00Z' });
    const q = createInboxQuery({ inboxStore: store });

    const results = await q.query({
      since: new Date('2026-05-22T00:00:00Z'),
      until: new Date('2026-05-25T00:00:00Z'),
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].meta.receivedAt, '2026-05-24T10:00:00Z');
  });

  it('filtra por categorías', async () => {
    await seedItem({ receivedAt: '2026-05-24T10:00:00Z', classification: { category: 'idea' } });
    await seedItem({ receivedAt: '2026-05-24T11:00:00Z', classification: { category: 'tarea' } });
    await seedItem({ receivedAt: '2026-05-24T12:00:00Z', classification: { category: 'foto' } });
    const q = createInboxQuery({ inboxStore: store });

    const results = await q.query({ categories: ['idea', 'tarea'] });

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => ['idea', 'tarea'].includes(r.meta.classification.category)));
  });

  it('ordena por receivedAt desc', async () => {
    await seedItem({ receivedAt: '2026-05-24T08:00:00Z', textCaption: 'a' });
    await seedItem({ receivedAt: '2026-05-24T18:00:00Z', textCaption: 'c' });
    await seedItem({ receivedAt: '2026-05-24T13:00:00Z', textCaption: 'b' });
    const q = createInboxQuery({ inboxStore: store });

    const results = await q.query();

    assert.equal(results[0].meta.textCaption, 'c');
    assert.equal(results[1].meta.textCaption, 'b');
    assert.equal(results[2].meta.textCaption, 'a');
  });

  it('incluye preview leyendo extracted.md cuando existe', async () => {
    const item = await seedItem({
      receivedAt: '2026-05-24T10:00:00Z',
      classification: { category: 'estudio' },
    });
    const extractedPath = join(item.dir, 'extracted.md');
    await writeFile(extractedPath,
      '# Título\n\n> Fuente: url\n\nEste es el contenido del artículo que se debería mostrar en el preview.',
      'utf8');
    // Update meta to point to extraction
    await writeFile(join(item.dir, 'meta.json'),
      JSON.stringify({ ...item.meta, extraction: { path: extractedPath, words: 12 } }, null, 2),
      'utf8');
    const q = createInboxQuery({ inboxStore: store });

    const results = await q.query();

    assert.match(results[0].preview, /Este es el contenido/);
    assert.doesNotMatch(results[0].preview, /^#/); // no debe incluir el título
  });

  it('preview null si no hay extraction', async () => {
    await seedItem({ receivedAt: '2026-05-24T10:00:00Z' });
    const q = createInboxQuery({ inboxStore: store });

    const results = await q.query();

    assert.equal(results[0].preview, null);
  });

  it('previewMaxChars trunca correctamente', async () => {
    const item = await seedItem({ receivedAt: '2026-05-24T10:00:00Z' });
    const extractedPath = join(item.dir, 'extracted.md');
    await writeFile(extractedPath, 'a'.repeat(500), 'utf8');
    await writeFile(join(item.dir, 'meta.json'),
      JSON.stringify({ ...item.meta, extraction: { path: extractedPath } }, null, 2),
      'utf8');
    const q = createInboxQuery({ inboxStore: store });

    const results = await q.query({ previewMaxChars: 50 });

    assert.equal(results[0].preview.length, 50);
  });

  it('includePreview=false → preview null aunque exista extracted.md', async () => {
    const item = await seedItem({ receivedAt: '2026-05-24T10:00:00Z' });
    const extractedPath = join(item.dir, 'extracted.md');
    await writeFile(extractedPath, 'contenido', 'utf8');
    await writeFile(join(item.dir, 'meta.json'),
      JSON.stringify({ ...item.meta, extraction: { path: extractedPath } }, null, 2),
      'utf8');
    const q = createInboxQuery({ inboxStore: store });

    const results = await q.query({ includePreview: false });

    assert.equal(results[0].preview, null);
  });

  it('constructor lanza sin inboxStore', () => {
    assert.throws(() => createInboxQuery({}), /inboxStore/);
  });
});
