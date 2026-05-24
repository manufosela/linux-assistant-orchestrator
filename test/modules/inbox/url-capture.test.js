import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUrlCapture, isUrl, extractLeadingUrl } from '../../../src/modules/inbox/url-capture.js';
import { createInboxStore } from '../../../src/modules/inbox/inbox-store.js';

let tmpDir;
let inboxStore;
const fixedDate = new Date('2026-05-24T12:00:00Z');

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'luis-url-capture-'));
  inboxStore = createInboxStore({ inboxPath: tmpDir, now: () => fixedDate });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function fakeFetcher(result) {
  return { fetchUrl: async () => result };
}

function failingFetcher(message = 'boom') {
  return { fetchUrl: async () => { throw new Error(message); } };
}

describe('url-capture isUrl / extractLeadingUrl', () => {
  it('isUrl true para URL plana', () => {
    assert.equal(isUrl('https://example.com/x'), true);
    assert.equal(isUrl('  http://x.test '), true);
  });

  it('isUrl false para texto con URL en medio', () => {
    assert.equal(isUrl('mira esto: https://x'), false);
    assert.equal(isUrl(''), false);
    assert.equal(isUrl(null), false);
  });

  it('extractLeadingUrl extrae la URL al inicio (con texto opcional después)', () => {
    assert.equal(extractLeadingUrl('https://example.com/a?b=1 comentario'), 'https://example.com/a?b=1');
    assert.equal(extractLeadingUrl('  https://x.test/y  '), 'https://x.test/y');
  });

  it('extractLeadingUrl null si no empieza por URL', () => {
    assert.equal(extractLeadingUrl('hola https://x'), null);
    assert.equal(extractLeadingUrl(''), null);
  });
});

describe('url-capture.captureUrl', () => {
  it('escribe extracted.md, anota meta.classification y meta.extraction, marca routed', async () => {
    const urlFetcher = fakeFetcher({
      url: 'https://example.com/article',
      title: 'Mi artículo',
      text: 'palabra1 palabra2 palabra3',
      contentType: 'text/html',
    });
    const capture = createUrlCapture({ urlFetcher, inboxStore, now: () => fixedDate });

    const result = await capture.captureUrl('https://example.com/article', {
      type: 'telegram', chatId: 1, messageId: 99, kind: 'url',
    });

    assert.equal(result.title, 'Mi artículo');
    assert.equal(result.words, 3);
    assert.match(result.extractedPath, /extracted\.md$/);

    const extracted = await readFile(result.extractedPath, 'utf8');
    assert.match(extracted, /# Mi artículo/);
    assert.match(extracted, /palabra1 palabra2 palabra3/);
    assert.match(extracted, /Fuente: https:\/\/example\.com\/article/);

    const meta = JSON.parse(await readFile(join(result.item.dir, 'meta.json'), 'utf8'));
    assert.equal(meta.classification.category, 'estudio');
    assert.equal(meta.classification.confidence, 1);
    assert.equal(meta.extraction.words, 3);
    assert.equal(meta.extraction.title, 'Mi artículo');
    assert.equal(meta.extraction.source, 'urlFetcher');
    assert.equal(meta.status, 'routed');
    assert.match(meta.routedTo, /^extracted:/);
    assert.equal(meta.origin.url, 'https://example.com/article');
  });

  it('respeta finalUrl si urlFetcher siguió redirects', async () => {
    const urlFetcher = fakeFetcher({
      url: 'https://example.com/final',
      title: 'T',
      text: 'x',
    });
    const capture = createUrlCapture({ urlFetcher, inboxStore, now: () => fixedDate });

    const result = await capture.captureUrl('https://example.com/short', { type: 'telegram' });

    assert.equal(result.finalUrl, 'https://example.com/final');
  });

  it('si fetched.text está vacío, escribe placeholder', async () => {
    const urlFetcher = fakeFetcher({ url: 'https://x.test', title: '', text: '' });
    const capture = createUrlCapture({ urlFetcher, inboxStore, now: () => fixedDate });

    const result = await capture.captureUrl('https://x.test', { type: 'telegram' });
    const extracted = await readFile(result.extractedPath, 'utf8');

    assert.match(extracted, /sin contenido extraído/);
    assert.equal(result.words, 0);
  });

  it('lanza si la URL no es válida (antes de tocar urlFetcher)', async () => {
    let called = false;
    const urlFetcher = { fetchUrl: async () => { called = true; return null; } };
    const capture = createUrlCapture({ urlFetcher, inboxStore });

    await assert.rejects(() => capture.captureUrl('no-soy-url', {}), /valid URL/);
    assert.equal(called, false);
  });

  it('propaga error de urlFetcher (sin crear item en inbox)', async () => {
    const capture = createUrlCapture({ urlFetcher: failingFetcher('SSRF blocked'), inboxStore });

    await assert.rejects(
      () => capture.captureUrl('https://192.168.1.1/x', { type: 'telegram' }),
      /SSRF blocked/,
    );
    // No item dir should have been created
    const items = await inboxStore.list();
    assert.equal(items.length, 0);
  });
});

describe('url-capture constructor', () => {
  it('lanza si falta urlFetcher', () => {
    assert.throws(() => createUrlCapture({ inboxStore: {} }), /urlFetcher/);
  });
  it('lanza si falta inboxStore', () => {
    assert.throws(() => createUrlCapture({ urlFetcher: {} }), /inboxStore/);
  });
});
