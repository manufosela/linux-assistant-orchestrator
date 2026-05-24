import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createClusterStatusService,
  formatClusterStatus,
  formatClusterHistory,
} from '../../../src/modules/cluster/cluster-status-service.js';

const TARGETS = [
  { id: 'n2:litellm', node: 'n2', service: 'LiteLLM', host: '192.168.1.11', port: 8080, kind: 'http', path: '/health/liveliness' },
  { id: 'n4:postgres', node: 'n4', service: 'Postgres', host: '192.168.1.13', port: 5432, kind: 'tcp' },
];

describe('createClusterStatusService.probe', () => {
  it('devuelve una entrada por target con ok/detail', async () => {
    const healthChecker = {
      check: async (t) => (t.id === 'n2:litellm' ? { ok: true } : { ok: false, detail: 'conexión TCP rechazada' }),
    };
    const service = createClusterStatusService({
      healthChecker,
      targets: TARGETS,
      historyStore: { read: async () => [] },
    });
    const results = await service.probe();
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], { node: 'n2', service: 'LiteLLM', address: '192.168.1.11:8080', ok: true, detail: null });
    assert.equal(results[1].ok, false);
    assert.equal(results[1].detail, 'conexión TCP rechazada');
  });
});

describe('formatClusterStatus', () => {
  it('muestra ✅ para OK y ⚠️ con motivo para caídos', () => {
    const lines = formatClusterStatus([
      { node: 'n3', service: 'Ollama', address: '192.168.1.12:11434', ok: true, detail: null },
      { node: 'n3', service: 'n8n', address: '192.168.1.12:5678', ok: false, detail: 'timeout' },
    ]);
    const joined = lines.join('\n');
    assert.match(joined, /✅.*Ollama.*OK/);
    assert.match(joined, /⚠️.*n8n.*CAÍDO \(timeout\)/);
  });
});

describe('formatClusterHistory', () => {
  it('lista las incidencias más recientes primero', () => {
    const lines = formatClusterHistory([
      { timestamp: '2026-05-17T10:00:00.000Z', node: 'n3', service: 'Ollama', address: '192.168.1.12:11434', type: 'down', detail: 'down' },
      { timestamp: '2026-05-17T10:05:00.000Z', node: 'n3', service: 'Ollama', address: '192.168.1.12:11434', type: 'recovered', detail: null },
    ]);
    assert.match(lines[0], /recuperado/);
    assert.match(lines[1], /caído/);
  });

  it('indica cuando no hay incidencias', () => {
    assert.deepEqual(formatClusterHistory([]), ['Sin incidencias registradas.']);
  });
});
