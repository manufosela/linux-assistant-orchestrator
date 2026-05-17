import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseClusterIntent } from '../../../src/modules/cluster/cluster-intent.js';

describe('parseClusterIntent', () => {
  describe('status', () => {
    const cases = [
      'estado del cluster',
      'status cluster',
      'cómo está el cluster',
      'cluster',
      'salud del cluster',
      'monitor del cluster',
    ];
    for (const input of cases) {
      it(`detecta "${input}" como status`, () => {
        const r = parseClusterIntent(input);
        assert.ok(r, `expected intent for "${input}"`);
        assert.equal(r.kind, 'status');
      });
    }
  });

  describe('history', () => {
    const cases = [
      'historial del cluster',
      'histórico del cluster',
      'incidencias del cluster',
      'cluster caidas',
    ];
    for (const input of cases) {
      it(`detecta "${input}" como history`, () => {
        const r = parseClusterIntent(input);
        assert.ok(r);
        assert.equal(r.kind, 'history');
      });
    }
  });

  describe('no aplica', () => {
    for (const input of ['hola', 'qué tiempo hace', 'enciende la luz', '']) {
      it(`ignora "${input}"`, () => {
        assert.equal(parseClusterIntent(input), null);
      });
    }
  });
});
