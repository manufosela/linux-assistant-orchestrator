import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCalendarIntent } from '../../../src/modules/calendar/calendar-intent.js';

describe('parseCalendarIntent', () => {
  describe('intent today', () => {
    const cases = [
      'agenda de hoy',
      'qué tengo hoy en la agenda',
      'qué tengo hoy',
      'qué hay hoy',
      'eventos de hoy',
      'reuniones de hoy',
      'citas de hoy',
      'mi agenda',
      'que hay en mi agenda',
    ];
    for (const input of cases) {
      it(`detecta "${input}" como today`, () => {
        const r = parseCalendarIntent(input);
        assert.ok(r, `expected intent for "${input}"`);
        assert.equal(r.intent, 'today');
      });
    }
  });

  describe('intent tomorrow', () => {
    const cases = [
      'agenda de mañana',
      'qué tengo mañana',
      'eventos mañana',
      'reuniones de mañana',
      'citas mañana',
      'qué hay mañana en la agenda',
    ];
    for (const input of cases) {
      it(`detecta "${input}" como tomorrow`, () => {
        const r = parseCalendarIntent(input);
        assert.ok(r);
        assert.equal(r.intent, 'tomorrow');
      });
    }
  });

  describe('intent week', () => {
    const cases = [
      'agenda de la semana',
      'agenda esta semana',
      'qué tengo esta semana',
      'eventos de la semana',
      'reuniones esta semana',
    ];
    for (const input of cases) {
      it(`detecta "${input}" como week`, () => {
        const r = parseCalendarIntent(input);
        assert.ok(r);
        assert.equal(r.intent, 'week');
      });
    }
  });

  describe('intent next', () => {
    const cases = [
      'próxima reunión',
      'proximo evento',
      'siguiente cita',
      'cuándo es mi próxima reunión',
      'cuál es mi siguiente evento',
    ];
    for (const input of cases) {
      it(`detecta "${input}" como next`, () => {
        const r = parseCalendarIntent(input);
        assert.ok(r);
        assert.equal(r.intent, 'next');
      });
    }
  });

  describe('no intent', () => {
    const cases = [
      '',
      '   ',
      'hola',
      'qué hora es',
      'temperatura del salón',
      'cuéntame un chiste',
      'enciende la luz',
    ];
    for (const input of cases) {
      it(`devuelve null para "${input}"`, () => {
        assert.equal(parseCalendarIntent(input), null);
      });
    }

    it('null y undefined seguros', () => {
      assert.equal(parseCalendarIntent(null), null);
      assert.equal(parseCalendarIntent(undefined), null);
    });
  });

  describe('priority cases', () => {
    it('"próxima reunión esta semana" → next (gana sobre week)', () => {
      const r = parseCalendarIntent('próxima reunión esta semana');
      assert.equal(r?.intent, 'next');
    });

    it('"agenda mañana esta semana" → tomorrow (mañana específico gana)', () => {
      const r = parseCalendarIntent('agenda mañana');
      assert.equal(r?.intent, 'tomorrow');
    });
  });
});
