import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseEmailIntent } from '../../../src/modules/email/email-intent.js';

describe('parseEmailIntent', () => {
  describe('intent today', () => {
    const cases = [
      'correo de hoy',
      'correos de hoy',
      'correos no leídos',
      'correos no leidos',
      'correos sin leer',
      'correos pendientes',
      'correos pendientes hoy',
      'correos nuevos',
      'qué correos tengo hoy',
      'mail de hoy',
      'mails de hoy',
      'mensajes de hoy',
      'que mensajes tengo',
      'tengo correos?',
    ];
    for (const input of cases) {
      it(`detecta "${input}" como today`, () => {
        const r = parseEmailIntent(input);
        assert.ok(r, `expected intent for "${input}"`);
        assert.equal(r.intent, 'today');
      });
    }
  });

  describe('intent from', () => {
    it('"correos de banco" → from sender=banco', () => {
      const r = parseEmailIntent('correos de banco');
      assert.ok(r);
      assert.equal(r.intent, 'from');
      assert.equal(r.sender, 'banco');
    });

    it('"correos de banco santander por favor" → from sender=banco santander', () => {
      const r = parseEmailIntent('correos de banco santander por favor');
      assert.ok(r);
      assert.equal(r.intent, 'from');
      assert.equal(r.sender, 'banco santander');
    });

    it('"correos de mi jefe" → from sender=mi jefe', () => {
      const r = parseEmailIntent('correos de mi jefe');
      assert.ok(r);
      assert.equal(r.intent, 'from');
      assert.equal(r.sender, 'mi jefe');
    });

    it('case-insensitive y sin acentos: "Correos de Daniel Fosela" → from', () => {
      const r = parseEmailIntent('Correos de Daniel Fosela');
      assert.ok(r);
      assert.equal(r.intent, 'from');
      assert.equal(r.sender, 'daniel fosela');
    });

    it('"correos de hoy" no se confunde con sender="hoy"', () => {
      const r = parseEmailIntent('correos de hoy');
      assert.equal(r?.intent, 'today');
    });
  });

  describe('no intent', () => {
    const cases = [
      '',
      '   ',
      'hola',
      'qué hora es',
      'pon música',
      'temperatura del salón',
      'tengo hambre',
      'cuéntame un chiste',
    ];
    for (const input of cases) {
      it(`devuelve null para "${input}"`, () => {
        assert.equal(parseEmailIntent(input), null);
      });
    }

    it('null y undefined seguros', () => {
      assert.equal(parseEmailIntent(null), null);
      assert.equal(parseEmailIntent(undefined), null);
    });
  });
});
