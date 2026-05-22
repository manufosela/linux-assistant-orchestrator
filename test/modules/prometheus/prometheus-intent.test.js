import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parsePrometheusIntent } from '../../../src/modules/prometheus/prometheus-intent.js';

describe('parsePrometheusIntent', () => {
  describe('detecta una consulta de caídas', () => {
    const cases = [
      '¿hay algo caído?',
      'hay algo caido',
      'se ha caído algún servicio',
      '¿está todo bien?',
      'está todo ok',
      '¿todo funcionando?',
      'estado de los servicios',
      '¿algún servicio caído?',
      'mira prometheus',
      '¿hay alertas activas?',
      'algo offline',
    ];
    for (const input of cases) {
      it(`detecta "${input}"`, () => {
        const result = parsePrometheusIntent(input);
        assert.ok(result, `expected intent for "${input}"`);
        assert.equal(result.kind, 'down-check');
      });
    }
  });

  describe('no aplica', () => {
    const cases = [
      'hola',
      'qué tiempo hace',
      'enciende la luz del salón',
      'estado del cluster',
      'cómo está el cluster',
      'ponme música',
      '',
    ];
    for (const input of cases) {
      it(`ignora "${input}"`, () => {
        assert.equal(parsePrometheusIntent(input), null);
      });
    }
  });

  it('no secuestra las preguntas del cluster', () => {
    assert.equal(parsePrometheusIntent('¿se ha caído el cluster?'), null);
  });
});
