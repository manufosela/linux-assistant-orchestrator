import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../src/infrastructure/config/load-config.js';

// Use a non-existent env file so loadDotEnv() is a no-op and the test only
// exercises process.env.
const NO_ENV = '.env.does-not-exist';
const CLUSTER_KEYS = ['CLUSTER_ENABLED', 'CLUSTER_N2_IP', 'CLUSTER_N3_IP', 'CLUSTER_N4_IP'];

describe('loadConfig — cluster validation', () => {
  /** @type {Record<string, string | undefined>} */
  let saved;

  beforeEach(() => {
    saved = Object.fromEntries(CLUSTER_KEYS.map((k) => [k, process.env[k]]));
    for (const k of CLUSTER_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of CLUSTER_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('lanza si el watcher está activo y faltan IPs', () => {
    assert.throws(() => loadConfig(NO_ENV), /CLUSTER_N2_IP, CLUSTER_N3_IP, CLUSTER_N4_IP/);
  });

  it('no lanza si el watcher está desactivado', () => {
    process.env.CLUSTER_ENABLED = 'false';
    const config = loadConfig(NO_ENV);
    assert.equal(config.cluster.enabled, false);
  });

  it('no lanza cuando se proporcionan las 3 IPs', () => {
    process.env.CLUSTER_N2_IP = '10.0.0.1';
    process.env.CLUSTER_N3_IP = '10.0.0.2';
    process.env.CLUSTER_N4_IP = '10.0.0.3';
    const config = loadConfig(NO_ENV);
    assert.equal(config.cluster.enabled, true);
    assert.equal(config.cluster.n2Ip, '10.0.0.1');
  });
});
