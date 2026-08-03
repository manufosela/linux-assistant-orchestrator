import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptSummariser, chunkText } from '../../../src/modules/summarisation/transcript-summariser.js';

function fakeLlm({ collect } = {}) {
  return {
    generateText: async (prompt, opts) => {
      collect?.push({ prompt, opts });
      return `[summary of ${prompt.length} chars]`;
    },
  };
}

describe('createTranscriptSummariser', () => {
  it('requires llmService', () => {
    assert.throws(() => createTranscriptSummariser({}), /llmService/);
  });

  it('texto vacío → devuelve "" (no llama al LLM)', async () => {
    const calls = [];
    const s = createTranscriptSummariser({ llmService: fakeLlm({ collect: calls }) });
    assert.equal(await s.summarise(''), '');
    assert.equal(calls.length, 0);
  });

  it('texto corto: 1 sola llamada con prompt final', async () => {
    const calls = [];
    const s = createTranscriptSummariser({ llmService: fakeLlm({ collect: calls }), chunkChars: 100 });
    await s.summarise('palabras cortas');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.operation, 'summary-final');
    assert.match(calls[0].prompt, /Resume el siguiente texto en es/);
  });

  it('texto largo: chunkea, resume cada chunk como "parcial" y luego un "final"', async () => {
    const calls = [];
    const s = createTranscriptSummariser({ llmService: fakeLlm({ collect: calls }), chunkChars: 20 });
    const longText = 'frase a. '.repeat(20); // 180 chars
    await s.summarise(longText);
    const partials = calls.filter((c) => c.opts.operation === 'summary-chunk');
    const finals = calls.filter((c) => c.opts.operation === 'summary-final');
    assert.ok(partials.length >= 2, 'al menos 2 chunks');
    assert.equal(finals.length, 1);
  });

  it('respeta el idioma y el título en el prompt', async () => {
    const calls = [];
    const s = createTranscriptSummariser({ llmService: fakeLlm({ collect: calls }) });
    await s.summarise('hola', { language: 'en', title: 'Mi reunión' });
    assert.match(calls[0].prompt, /Resume el siguiente texto en en/);
    assert.match(calls[0].prompt, /Título: Mi reunión/);
  });

  it('marca private:true y module configurable en las opciones del LLM', async () => {
    const calls = [];
    const s = createTranscriptSummariser({ llmService: fakeLlm({ collect: calls }), module: 'media' });
    await s.summarise('hola');
    assert.equal(calls[0].opts.module, 'media');
    assert.equal(calls[0].opts.private, true);
  });
});

describe('chunkText', () => {
  it('texto más corto que maxChars → un solo chunk', () => {
    const chunks = chunkText('hola mundo', 100);
    assert.deepEqual(chunks, ['hola mundo']);
  });

  it('corta por fin de frase si está en la segunda mitad del chunk', () => {
    const text = 'Frase uno. Frase dos. Frase tres. Frase cuatro.';
    const chunks = chunkText(text, 25);
    assert.ok(chunks.every((c) => c.length <= 25 + 10), 'chunks no se desbocan');
    assert.ok(chunks[0].endsWith('.'));
  });

  it('texto sin puntos: corta a maxChars exactos', () => {
    const text = 'a'.repeat(100);
    const chunks = chunkText(text, 30);
    assert.equal(chunks.length, 4);  // 30+30+30+10
    assert.equal(chunks[0].length, 30);
  });
});

describe('createTranscriptSummariser — modelo y progreso (LUI-BUG-0013 / LUI-TSK-0090)', () => {
  it('pasa el model configurado en las opciones del LLM', async () => {
    const calls = [];
    const s = createTranscriptSummariser({ llmService: fakeLlm({ collect: calls }), model: 'coder' });
    await s.summarise('hola');
    assert.equal(calls[0].opts.model, 'coder');
  });

  it('sin model configurado NO añade la opción model (usa el default del provider)', async () => {
    const calls = [];
    const s = createTranscriptSummariser({ llmService: fakeLlm({ collect: calls }) });
    await s.summarise('hola');
    assert.equal('model' in calls[0].opts, false);
  });

  it('emite onProgress por cada chunk con index/total y el finalising', async () => {
    const progress = [];
    const s = createTranscriptSummariser({ llmService: fakeLlm({}), chunkChars: 20 });
    const longText = 'frase a. '.repeat(20);
    await s.summarise(longText, { onProgress: (p) => progress.push(p) });
    assert.ok(progress.length >= 3, 'al menos un evento por chunk + el finalising');
    assert.equal(progress[0].index, 1);
    assert.ok(progress[0].total >= 2);
    assert.equal(progress.at(-1).finalising, true);
  });
});
