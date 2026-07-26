import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBatteryHistoryStore } from '../../../src/modules/battery/battery-history-store.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe('createBatteryHistoryStore', () => {
  let dir;
  let filePath;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'battery-store-'));
    filePath = join(dir, 'nested', 'battery-history.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('requires a filePath', () => {
    assert.throws(() => createBatteryHistoryStore({ logger: noopLogger }), /requires filePath/);
  });

  it('starts empty when the file does not exist', async () => {
    const store = createBatteryHistoryStore({ filePath, logger: noopLogger });
    await store.load();
    assert.equal(store.isEmpty(), true);
    assert.equal(store.getLastLevel('sensor.x_battery'), null);
    assert.deepEqual(store.getHistory('sensor.x_battery'), []);
  });

  it('records levels and changes, then persists and reloads them', async () => {
    const store = createBatteryHistoryStore({ filePath, logger: noopLogger });
    await store.load();
    store.setLastLevel('sensor.x_battery', 87);
    store.recordChange('sensor.x_battery', { date: '2026-07-25T00:00:00.000Z', level: 100, name: 'Despacho' });
    await store.save();

    // el fichero existe y es JSON válido con salto de línea final
    const raw = await readFile(filePath, 'utf8');
    assert.match(raw, /\n$/);
    assert.doesNotThrow(() => JSON.parse(raw));

    const reopened = createBatteryHistoryStore({ filePath, logger: noopLogger });
    await reopened.load();
    assert.equal(reopened.isEmpty(), false);
    assert.equal(reopened.getLastLevel('sensor.x_battery'), 87);
    assert.equal(reopened.hasHistory('sensor.x_battery'), true);
    assert.deepEqual(reopened.getHistory('sensor.x_battery'), [
      { date: '2026-07-25T00:00:00.000Z', level: 100, name: 'Despacho' },
    ]);
  });

  it('getHistory returns a copy (no external mutation)', async () => {
    const store = createBatteryHistoryStore({ filePath, logger: noopLogger });
    await store.load();
    store.recordChange('sensor.x_battery', { date: '2026-07-25T00:00:00.000Z', level: 100, name: 'X' });
    const copy = store.getHistory('sensor.x_battery');
    copy.push({ bogus: true });
    assert.equal(store.getHistory('sensor.x_battery').length, 1);
  });

  it('distinguishes level 0 from missing (does not treat 0 as null)', async () => {
    const store = createBatteryHistoryStore({ filePath, logger: noopLogger });
    await store.load();
    store.setLastLevel('sensor.dead_battery', 0);
    assert.equal(store.getLastLevel('sensor.dead_battery'), 0);
    assert.equal(store.getLastLevel('sensor.never_seen_battery'), null);
  });

  it('recovers to empty on corrupt JSON', async () => {
    const store = createBatteryHistoryStore({ filePath, logger: noopLogger });
    await store.load();
    store.setLastLevel('sensor.x_battery', 50);
    await store.save();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, '{ this is not json', 'utf8');

    const reopened = createBatteryHistoryStore({ filePath, logger: noopLogger });
    await reopened.load();
    assert.equal(reopened.isEmpty(), true);
  });
});
