import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatInboxResults } from '../../../src/modules/inbox/inbox-formatter.js';

function mkItem({ id = 'abc12345-de', category = 'idea', caption = 'algo', words = null, preview = null, hour = '10' } = {}) {
  return {
    id,
    dir: '/tmp/x',
    preview,
    meta: {
      id,
      receivedAt: `2026-05-24T${hour}:30:00Z`,
      status: 'routed',
      textCaption: caption,
      classification: category ? { category } : null,
      extraction: words ? { words } : null,
    },
  };
}

describe('inbox-formatter', () => {
  it('inbox vacío → mensaje placeholder', () => {
    const result = formatInboxResults([], { label: 'hoy' });
    assert.match(result, /Inbox.*hoy/);
    assert.match(result, /Nada guardado/);
  });

  it('agrupa items por categoría con emoji + contador', () => {
    const items = [
      mkItem({ id: 'a', category: 'idea', caption: 'aprender Rust' }),
      mkItem({ id: 'b', category: 'idea', caption: 'leer Bezos' }),
      mkItem({ id: 'c', category: 'tarea', caption: 'comprar SAI' }),
      mkItem({ id: 'd', category: 'foto', caption: 'recibo' }),
    ];
    const out = formatInboxResults(items, { label: 'hoy' });

    assert.match(out, /💡 <b>idea<\/b> \(2\)/);
    assert.match(out, /✅ <b>tarea<\/b> \(1\)/);
    assert.match(out, /🖼️ <b>foto<\/b> \(1\)/);
  });

  it('truncar a maxPerCategory con indicador de "+N más"', () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      mkItem({ id: `i${i}-1234`, category: 'idea', caption: `idea ${i}` }),
    );
    const out = formatInboxResults(items, { maxPerCategory: 3 });

    assert.match(out, /\+5 más/);
  });

  it('muestra preview cuando existe', () => {
    const items = [mkItem({
      category: 'estudio',
      caption: 'artículo',
      words: 1500,
      preview: 'Lorem ipsum dolor sit amet',
    })];
    const out = formatInboxResults(items);

    assert.match(out, /Lorem ipsum/);
    assert.match(out, /1500p/);
  });

  it('escapa HTML en captions y previews', () => {
    const items = [mkItem({
      caption: '<script>x</script>',
      preview: 'preview con <b>tags</b>',
    })];
    const out = formatInboxResults(items);

    assert.doesNotMatch(out, /<script>x<\/script>/);
    assert.match(out, /&lt;script&gt;/);
  });

  it('items sin classification → "sin clasificar"', () => {
    const items = [mkItem({ category: null, caption: 'huérfano' })];
    const out = formatInboxResults(items);

    assert.match(out, /sin clasificar/);
  });

  it('cuenta total de items en heading', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      mkItem({ id: `i${i}-x`, category: 'idea' }),
    );
    const out = formatInboxResults(items);

    assert.match(out, /5 items/);
  });

  it('singular "1 item" cuando solo hay uno', () => {
    const out = formatInboxResults([mkItem()]);
    assert.match(out, /\b1 item\b/);
  });
});
