import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createInboxRouter } from '../../../src/modules/inbox/inbox-router.js';

function fakeLlm(response) {
  return { generateText: async () => response };
}

function failingLlm(message = 'boom') {
  return {
    generateText: async () => {
      throw new Error(message);
    },
  };
}

describe('inbox-router hard rules', () => {
  it('voice → voz sin tocar el LLM', async () => {
    let called = false;
    const llm = { generateText: async () => { called = true; return '{}'; } };
    const router = createInboxRouter({ llmService: llm });

    const result = await router.classify({ origin: { kind: 'voice' } });

    assert.equal(result.category, 'voz');
    assert.equal(result.confidence, 1);
    assert.equal(called, false, 'no debe invocar el LLM para voice');
  });

  it('audio → voz sin tocar el LLM', async () => {
    const llm = fakeLlm('{}');
    const router = createInboxRouter({ llmService: llm });

    const result = await router.classify({ origin: { kind: 'audio' } });

    assert.equal(result.category, 'voz');
  });

  it('foto sin caption → foto sin tocar el LLM', async () => {
    let called = false;
    const llm = { generateText: async () => { called = true; return '{}'; } };
    const router = createInboxRouter({ llmService: llm });

    const result = await router.classify({
      origin: { kind: 'photo' },
      mimeType: 'image/jpeg',
      fileName: 'foo.jpg',
    });

    assert.equal(result.category, 'foto');
    assert.equal(called, false);
  });

  it('foto con caption → SÍ llama al LLM (la caption manda)', async () => {
    let called = false;
    const llm = {
      generateText: async () => {
        called = true;
        return JSON.stringify({
          category: 'tarea',
          confidence: 0.9,
          reasoning: 'la caption pide una acción',
        });
      },
    };
    const router = createInboxRouter({ llmService: llm });

    const result = await router.classify({
      origin: { kind: 'photo' },
      textCaption: 'comprar SAI para pueblo',
    });

    assert.equal(called, true);
    assert.equal(result.category, 'tarea');
  });

  it('foto con caption en blanco/espacios → trata como sin caption', async () => {
    let called = false;
    const llm = { generateText: async () => { called = true; return '{}'; } };
    const router = createInboxRouter({ llmService: llm });

    const result = await router.classify({
      origin: { kind: 'photo' },
      textCaption: '   ',
    });

    assert.equal(result.category, 'foto');
    assert.equal(called, false);
  });
});

describe('inbox-router LLM classification', () => {
  it('parsea JSON limpio y devuelve la categoría', async () => {
    const llm = fakeLlm(JSON.stringify({
      category: 'idea',
      confidence: 0.85,
      reasoning: 'pensamiento libre',
    }));
    const router = createInboxRouter({ llmService: llm });

    const result = await router.classify({ textCaption: 'me apetece aprender Rust' });

    assert.equal(result.category, 'idea');
    assert.equal(result.confidence, 0.85);
    assert.equal(result.reasoning, 'pensamiento libre');
  });

  it('extrae JSON aunque venga envuelto en prosa', async () => {
    const llm = fakeLlm(
      'Aquí está mi respuesta:\n\n{"category":"documento","confidence":0.9,"reasoning":"PDF"}\n\nGracias.',
    );
    const router = createInboxRouter({ llmService: llm });

    const result = await router.classify({
      fileName: 'factura.pdf',
      mimeType: 'application/pdf',
    });

    assert.equal(result.category, 'documento');
  });

  it('normaliza categoría a minúsculas y sin espacios', async () => {
    const llm = fakeLlm('{"category":"  IDEA  ","confidence":0.9,"reasoning":"x"}');
    const router = createInboxRouter({ llmService: llm });

    const result = await router.classify({ textCaption: 'algo' });

    assert.equal(result.category, 'idea');
  });

  it('respuesta inparseable → revisar', async () => {
    const llm = fakeLlm('no tengo ni idea, lo siento');
    const router = createInboxRouter({ llmService: llm });

    const result = await router.classify({ textCaption: 'algo raro' });

    assert.equal(result.category, 'revisar');
    assert.equal(result.confidence, 0);
    assert.match(result.reasoning, /unparseable/);
  });

  it('categoría desconocida → revisar', async () => {
    const llm = fakeLlm('{"category":"foobar","confidence":0.9,"reasoning":"x"}');
    const router = createInboxRouter({ llmService: llm });

    const result = await router.classify({ textCaption: 'algo' });

    assert.equal(result.category, 'revisar');
    assert.match(result.reasoning, /unknown category/);
  });

  it('confidence baja → revisar aunque la categoría sea válida', async () => {
    const llm = fakeLlm('{"category":"idea","confidence":0.3,"reasoning":"no sé"}');
    const router = createInboxRouter({ llmService: llm, confidenceThreshold: 0.6 });

    const result = await router.classify({ textCaption: 'algo ambiguo' });

    assert.equal(result.category, 'revisar');
    assert.equal(result.confidence, 0.3);
    assert.equal(result.reasoning, 'no sé');
  });

  it('confidenceThreshold configurable: 0.2 deja pasar 0.3', async () => {
    const llm = fakeLlm('{"category":"idea","confidence":0.3,"reasoning":"x"}');
    const router = createInboxRouter({ llmService: llm, confidenceThreshold: 0.2 });

    const result = await router.classify({ textCaption: 'algo' });

    assert.equal(result.category, 'idea');
  });

  it('error del LLM → revisar con motivo', async () => {
    const llm = failingLlm('ECONNREFUSED');
    const router = createInboxRouter({ llmService: llm });

    const result = await router.classify({ textCaption: 'algo' });

    assert.equal(result.category, 'revisar');
    assert.match(result.reasoning, /ECONNREFUSED/);
  });
});

describe('inbox-router constructor', () => {
  it('lanza si falta llmService', () => {
    assert.throws(() => createInboxRouter({}), /llmService/);
  });
});
