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
  // 'foto' moved to its own suite (OCR flow, TSK-0053).
  for (const category of ['voz', 'revisar']) {
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

describe('inbox-processor — documento/estudio (Markitdown)', () => {
  function fakeMarkitdown({ text = '# Doc\n\ntexto extraído', title = 'Doc Title' } = {}) {
    return { convertFile: async () => ({ text, title, filename: 'foo.pdf' }) };
  }

  it('documento → llama a markitdown, escribe extracted.md, anota meta.extraction', async () => {
    const item = makeItem({ fileName: 'foo.pdf' });
    await seedMeta(item);
    await writeFile(join(item.dir, 'foo.pdf'), 'PDF BYTES');
    const router = fakeRouter({ category: 'documento', confidence: 0.9, reasoning: 'PDF' });
    const store = fakeInboxStore();
    const proc = createInboxProcessor({
      router, inboxStore: store, notesPath: notesDir,
      markitdownClient: fakeMarkitdown(),
      now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'extracted-documento');
    assert.equal(store.calls.markRouted.length, 0); // still pending Drive
    const extracted = await readFile(join(item.dir, 'extracted.md'), 'utf8');
    assert.match(extracted, /texto extraído/);
    const meta = JSON.parse(await readFile(join(item.dir, 'meta.json'), 'utf8'));
    assert.equal(meta.extraction.title, 'Doc Title');
    assert.ok(meta.extraction.words > 0);
    assert.equal(meta.extraction.at, fixedDate.toISOString());
  });

  it('estudio → mismo flujo que documento', async () => {
    const item = makeItem({ fileName: 'paper.pdf' });
    await seedMeta(item);
    await writeFile(join(item.dir, 'paper.pdf'), 'PDF');
    const router = fakeRouter({ category: 'estudio', confidence: 0.9, reasoning: 'paper' });
    const proc = createInboxProcessor({
      router, inboxStore: fakeInboxStore(), notesPath: notesDir,
      markitdownClient: fakeMarkitdown({ text: 'lorem ipsum' }),
      now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'extracted-estudio');
  });

  it('sin markitdownClient → fallback a pending sin extraer', async () => {
    const item = makeItem({ fileName: 'foo.pdf' });
    await seedMeta(item);
    const router = fakeRouter({ category: 'documento', confidence: 0.9, reasoning: 'r' });
    const proc = createInboxProcessor({
      router, inboxStore: fakeInboxStore(), notesPath: notesDir,
      now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'pending-documento');
    await assert.rejects(() => stat(join(item.dir, 'extracted.md')));
  });

  it('item documento sin fichero adjunto → pending sin tocar markitdown', async () => {
    const item = makeItem({ fileName: null });
    await seedMeta(item);
    let called = false;
    const md = { convertFile: async () => { called = true; return { text: 'x', title: null }; } };
    const router = fakeRouter({ category: 'documento', confidence: 0.9, reasoning: 'r' });
    const proc = createInboxProcessor({
      router, inboxStore: fakeInboxStore(), notesPath: notesDir,
      markitdownClient: md, now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'pending-documento');
    assert.equal(called, false);
  });

  it('markitdown falla + sin Drive → graceful fallback (pending), no marca error', async () => {
    const item = makeItem({ fileName: 'foo.pdf' });
    await seedMeta(item);
    await writeFile(join(item.dir, 'foo.pdf'), 'PDF');
    const md = { convertFile: async () => { throw new Error('sidecar 500'); } };
    const router = fakeRouter({ category: 'documento', confidence: 0.9, reasoning: 'r' });
    const store = fakeInboxStore();
    const proc = createInboxProcessor({
      router, inboxStore: store, notesPath: notesDir,
      markitdownClient: md, now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    // Markitdown falló pero sin Drive configurado: queda pending genérico.
    assert.equal(result.action.kind, 'pending-documento');
    assert.equal(store.calls.markError.length, 0);
    assert.equal(store.calls.markRouted.length, 0);
  });
});

describe('inbox-processor — foto con OCR (TSK-0053)', () => {
  function fakeOcr({ text = '', title = null } = {}) {
    return { convertFile: async () => ({ text, title, filename: 'photo.jpg' }) };
  }

  it('foto sin markitdownClient → pending sin OCR (comportamiento previo)', async () => {
    const item = makeItem({ kind: 'photo', fileName: 'photo.jpg' });
    await seedMeta(item);
    const router = fakeRouter({ category: 'foto', confidence: 1, reasoning: 'hard-rule' });
    const proc = createInboxProcessor({
      router, inboxStore: fakeInboxStore(), notesPath: notesDir,
      now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'pending-foto');
    await assert.rejects(() => stat(join(item.dir, 'extracted.md')));
  });

  it('foto + OCR >50 palabras → reclasifica a documento, escribe extracted.md', async () => {
    const item = makeItem({ kind: 'photo', fileName: 'screenshot.jpg' });
    await seedMeta(item);
    await writeFile(join(item.dir, 'screenshot.jpg'), 'JPG BYTES');
    const longText = Array.from({ length: 80 }, (_, i) => `palabra${i}`).join(' ');
    const router = fakeRouter({ category: 'foto', confidence: 1, reasoning: 'hard-rule' });
    const proc = createInboxProcessor({
      router, inboxStore: fakeInboxStore(), notesPath: notesDir,
      markitdownClient: fakeOcr({ text: longText, title: 'Article Title' }),
      now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    // Sin driveClient configurado: queda como extracted-documento, no uploaded
    assert.equal(result.action.kind, 'extracted-documento');
    assert.match(result.action.message, /reclasificado desde foto/);
    const meta = JSON.parse(await readFile(join(item.dir, 'meta.json'), 'utf8'));
    assert.equal(meta.classification.category, 'documento');
    assert.equal(meta.classification.overriddenFrom, 'foto');
    assert.match(meta.classification.reasoning, /OCR detectó 80 palabras/);
    assert.equal(meta.extraction.source, 'ocr');
    assert.equal(meta.extraction.words, 80);
    const extracted = await readFile(join(item.dir, 'extracted.md'), 'utf8');
    assert.match(extracted, /palabra0 palabra1/);
  });

  it('foto + OCR <50 palabras → se queda como foto, sin extracted.md', async () => {
    const item = makeItem({ kind: 'photo', fileName: 'photo.jpg' });
    await seedMeta(item);
    await writeFile(join(item.dir, 'photo.jpg'), 'JPG');
    const router = fakeRouter({ category: 'foto', confidence: 1, reasoning: 'hard-rule' });
    const proc = createInboxProcessor({
      router, inboxStore: fakeInboxStore(), notesPath: notesDir,
      markitdownClient: fakeOcr({ text: 'tres palabras solo' }),
      now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'pending-foto');
    assert.match(result.action.message, /solo 3 palabras/);
    const meta = JSON.parse(await readFile(join(item.dir, 'meta.json'), 'utf8'));
    assert.equal(meta.classification.category, 'foto');
    assert.equal(meta.extraction.source, 'ocr-no-text');
    assert.equal(meta.extraction.path, null);
    await assert.rejects(() => stat(join(item.dir, 'extracted.md')));
  });

  it('foto + OCR sin texto → "sin texto OCR"', async () => {
    const item = makeItem({ kind: 'photo', fileName: 'sunset.jpg' });
    await seedMeta(item);
    await writeFile(join(item.dir, 'sunset.jpg'), 'JPG');
    const router = fakeRouter({ category: 'foto', confidence: 1, reasoning: 'hard-rule' });
    const proc = createInboxProcessor({
      router, inboxStore: fakeInboxStore(), notesPath: notesDir,
      markitdownClient: fakeOcr({ text: '' }),
      now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.match(result.action.message, /sin texto OCR/);
  });

  it('foto + markitdown lanza → graceful fallback (pending-foto, sin error)', async () => {
    const item = makeItem({ kind: 'photo', fileName: 'foto.jpg' });
    await seedMeta(item);
    await writeFile(join(item.dir, 'foto.jpg'), 'JPG');
    const md = { convertFile: async () => { throw new Error('tesseract crashed'); } };
    const store = fakeInboxStore();
    const proc = createInboxProcessor({
      router: fakeRouter({ category: 'foto', confidence: 1, reasoning: 'r' }),
      inboxStore: store, notesPath: notesDir,
      markitdownClient: md, now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'pending-foto');
    assert.equal(store.calls.markError.length, 0);
    assert.match(result.action.message, /OCR falló.*tesseract crashed/);
  });

  it('foto sin fileName → pending sin tocar markitdown', async () => {
    const item = makeItem({ kind: 'photo', fileName: null });
    await seedMeta(item);
    let called = false;
    const md = { convertFile: async () => { called = true; return { text: 'x' }; } };
    const proc = createInboxProcessor({
      router: fakeRouter({ category: 'foto', confidence: 1, reasoning: 'r' }),
      inboxStore: fakeInboxStore(), notesPath: notesDir,
      markitdownClient: md, now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'pending-foto');
    assert.equal(called, false);
  });
});

describe('inbox-processor — subida a Drive (TSK-0049)', () => {
  function fakeDrive(uploadResult = null) {
    const calls = [];
    return {
      calls,
      uploadFile: async (path, opts) => {
        calls.push({ path, opts });
        return uploadResult ?? {
          id: 'drive-id-' + calls.length,
          name: opts.name,
          webViewLink: `https://drive.google.com/file/d/drive-id-${calls.length}/view`,
          mimeType: opts.mimeType,
          parents: [opts.folderId],
        };
      },
    };
  }

  function fakeMd(text = '# doc\n\ntexto extraído') {
    return { convertFile: async () => ({ text, title: 'T', filename: 'foo.pdf' }) };
  }

  it('documento + markitdown OK + Drive configurado → sube original + extracted, markRouted', async () => {
    const item = makeItem({ kind: 'document', fileName: 'foo.pdf' });
    await seedMeta(item);
    await writeFile(join(item.dir, 'foo.pdf'), 'PDF');
    const router = fakeRouter({ category: 'documento', confidence: 0.9, reasoning: 'PDF' });
    const store = fakeInboxStore();
    const drive = fakeDrive();
    const proc = createInboxProcessor({
      router, inboxStore: store, notesPath: notesDir,
      markitdownClient: fakeMd(),
      driveClient: drive, driveInboxFolderId: 'FOLDER123',
      now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'uploaded-documento');
    assert.equal(store.calls.markRouted.length, 1);
    assert.match(store.calls.markRouted[0].routedTo, /^drive:/);
    assert.equal(drive.calls.length, 2); // original + extracted.md
    assert.equal(drive.calls[0].opts.folderId, 'FOLDER123');
    assert.equal(drive.calls[0].opts.name, 'foo.pdf');
    assert.match(drive.calls[1].opts.name, /-extracted\.md$/);
    const meta = JSON.parse(await readFile(join(item.dir, 'meta.json'), 'utf8'));
    assert.equal(meta.drive.uploads.length, 2);
  });

  it('foto con OCR >50 + Drive → reclasificada a documento, sube imagen + extracted', async () => {
    const item = makeItem({ kind: 'photo', fileName: 'pic.jpg' });
    await seedMeta(item);
    await writeFile(join(item.dir, 'pic.jpg'), 'JPG');
    const longText = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    const drive = fakeDrive();
    const proc = createInboxProcessor({
      router: fakeRouter({ category: 'foto', confidence: 1, reasoning: 'r' }),
      inboxStore: fakeInboxStore(), notesPath: notesDir,
      markitdownClient: fakeMd(longText),
      driveClient: drive, driveInboxFolderId: 'F',
      now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'uploaded-documento');
    assert.match(result.action.message, /reclasificado desde foto/);
    assert.equal(drive.calls.length, 2);
  });

  it('foto sin OCR (texto corto) + Drive → sube solo la imagen como foto', async () => {
    const item = makeItem({ kind: 'photo', fileName: 'sunset.jpg' });
    await seedMeta(item);
    await writeFile(join(item.dir, 'sunset.jpg'), 'JPG');
    const drive = fakeDrive();
    const proc = createInboxProcessor({
      router: fakeRouter({ category: 'foto', confidence: 1, reasoning: 'r' }),
      inboxStore: fakeInboxStore(), notesPath: notesDir,
      markitdownClient: fakeMd('cuatro palabras solamente aqui'),
      driveClient: drive, driveInboxFolderId: 'F',
      now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'uploaded-foto');
    assert.equal(drive.calls.length, 1);
    assert.equal(drive.calls[0].opts.name, 'sunset.jpg');
  });

  it('Drive sin configurar → mantiene comportamiento previo (extracted/pending)', async () => {
    const item = makeItem({ kind: 'document', fileName: 'foo.pdf' });
    await seedMeta(item);
    await writeFile(join(item.dir, 'foo.pdf'), 'PDF');
    const proc = createInboxProcessor({
      router: fakeRouter({ category: 'documento', confidence: 0.9, reasoning: 'r' }),
      inboxStore: fakeInboxStore(), notesPath: notesDir,
      markitdownClient: fakeMd(),
      driveClient: null, driveInboxFolderId: null,
      now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'extracted-documento');
    assert.match(result.action.message, /pendiente Drive/);
  });

  it('Drive falla (404, auth, etc.) → kind=upload-failed, queda pending', async () => {
    const item = makeItem({ kind: 'document', fileName: 'foo.pdf' });
    await seedMeta(item);
    await writeFile(join(item.dir, 'foo.pdf'), 'PDF');
    const drive = { uploadFile: async () => { throw new Error('Drive 403 forbidden'); } };
    const store = fakeInboxStore();
    const proc = createInboxProcessor({
      router: fakeRouter({ category: 'documento', confidence: 0.9, reasoning: 'r' }),
      inboxStore: store, notesPath: notesDir,
      markitdownClient: fakeMd(),
      driveClient: drive, driveInboxFolderId: 'F',
      now: () => fixedDate,
    });

    const result = await proc.processItem(item);

    assert.equal(result.action.kind, 'documento-upload-failed');
    assert.equal(store.calls.markRouted.length, 0);
    assert.equal(store.calls.markError.length, 0); // graceful, no error mark
    assert.match(result.action.message, /Drive falló.*403/);
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
