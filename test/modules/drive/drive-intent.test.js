import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseDriveIntent } from '../../../src/modules/drive/drive-intent.js';

describe('parseDriveIntent — list-root', () => {
  for (const input of [
    'drive',
    'mi drive',
    'mi unidad',
    'que hay en drive',
    'qué hay en drive',
    'lista mi drive',
    'muéstrame drive',
    'enséñame mi unidad',
  ]) {
    it(`detecta "${input}" como list-root`, () => {
      const r = parseDriveIntent(input);
      assert.ok(r, `expected intent for "${input}"`);
      assert.equal(r.kind, 'list-root');
    });
  }
});

describe('parseDriveIntent — search', () => {
  it('detecta "busca facturas en drive"', () => {
    const r = parseDriveIntent('busca facturas en drive');
    assert.ok(r);
    assert.equal(r.kind, 'search');
    assert.equal(r.query, 'facturas');
  });

  it('detecta "buscar informe en mi drive"', () => {
    const r = parseDriveIntent('buscar informe en mi drive');
    assert.ok(r);
    assert.equal(r.kind, 'search');
    assert.equal(r.query, 'informe');
  });

  it('detecta "encuentra pdf de marzo en drive"', () => {
    const r = parseDriveIntent('encuentra pdf de marzo en drive');
    assert.ok(r);
    assert.equal(r.kind, 'search');
    assert.match(r.query, /pdf/);
  });
});

describe('parseDriveIntent — no aplica', () => {
  for (const input of [
    'hola',
    'que tiempo hace',
    'busca facturas',
    'estado del cluster',
    '',
  ]) {
    it(`ignora "${input}"`, () => {
      assert.equal(parseDriveIntent(input), null);
    });
  }
});
