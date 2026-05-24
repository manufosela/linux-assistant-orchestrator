import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInboxReader } from '../../../src/modules/inbox/inbox-reader.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'luis-inbox-reader-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function seedExtractedFile(content) {
  const dir = join(tmpDir, 'item');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'extracted.md');
  await writeFile(path, content, 'utf8');
  return path;
}

function mockQuery({ byId = null, latest = null } = {}) {
  return {
    findById: async () => byId,
    findLatestWithExtraction: async () => latest,
  };
}

function mockLlm(summary) {
  return { generateText: async () => summary };
}

describe('inbox-reader.read', () => {
  it('por id → devuelve el texto extraído', async () => {
    const path = await seedExtractedFile('# Artículo\n\nContenido completo');
    const item = { id: 'a1b2c3d4', dir: '/tmp/item', meta: { extraction: { path } } };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: mockLlm(''),
    });

    const result = await reader.read({ id: 'a1b2c3d4' });

    assert.equal(result.item, item);
    assert.match(result.text, /Contenido completo/);
    assert.equal(result.reason, null);
  });

  it('sin id → usa findLatestWithExtraction', async () => {
    const path = await seedExtractedFile('texto reciente');
    const item = { id: 'b', dir: '/tmp', meta: { extraction: { path } } };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ latest: item }),
      llmService: mockLlm(''),
    });

    const result = await reader.read();

    assert.match(result.text, /texto reciente/);
  });

  it('item no encontrado → reason="no-item"', async () => {
    const reader = createInboxReader({
      inboxQuery: mockQuery(),
      llmService: mockLlm(''),
    });

    const result = await reader.read({ id: 'nope' });

    assert.equal(result.item, null);
    assert.equal(result.reason, 'no-item');
  });

  it('item sin extraction → reason="no-extraction"', async () => {
    const item = { id: 'a', dir: '/tmp', meta: {} };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: mockLlm(''),
    });

    const result = await reader.read({ id: 'a' });

    assert.equal(result.text, null);
    assert.equal(result.reason, 'no-extraction');
  });

  it('extracted.md no se puede leer → reason="read-failed: ..."', async () => {
    const item = {
      id: 'a',
      dir: '/tmp',
      meta: { extraction: { path: '/nonexistent/path.md' } },
    };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: mockLlm(''),
    });

    const result = await reader.read({ id: 'a' });

    assert.equal(result.text, null);
    assert.match(result.reason, /read-failed/);
  });
});

describe('inbox-reader.summarise', () => {
  it('texto disponible → llama al LLM y devuelve el resumen', async () => {
    const path = await seedExtractedFile('Un texto largo que hay que resumir bla bla bla.');
    const item = { id: 'a', dir: '/tmp', meta: { extraction: { path } } };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: mockLlm('Resumen del texto en 3 frases.'),
    });

    const result = await reader.summarise({ id: 'a' });

    assert.equal(result.summary, 'Resumen del texto en 3 frases.');
    assert.match(result.text, /bla bla bla/);
  });

  it('trunca texto largo a maxInputChars', async () => {
    let passedPrompt = null;
    const longText = 'x'.repeat(20000);
    const path = await seedExtractedFile(longText);
    const item = { id: 'a', dir: '/tmp', meta: { extraction: { path } } };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: { generateText: async (prompt) => { passedPrompt = prompt; return 'resumen'; } },
    });

    await reader.summarise({ id: 'a', maxInputChars: 100 });

    // Prompt includes "Texto a resumir:\n\n" + 100 chars of 'x'
    assert.ok(passedPrompt.length < 200);
  });

  it('LLM lanza → summary null + reason="llm-failed"', async () => {
    const path = await seedExtractedFile('texto');
    const item = { id: 'a', dir: '/tmp', meta: { extraction: { path } } };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: { generateText: async () => { throw new Error('LLM down'); } },
    });

    const result = await reader.summarise({ id: 'a' });

    assert.equal(result.summary, null);
    assert.match(result.reason, /llm-failed.*LLM down/);
  });

  it('item no encontrado → propaga reason no-item, no llama al LLM', async () => {
    let called = false;
    const reader = createInboxReader({
      inboxQuery: mockQuery(),
      llmService: { generateText: async () => { called = true; return 'x'; } },
    });

    const result = await reader.summarise({ id: 'x' });

    assert.equal(result.reason, 'no-item');
    assert.equal(called, false);
  });
});

describe('inbox-reader constructor', () => {
  it('lanza sin inboxQuery', () => {
    assert.throws(() => createInboxReader({ llmService: {} }), /inboxQuery/);
  });
  it('lanza sin llmService', () => {
    assert.throws(() => createInboxReader({ inboxQuery: {} }), /llmService/);
  });
});
