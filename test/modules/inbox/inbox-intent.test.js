import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseInboxIntent, parseInboxReadIntent } from '../../../src/modules/inbox/inbox-intent.js';

const NOW = new Date('2026-05-24T15:00:00Z');
const now = () => NOW;

describe('inbox-intent triggers', () => {
  const matches = [
    '/inbox',
    'inbox',
    '/inbox hoy',
    'inbox de la semana',
    'qué guardaste hoy?',
    'que he guardado esta semana',
    'qué tengo guardado',
    'muestra mis notas',
    'muéstrame las ideas de hoy',
    'mis estudios',
    'mis fotos de hoy',
    'mis tareas',
    'qué documentos tengo en el inbox',
  ];

  for (const text of matches) {
    it(`detecta "${text}"`, () => {
      const intent = parseInboxIntent(text, { now });
      assert.ok(intent, `esperaba detectar "${text}"`);
      assert.equal(intent.kind, 'inbox-query');
    });
  }

  const nonMatches = [
    'hola',
    'cuál es la capital de Francia',
    'estado del cluster',
    'agenda de hoy',
    'correos de hoy',
    'busca facturas en drive',
    'no me digas nada',
  ];

  for (const text of nonMatches) {
    it(`NO detecta "${text}"`, () => {
      assert.equal(parseInboxIntent(text, { now }), null);
    });
  }
});

describe('inbox-intent time ranges', () => {
  it('"hoy" → desde 00:00 del día actual', () => {
    const intent = parseInboxIntent('inbox hoy', { now });
    assert.equal(intent.label, 'hoy');
    assert.equal(intent.since.getUTCFullYear(), 2026);
    // since debería ser 2026-05-24 00:00 local (local-day boundary)
    assert.ok(intent.since.getTime() <= NOW.getTime());
  });

  it('"ayer" → ayer 00:00 hasta hoy 00:00', () => {
    const intent = parseInboxIntent('qué guardé ayer', { now });
    assert.equal(intent.label, 'ayer');
    assert.ok(intent.until !== null);
  });

  it('"esta semana" → últimos 7 días', () => {
    const intent = parseInboxIntent('mis notas de esta semana', { now });
    assert.equal(intent.label, 'esta semana');
    const diffDays = (NOW.getTime() - intent.since.getTime()) / (24 * 60 * 60 * 1000);
    assert.ok(diffDays >= 6 && diffDays <= 8, `esperaba ~7 días, dió ${diffDays}`);
  });

  it('"este mes" → últimos 30 días', () => {
    const intent = parseInboxIntent('mis fotos del mes', { now });
    assert.equal(intent.label, 'este mes');
  });

  it('"todo" → desde epoch', () => {
    const intent = parseInboxIntent('muestra todo el inbox', { now });
    assert.equal(intent.label, 'todo el historial');
    assert.equal(intent.since.getTime(), 0);
  });

  it('sin modifier → últimos 7 días (default)', () => {
    const intent = parseInboxIntent('qué guardaste', { now });
    assert.equal(intent.label, 'últimos 7 días');
  });
});

describe('parseInboxReadIntent', () => {
  it('"lee el último" → inbox-read sin id', () => {
    const intent = parseInboxReadIntent('lee el último');
    assert.equal(intent.kind, 'inbox-read');
    assert.equal(intent.id, null);
  });

  it('"abre <id>" → inbox-read con id', () => {
    const intent = parseInboxReadIntent('abre a1b2c3d4');
    assert.equal(intent.kind, 'inbox-read');
    assert.equal(intent.id, 'a1b2c3d4');
  });

  it('"resume el último estudio" → inbox-summarise con categoría', () => {
    const intent = parseInboxReadIntent('resume el último estudio');
    assert.equal(intent.kind, 'inbox-summarise');
    assert.deepEqual(intent.categories, ['estudio']);
  });

  it('"resúmeme lo último" → inbox-summarise', () => {
    const intent = parseInboxReadIntent('resúmeme lo último');
    assert.equal(intent.kind, 'inbox-summarise');
  });

  it('"qué dice el último documento" → inbox-summarise + documento', () => {
    const intent = parseInboxReadIntent('qué dice el último documento');
    assert.equal(intent.kind, 'inbox-summarise');
    assert.deepEqual(intent.categories, ['documento']);
  });

  it('"hola" → null', () => {
    assert.equal(parseInboxReadIntent('hola'), null);
  });

  it('"qué guardaste hoy" → null (es inbox-query, no read)', () => {
    assert.equal(parseInboxReadIntent('qué guardaste hoy'), null);
  });
});

describe('inbox-intent categorías', () => {
  it('"notas" → idea + tarea', () => {
    const intent = parseInboxIntent('muestra mis notas', { now });
    assert.deepEqual(intent.categories.sort(), ['idea', 'tarea']);
  });

  it('"estudios" → estudio', () => {
    const intent = parseInboxIntent('mis estudios', { now });
    assert.deepEqual(intent.categories, ['estudio']);
  });

  it('"documentos" → documento', () => {
    const intent = parseInboxIntent('mis documentos', { now });
    assert.deepEqual(intent.categories, ['documento']);
  });

  it('"fotos" → foto', () => {
    const intent = parseInboxIntent('mis fotos', { now });
    assert.deepEqual(intent.categories, ['foto']);
  });

  it('"voces" → voz', () => {
    const intent = parseInboxIntent('mis grabaciones', { now });
    assert.deepEqual(intent.categories, ['voz']);
  });

  it('"ideas y tareas" → idea + tarea', () => {
    const intent = parseInboxIntent('mis ideas y tareas', { now });
    assert.deepEqual(intent.categories.sort(), ['idea', 'tarea']);
  });

  it('"/inbox" sin categoría → null (todas)', () => {
    const intent = parseInboxIntent('/inbox', { now });
    assert.equal(intent.categories, null);
  });
});
