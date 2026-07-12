import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../src/infrastructure/config/load-config.js';

// Use a non-existent env file so loadDotEnv() is a no-op and the test only
// exercises process.env.
const NO_ENV = '.env.does-not-exist';
const CLUSTER_KEYS = ['CLUSTER_ENABLED', 'CLUSTER_N2_IP', 'CLUSTER_N3_IP', 'CLUSTER_N4_IP', 'CLUSTER_MUTED_NODES'];

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

  it('mutedNodes por defecto es lista vacía', () => {
    process.env.CLUSTER_ENABLED = 'false';
    const config = loadConfig(NO_ENV);
    assert.deepEqual(config.cluster.mutedNodes, []);
  });

  it('parsea CLUSTER_MUTED_NODES ("n4, n3") a lista limpia', () => {
    process.env.CLUSTER_ENABLED = 'false';
    process.env.CLUSTER_MUTED_NODES = 'n4, n3';
    const config = loadConfig(NO_ENV);
    assert.deepEqual(config.cluster.mutedNodes, ['n4', 'n3']);
  });
});

const TEMP_KEYS = [
  'CLUSTER_ENABLED', 'TEMP_WATCHER_ENABLED', 'HA_BASE_URL', 'HA_TOKEN',
  'TEMP_SUMMER_MONTHS', 'TEMP_SUMMER_MEAN_MAX', 'TEMP_WINTER_MEAN_MIN',
];

describe('loadConfig — temperature validation', () => {
  /** @type {Record<string, string | undefined>} */
  let saved;

  beforeEach(() => {
    saved = Object.fromEntries(TEMP_KEYS.map((k) => [k, process.env[k]]));
    for (const k of TEMP_KEYS) delete process.env[k];
    // Aísla de la validación del cluster (que iría primero).
    process.env.CLUSTER_ENABLED = 'false';
  });

  afterEach(() => {
    for (const k of TEMP_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('lanza si el watcher está activo y Home Assistant no está configurado', () => {
    process.env.TEMP_WATCHER_ENABLED = 'true';
    assert.throws(() => loadConfig(NO_ENV), /Temperature watcher is enabled/);
  });

  it('desactivado por defecto, con umbrales y meses por defecto', () => {
    const config = loadConfig(NO_ENV);
    assert.equal(config.temperature.enabled, false);
    assert.deepEqual(config.temperature.summerMonths, [5, 6, 7, 8, 9, 10]);
    assert.deepEqual(config.temperature.winterMonths, [11, 12, 1, 2, 3, 4]);
    assert.equal(config.temperature.summerMeanThreshold, 30.0);
    assert.equal(config.temperature.summerRoomThreshold, 31.0);
    assert.equal(config.temperature.winterMeanThreshold, 20.1);
    assert.equal(config.temperature.winterRoomThreshold, 20.1);
  });

  it('no lanza si está activo y HA configurado; respeta overrides', () => {
    process.env.TEMP_WATCHER_ENABLED = 'true';
    process.env.HA_BASE_URL = 'http://ha.local:8123';
    process.env.HA_TOKEN = 'token';
    process.env.TEMP_SUMMER_MONTHS = '6,7,8';
    process.env.TEMP_SUMMER_MEAN_MAX = '29.5';
    const config = loadConfig(NO_ENV);
    assert.equal(config.temperature.enabled, true);
    assert.deepEqual(config.temperature.summerMonths, [6, 7, 8]);
    assert.equal(config.temperature.summerMeanThreshold, 29.5);
  });
});
