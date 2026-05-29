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

  it('muestra la duración real "lleva 10h 23m" calculada desde activeAt', () => {
    const now = Date.parse('2026-05-29T10:00:00Z');
    const activeAt = new Date(now - (10 * 60 + 23) * 60 * 1000).toISOString();
    const report = {
      totalTargets: 1, totalProbes: 0, downTargets: [], downProbes: [],
      firingAlerts: [{ name: 'InstanceDown', severity: 'critical', summary: 'n3 no responde', activeAt }],
      anythingDown: true,
    };
    const { text } = formatDownReport(report, { now });

    assert.match(text, /InstanceDown \[critical\] — n3 no responde \(lleva 10h 23m\)/);
  });

  it('elimina el literal ">2m" heredado del summary de Prometheus', () => {
    const now = Date.parse('2026-05-29T10:00:00Z');
    const activeAt = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    const report = {
      totalTargets: 1, totalProbes: 0, downTargets: [], downProbes: [],
      firingAlerts: [{ name: 'InstanceDown', severity: 'critical', summary: 'n3 no responde >2m', activeAt }],
      anythingDown: true,
    };
    const { text } = formatDownReport(report, { now });

    assert.doesNotMatch(text, />2m/);
    assert.match(text, /n3 no responde \(lleva 3h\)/);
  });

  it('no añade "(lleva ...)" cuando la alerta no trae activeAt', () => {
    const report = {
      totalTargets: 1, totalProbes: 0, downTargets: [], downProbes: [],
      firingAlerts: [{ name: 'InstanceDown', severity: 'critical', summary: 'n3 no responde', activeAt: null }],
      anythingDown: true,
    };
    const { text } = formatDownReport(report);

    assert.match(text, /InstanceDown \[critical\] — n3 no responde$/m);
    assert.doesNotMatch(text, /lleva/);
  });

  it('formatea duraciones de minutos, horas y días correctamente', () => {
    const now = Date.parse('2026-05-29T10:00:00Z');
    const cases = [
      { offset: 45 * 1000, expected: '<1m' },
      { offset: 5 * 60 * 1000, expected: '5m' },
      { offset: 2 * 60 * 60 * 1000, expected: '2h' },
      { offset: (2 * 60 + 30) * 60 * 1000, expected: '2h 30m' },
      { offset: (2 * 24 + 5) * 60 * 60 * 1000, expected: '2d 5h' },
      { offset: 3 * 24 * 60 * 60 * 1000, expected: '3d' },
    ];
    for (const { offset, expected } of cases) {
      const report = {
        totalTargets: 1, totalProbes: 0, downTargets: [], downProbes: [],
        firingAlerts: [{ name: 'X', severity: '', summary: 's', activeAt: new Date(now - offset).toISOString() }],
        anythingDown: true,
      };
      const { text } = formatDownReport(report, { now });
      assert.match(text, new RegExp(`lleva ${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
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
