import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createClusterHealthChecker } from '../../../src/modules/cluster/cluster-health-checker.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const httpTarget = { id: 'n2:ollama', node: 'n2', service: 'Ollama', host: '10.0.0.1', port: 11434, kind: 'http', path: '/api/tags' };
const tcpTarget = { id: 'n4:postgres', node: 'n4', service: 'Postgres', host: '10.0.0.3', port: 5432, kind: 'tcp' };

describe('createClusterHealthChecker', () => {
  it('marca OK un HTTP 200', async () => {
    const checker = createClusterHealthChecker({
      logger: silentLogger,
      fetchImpl: async () => ({ status: 200 }),
    });
    assert.deepEqual(await checker.check(httpTarget), { ok: true });
  });

  it('marca caído un HTTP no-200 con el código en detail', async () => {
    const checker = createClusterHealthChecker({
      logger: silentLogger,
      fetchImpl: async () => ({ status: 503 }),
    });
    const result = await checker.check(httpTarget);
    assert.equal(result.ok, false);
    assert.match(result.detail, /503/);
  });

  it('marca caído cuando fetch lanza (servicio no responde)', async () => {
    const checker = createClusterHealthChecker({
      logger: silentLogger,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    const result = await checker.check(httpTarget);
    assert.equal(result.ok, false);
    assert.match(result.detail, /ECONNREFUSED/);
  });

  it('reporta timeout cuando fetch aborta', async () => {
    const checker = createClusterHealthChecker({
      logger: silentLogger,
      fetchImpl: async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    const result = await checker.check(httpTarget);
    assert.equal(result.ok, false);
    assert.equal(result.detail, 'timeout');
  });

  it('marca OK un TCP que conecta (Postgres)', async () => {
    const checker = createClusterHealthChecker({
      logger: silentLogger,
      tcpConnect: async () => {},
    });
    assert.deepEqual(await checker.check(tcpTarget), { ok: true });
  });

  it('marca caído un TCP que rechaza la conexión', async () => {
    const checker = createClusterHealthChecker({
      logger: silentLogger,
      tcpConnect: async () => { throw new Error('connection refused'); },
    });
    const result = await checker.check(tcpTarget);
    assert.equal(result.ok, false);
    assert.match(result.detail, /refused/);
  });
});
