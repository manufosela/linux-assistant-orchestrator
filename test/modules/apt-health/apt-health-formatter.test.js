import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatAptHealthNotification } from '../../../src/modules/apt-health/apt-health-formatter.js';

describe('formatAptHealthNotification', () => {
  it('upgrade-failed: muestra host + extracto de log dentro de <pre>', () => {
    const { text, level } = formatAptHealthNotification({
      host: 'n4',
      event: 'upgrade-failed',
      detail: 'dpkg: error procesando linux-modules-nvidia-535-6.17.0-35',
    });
    assert.equal(level, 'warn');
    assert.match(text, /APT.*n4.*unattended-upgrade falló/);
    assert.match(text, /<pre>.*linux-modules-nvidia-535.*<\/pre>/);
  });

  it('pending-old: muestra count + días con plural correcto', () => {
    const { text } = formatAptHealthNotification({
      host: 'n2', event: 'pending-old', count: 7, days: 5,
    });
    assert.match(text, /n2: 7 paquetes pendientes desde hace 5 días/);
  });

  it('pending-old: singular cuando count=1 o days=1', () => {
    const { text } = formatAptHealthNotification({
      host: 'n3', event: 'pending-old', count: 1, days: 1,
    });
    assert.match(text, /1 paquete pendiente desde hace 1 día/);
    assert.doesNotMatch(text, /paquetes pendientes/);
    assert.doesNotMatch(text, /días/);
  });

  it('reboot-pending: muestra host + días', () => {
    const { text, level } = formatAptHealthNotification({
      host: 'n4', event: 'reboot-pending', days: 12,
    });
    assert.equal(level, 'warn');
    assert.match(text, /n4: reboot pendiente desde hace 12 días/);
  });

  it('reboot-pending sin days: omite la parte de tiempo', () => {
    const { text } = formatAptHealthNotification({
      host: 'n4', event: 'reboot-pending',
    });
    assert.match(text, /reboot pendiente$/m);
  });

  it('escapa HTML en host y detail para evitar inyección en Telegram', () => {
    const { text } = formatAptHealthNotification({
      host: '<script>alert(1)</script>',
      event: 'upgrade-failed',
      detail: 'foo & <b>bar</b>',
    });
    assert.doesNotMatch(text.replace(/<pre>|<\/pre>|<b>|<\/b>|<code>|<\/code>/g, ''), /<script>/);
    assert.match(text, /&lt;script&gt;/);
    assert.match(text, /foo &amp; &lt;b&gt;bar&lt;\/b&gt;/);
  });

  it('trunca detail muy largo a 600 chars con elipsis', () => {
    const longDetail = 'x'.repeat(1000);
    const { text } = formatAptHealthNotification({
      host: 'n4', event: 'upgrade-failed', detail: longDetail,
    });
    const preMatch = text.match(/<pre>([\s\S]*?)<\/pre>/);
    assert.ok(preMatch);
    assert.ok(preMatch[1].length <= 600);
    assert.ok(preMatch[1].endsWith('…'));
  });

  it('evento desconocido: no se silencia, se reporta como warn', () => {
    const { text, level } = formatAptHealthNotification({
      host: 'n4', event: 'cosa-rara', detail: 'qué pasó',
    });
    assert.equal(level, 'warn');
    assert.match(text, /evento desconocido.*cosa-rara/);
  });

  it('payload no-objeto: degrada limpio con host=desconocido', () => {
    const { text, level } = formatAptHealthNotification('string raro');
    assert.equal(level, 'warn');
    assert.match(text, /desconocido/);
  });

  it('count/days negativos o no-numéricos: se sanean a 0', () => {
    const { text } = formatAptHealthNotification({
      host: 'n4', event: 'pending-old', count: -5, days: 'foo',
    });
    assert.match(text, /0 paquetes pendientes desde hace 0 días/);
  });
});
