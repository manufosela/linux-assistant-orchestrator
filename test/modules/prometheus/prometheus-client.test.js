import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPrometheusClient } from '../../../src/modules/prometheus/prometheus-client.js';

/**
 * Builds a fake HttpClient that answers Prometheus API paths from canned data.
 *
 * @param {{ up?: object[], probe?: object[], alerts?: object[] }} data
 */
function fakeHttpClient({ up = [], probe = [], alerts = [] } = {}) {
  return {
    async get(path) {
      if (path.includes('query=up')) {
        return { status: 'success', data: { resultType: 'vector', result: up } };
      }
      if (path.includes('probe_success')) {
        return { status: 'success', data: { resultType: 'vector', result: probe } };
      }
      if (path.includes('/api/v1/alerts')) {
        return { status: 'success', data: { alerts } };
      }
      throw new Error(`unexpected path: ${path}`);
    },
    async post() {
      throw new Error('not used');
    },
  };
}

const series = (job, instance, value) => ({ metric: { job, instance }, value: [1700000000, String(value)] });

describe('createPrometheusClient.getDownReport', () => {
  it('reporta nada caído cuando todo está up', async () => {
    const client = createPrometheusClient({
      baseUrl: 'http://x',
      httpClient: fakeHttpClient({
        up: [series('prometheus', 'localhost:9090', 1), series('cadvisor', 'cadvisor:8080', 1)],
        probe: [series('jellyfin', 'http://host/health', 1)],
        alerts: [{ state: 'inactive', labels: { alertname: 'X' } }],
      }),
    });

    const report = await client.getDownReport();

    assert.equal(report.anythingDown, false);
    assert.equal(report.totalTargets, 2);
    assert.equal(report.totalProbes, 1);
    assert.deepEqual(report.downTargets, []);
    assert.deepEqual(report.firingAlerts, []);
  });

  it('detecta targets, probes y alertas caídos', async () => {
    const client = createPrometheusClient({
      baseUrl: 'http://x',
      httpClient: fakeHttpClient({
        up: [series('prometheus', 'localhost:9090', 1), series('node-n3', '192.168.1.12:9100', 0)],
        probe: [series('jellyfin', 'http://host/health', 0)],
        alerts: [
          { state: 'firing', labels: { alertname: 'InstanceDown', severity: 'critical' }, annotations: { summary: 'n3' } },
          { state: 'pending', labels: { alertname: 'Slow' } },
        ],
      }),
    });

    const report = await client.getDownReport();

    assert.equal(report.anythingDown, true);
    assert.deepEqual(report.downTargets, [{ job: 'node-n3', instance: '192.168.1.12:9100' }]);
    assert.deepEqual(report.downProbes, [{ job: 'jellyfin', instance: 'http://host/health' }]);
    assert.equal(report.firingAlerts.length, 1);
    assert.equal(report.firingAlerts[0].name, 'InstanceDown');
  });

  it('lanza error si Prometheus responde algo inesperado', async () => {
    const client = createPrometheusClient({
      baseUrl: 'http://x',
      httpClient: {
        async get() {
          return { status: 'error', error: 'boom' };
        },
        async post() {},
      },
    });

    await assert.rejects(() => client.getDownReport(), /unexpected response/);
  });
});
