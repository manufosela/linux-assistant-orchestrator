import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatWatchtowerNotification } from '../../../src/modules/watchtower/watchtower-formatter.js';

describe('formatWatchtowerNotification', () => {
  it('reporte con actualizaciones → resumen en español (success)', () => {
    const { text, level } = formatWatchtowerNotification({
      host: 'n2',
      updated: [{ name: 'luis' }, { name: 'grafana' }],
      failed: [],
      scanned: 12,
    });
    assert.equal(level, 'success');
    assert.match(text, /🐳 <b>Watchtower · n2<\/b>/);
    assert.match(text, /✅ 2 actualizados: luis, grafana/);
  });

  it('fallos → warn con nombres', () => {
    const { text, level } = formatWatchtowerNotification({ host: 'n4', failed: [{ name: 'x' }] });
    assert.equal(level, 'warn');
    assert.match(text, /🐳 <b>Watchtower · n4<\/b>/);
    assert.match(text, /⚠️ 1 con fallo: x/);
  });

  it('shoutrrr envuelve nuestra plantilla JSON en message → la abre', () => {
    const { text, level } = formatWatchtowerNotification({
      message: '{"host":"n3","scanned":5,"updated":[],"failed":[]}',
    });
    assert.equal(level, 'info');
    assert.match(text, /🐳 <b>Watchtower · n3<\/b>/);
    assert.match(text, /Sin cambios \(5 contenedores revisados\)\./);
  });

  it('texto plano (banner) → primera línea, sin volcado', () => {
    const { text, level } = formatWatchtowerNotification({
      message: 'Watchtower 1.17.0\nNext scheduled run: 2026-05-20 04:30:00 UTC',
    });
    assert.equal(level, 'info');
    assert.match(text, /🐳 <b>Watchtower<\/b>\nWatchtower 1\.17\.0/);
    assert.ok(!text.includes('Next scheduled run'));
  });

  it('escapa HTML y no se rompe con vacío', () => {
    assert.match(formatWatchtowerNotification('a < b & c').text, /a &lt; b &amp; c/);
    const r = formatWatchtowerNotification(undefined);
    assert.equal(r.level, 'info');
    assert.match(r.text, /Watchtower/);
  });
});
