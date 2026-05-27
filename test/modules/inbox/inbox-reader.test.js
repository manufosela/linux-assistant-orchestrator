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
  return { chat: async () => summary };
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

  it('texto largo → chunking (varias llamadas al LLM) en vez de truncar', async () => {
    const longText = 'frase. '.repeat(3000); // ~21000 chars
    const path = await seedExtractedFile(longText);
    const item = { id: 'a', dir: '/tmp', meta: { extraction: { path } } };
    const operations = [];
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: {
        chat: async (_msgs, opts) => {
          operations.push(opts.operation);
          return opts.operation === 'summarise-final' ? 'RESUMEN_FINAL' : 'parcial';
        },
      },
      summaryChunkChars: 8000,
    });

    const result = await reader.summarise({ id: 'a' });

    assert.ok(operations.length > 1, 'esperaba >1 llamada al LLM al chunkear');
    assert.ok(operations.includes('summarise-chunk'));
    assert.equal(operations[operations.length - 1], 'summarise-final');
    assert.equal(result.summary, 'RESUMEN_FINAL');
  });

  it('idioma por defecto (es) aparece en system y user prompts', async () => {
    let captured = null;
    const path = await seedExtractedFile('Some English text about a topic.');
    const item = { id: 'a', dir: '/tmp', meta: { extraction: { path } } };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: { chat: async (msgs) => { captured = msgs; return 'resumen'; } },
    });

    await reader.summarise({ id: 'a' });

    const system = captured.find((m) => m.role === 'system').content;
    const user = captured.find((m) => m.role === 'user').content;
    assert.match(system, /SIEMPRE escribe en es/);
    assert.match(system, /DEBE estar en es/);
    assert.match(user, /DEBE estar en es/);
  });

  it('summaryLanguage override (en) se inyecta en los prompts', async () => {
    let captured = null;
    const path = await seedExtractedFile('texto en español');
    const item = { id: 'a', dir: '/tmp', meta: { extraction: { path } } };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: { chat: async (msgs) => { captured = msgs; return 'resumen'; } },
      summaryLanguage: 'en',
    });

    await reader.summarise({ id: 'a' });

    const system = captured.find((m) => m.role === 'system').content;
    const user = captured.find((m) => m.role === 'user').content;
    assert.match(system, /SIEMPRE escribe en en/);
    assert.match(user, /DEBE estar en en/);
  });

  it('en chunking, idioma se fuerza tanto en partial como en final', async () => {
    const longText = 'frase. '.repeat(3000);
    const path = await seedExtractedFile(longText);
    const item = { id: 'a', dir: '/tmp', meta: { extraction: { path } } };
    const systemPrompts = [];
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: {
        chat: async (msgs) => {
          systemPrompts.push(msgs.find((m) => m.role === 'system').content);
          return 'algo';
        },
      },
      summaryChunkChars: 8000,
      summaryLanguage: 'es',
    });

    await reader.summarise({ id: 'a' });

    assert.ok(systemPrompts.length > 1);
    for (const prompt of systemPrompts) {
      assert.match(prompt, /SIEMPRE escribe en es/);
      assert.match(prompt, /DEBE estar en es/);
    }
  });

  it('summariseModel override se pasa al llm', async () => {
    let passedOptions = null;
    const path = await seedExtractedFile('texto');
    const item = { id: 'a', dir: '/tmp', meta: { extraction: { path } } };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: { chat: async (_msgs, opts) => { passedOptions = opts; return 'resumen'; } },
      summariseModel: 'coder',
    });

    await reader.summarise({ id: 'a' });

    assert.equal(passedOptions.model, 'coder');
  });

  it('sin summariseModel override no se pasa model al llm', async () => {
    let passedOptions = null;
    const path = await seedExtractedFile('texto');
    const item = { id: 'a', dir: '/tmp', meta: { extraction: { path } } };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: { chat: async (_msgs, opts) => { passedOptions = opts; return 'resumen'; } },
    });

    await reader.summarise({ id: 'a' });

    assert.equal(passedOptions.model, undefined);
  });

  it('LLM devuelve string vacío → reason="llm-empty"', async () => {
    const path = await seedExtractedFile('texto');
    const item = { id: 'a', dir: '/tmp', meta: { extraction: { path } } };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: { chat: async () => '' },
    });

    const result = await reader.summarise({ id: 'a' });

    assert.equal(result.summary, null);
    assert.equal(result.reason, 'llm-empty');
  });

  it('LLM lanza → summary null + reason="llm-failed"', async () => {
    const path = await seedExtractedFile('texto');
    const item = { id: 'a', dir: '/tmp', meta: { extraction: { path } } };
    const reader = createInboxReader({
      inboxQuery: mockQuery({ byId: item }),
      llmService: { chat: async () => { throw new Error('LLM down'); } },
    });

    const result = await reader.summarise({ id: 'a' });

    assert.equal(result.summary, null);
    assert.match(result.reason, /llm-failed.*LLM down/);
  });

  it('item no encontrado → propaga reason no-item, no llama al LLM', async () => {
    let called = false;
    const reader = createInboxReader({
      inboxQuery: mockQuery(),
      llmService: { chat: async () => { called = true; return 'x'; } },
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
