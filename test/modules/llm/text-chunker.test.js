import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../../../src/modules/llm/text-chunker.js';

describe('chunkText', () => {
  it('texto vacío → []', () => {
    assert.deepEqual(chunkText('', 100), []);
    assert.deepEqual(chunkText(null, 100), []);
    assert.deepEqual(chunkText(undefined, 100), []);
  });

  it('texto corto: un solo chunk', () => {
    assert.deepEqual(chunkText('hola mundo', 100), ['hola mundo']);
  });

  it('respeta fin de frase si está dentro del 50% final del chunk', () => {
    const text = 'Frase uno corta. Frase dos. ' + 'X'.repeat(50);
    const chunks = chunkText(text, 40);
    assert.ok(chunks[0].endsWith('.'), `esperado terminar con punto, got: "${chunks[0]}"`);
    assert.ok(chunks.length >= 2);
  });

  it('corta al límite si no hay fin de frase cerca', () => {
    const text = 'X'.repeat(200);
    const chunks = chunkText(text, 50);
    assert.equal(chunks.length, 4);
    assert.equal(chunks[0].length, 50);
  });

  it('descarta chunks vacíos tras trim', () => {
    const chunks = chunkText('hola.   .   mundo', 1000);
    assert.equal(chunks.length, 1);
  });

  it('maxChars inválido → throw', () => {
    assert.throws(() => chunkText('hola', 0), /positive number/);
    assert.throws(() => chunkText('hola', -1), /positive number/);
    assert.throws(() => chunkText('hola', NaN), /positive number/);
  });

  it('soporta interrogación y exclamación como límite de frase', () => {
    const text = '¿Cuál es la capital? Madrid. ' + 'X'.repeat(50);
    const chunks = chunkText(text, 40);
    assert.ok(chunks[0].endsWith('.') || chunks[0].endsWith('?'));
  });
});
