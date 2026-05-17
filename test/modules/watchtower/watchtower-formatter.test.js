import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatWatchtowerNotification } from '../../../src/modules/watchtower/watchtower-formatter.js';

describe('formatWatchtowerNotification', () => {
  it('formatea un reporte estructurado con updates como tabla (success)', () => {
    const { text, level } = formatWatchtowerNotification({
      host: 'n2',
      updated: [{ name: 'luis', image: 'luis:local', old: 'abc1234', new: 'def5678' }],
      scanned: 12,
    });
    assert.equal(level, 'success');
    assert.match(text, /🐳 <b>Watchtower · n2<\/b>/);
    assert.match(text, /<pre>[\s\S]*✅ luis {2}luis:local {2}abc1234 → def5678[\s\S]*<\/pre>/);
    assert.match(text, /12 contenedores revisados/);
  });

  it('marca warn cuando hay fallos', () => {
    const { text, level } = formatWatchtowerNotification({
      failed: [{ name: 'x', image: 'y:1', error: 'pull denied' }],
    });
    assert.equal(level, 'warn');
    assert.match(text, /⚠️ x {2}y:1 {2}ERROR: pull denied/);
  });

  it('envuelve un mensaje plano (shoutrrr) en el mismo formato', () => {
    const { text, level } = formatWatchtowerNotification({ message: 'Found 0 containers to update' });
    assert.equal(level, 'info');
    assert.match(text, /🐳 <b>Watchtower<\/b>\n<pre>Found 0 containers to update<\/pre>/);
  });

  it('acepta string crudo y escapa HTML', () => {
    const { text } = formatWatchtowerNotification('a < b & c > d');
    assert.match(text, /<pre>a &lt; b &amp; c &gt; d<\/pre>/);
  });

  it('no se rompe con payload vacío', () => {
    const { text, level } = formatWatchtowerNotification(undefined);
    assert.equal(level, 'info');
    assert.match(text, /<pre>/);
  });
});
