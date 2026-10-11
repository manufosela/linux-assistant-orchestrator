import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isReportRequest, buildReportMessages } from '../../../src/modules/notifications/notification-report.js';

describe('isReportRequest', () => {
  for (const text of ['informe', 'Informe', ' informe ', 'informe?', 'el informe', 'informe de hoy', '¿informe?']) {
    it(`reconoce "${text}"`, () => assert.equal(isReportRequest(text), true));
  }
  for (const text of ['', 'hazme un informe de ventas', 'informes antiguos', 'qué temperatura hace']) {
    it(`ignora "${text}"`, () => assert.equal(isReportRequest(text), false));
  }
});

describe('buildReportMessages', () => {
  const at = (h, m) => new Date(2026, 9, 11, h, m).toISOString();

  it('sin avisos → un mensaje diciendo que no hay nada', () => {
    const msgs = buildReportMessages([]);
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /no hay avisos/i);
  });

  it('lista los avisos en orden con su hora y marca los urgentes', () => {
    const msgs = buildReportMessages([
      { ts: at(7, 30), text: '🩺 Parte diario', level: 'info', urgent: false },
      { ts: at(8, 30), text: '🪟 Persiana al 80%', level: 'info', urgent: false },
      { ts: at(9, 5), text: '⛈️ Tormenta', level: 'warn', urgent: true },
    ]);
    assert.equal(msgs.length, 1);
    const [msg] = msgs;
    assert.match(msg, /3 avisos/);
    assert.ok(msg.indexOf('07:30') < msg.indexOf('08:30'));
    assert.ok(msg.indexOf('08:30') < msg.indexOf('09:05'));
    assert.match(msg, /09:05.*enviado/);
    assert.doesNotMatch(msg, /08:30.*enviado/);
  });

  it('reparte en varios mensajes sin partir un aviso cuando no cabe', () => {
    const long = 'x'.repeat(2000);
    const msgs = buildReportMessages(
      [1, 2, 3].map((i) => ({ ts: at(7, i), text: `${i}${long}`, level: 'info', urgent: false })),
      { maxChars: 3000 },
    );
    assert.equal(msgs.length, 3);
    msgs.forEach((m, i) => assert.ok(m.includes(`${i + 1}${long}`)));
  });

  it('un aviso más largo que un mensaje se recorta en texto plano sin pasarse del límite', () => {
    const huge = `<b>Digest</b>\n${'correo &amp; más '.repeat(600)}`;
    const msgs = buildReportMessages([{ ts: at(7, 0), text: huge, level: 'info' }], { maxChars: 3800 });
    assert.equal(msgs.length, 1);
    assert.ok(msgs[0].length <= 3800, `longitud ${msgs[0].length}`);
    assert.match(msgs[0], /recortado/);
    assert.match(msgs[0], /correo &amp; más/);
    assert.doesNotMatch(msgs[0], /<b>Digest<\/b>/);
  });
});
