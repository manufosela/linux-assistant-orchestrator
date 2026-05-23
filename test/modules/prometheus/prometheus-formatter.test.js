import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatDownReport } from '../../../src/modules/prometheus/prometheus-formatter.js';

describe('formatDownReport', () => {
  it('reporta "todo en orden" cuando no hay nada caído', () => {
    const report = {
      totalTargets: 10,
      totalProbes: 5,
      downTargets: [],
      downProbes: [],
      firingAlerts: [],
      anythingDown: false,
    };
    const { text, html } = formatDownReport(report);

    assert.match(text, /Todo en orden/);
    assert.match(text, /10 targets/);
    assert.match(text, /5 servicios HTTP/);
    assert.match(html, /<b>Todo en orden<\/b>/);
  });

  it('lista targets, servicios y alertas caídos', () => {
    const report = {
      totalTargets: 10,
      totalProbes: 5,
      downTargets: [{ job: 'node-n3', instance: '192.168.1.12:9100' }],
      downProbes: [{ job: 'jellyfin', instance: 'http://192.168.1.7:8096/health' }],
      firingAlerts: [{ name: 'InstanceDown', severity: 'critical', summary: 'n3 no responde' }],
      anythingDown: true,
    };
    const { text, html } = formatDownReport(report);

    assert.match(text, /Hay cosas caídas/);
    assert.match(text, /node-n3 \(192\.168\.1\.12:9100\)/);
    assert.match(text, /jellyfin/);
    assert.match(text, /InstanceDown \[critical\] — n3 no responde/);
    assert.match(html, /<b>Targets caídos:<\/b>/);
    assert.match(html, /<b>Alertas activas:<\/b>/);
  });

  it('escapa caracteres HTML en la variante html', () => {
    const report = {
      totalTargets: 1,
      totalProbes: 0,
      downTargets: [],
      downProbes: [],
      firingAlerts: [{ name: 'A<b>', severity: '', summary: 'x & y' }],
      anythingDown: true,
    };
    const { html } = formatDownReport(report);

    assert.doesNotMatch(html.replace(/<b>|<\/b>/g, ''), /<b>/);
    assert.match(html, /A&lt;b&gt;/);
    assert.match(html, /x &amp; y/);
  });
});
