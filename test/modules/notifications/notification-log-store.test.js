import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createNotificationLogStore,
  entriesOfDay,
} from '../../../src/modules/notifications/notification-log-store.js';

describe('entriesOfDay (pura)', () => {
  const entries = [
    { ts: new Date(2026, 9, 10, 23, 59).toISOString(), text: 'ayer' },
    { ts: new Date(2026, 9, 11, 7, 30).toISOString(), text: 'parte' },
    { ts: new Date(2026, 9, 11, 8, 30).toISOString(), text: 'persiana' },
    { ts: 'basura', text: 'ts inválido' },
  ];

  it('devuelve solo las del mismo día local que `now`', () => {
    const r = entriesOfDay(entries, new Date(2026, 9, 11, 12, 0));
    assert.deepEqual(r.map((e) => e.text), ['parte', 'persiana']);
  });

  it('array nulo → []', () => {
    assert.deepEqual(entriesOfDay(null, new Date()), []);
  });
});

describe('createNotificationLogStore', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'notiflog-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('exige filePath', () => {
    assert.throws(() => createNotificationLogStore({}), /filePath/);
  });

  it('load sin fichero → vacío', async () => {
    const store = createNotificationLogStore({ filePath: join(dir, 'none.json') });
    await store.load();
    assert.deepEqual(store.today(), []);
  });

  it('add persiste y today devuelve las del día con su nivel', async () => {
    const filePath = join(dir, 'log.json');
    const store = createNotificationLogStore({ filePath });
    await store.load();
    const now = new Date(2026, 9, 11, 8, 30);
    await store.add({ text: 'persiana subida', level: 'info', urgent: false }, now);

    const reloaded = createNotificationLogStore({ filePath });
    await reloaded.load();
    const today = reloaded.today(new Date(2026, 9, 11, 9, 0));
    assert.equal(today.length, 1);
    assert.equal(today[0].text, 'persiana subida');
    assert.equal(today[0].level, 'info');
    assert.equal(today[0].urgent, false);
    assert.match(await readFile(filePath, 'utf8'), /persiana subida/);
  });

  it('add concurrentes no pierden avisos en disco', async () => {
    const filePath = join(dir, 'concurrent.json');
    const store = createNotificationLogStore({ filePath });
    await store.load();
    const now = new Date(2026, 9, 11, 9, 0);
    await Promise.all(['a', 'b', 'c', 'd'].map((text) => store.add({ text }, now)));

    const reloaded = createNotificationLogStore({ filePath });
    await reloaded.load();
    assert.deepEqual(reloaded.today(now).map((e) => e.text), ['a', 'b', 'c', 'd']);
  });

  it('poda las entradas más viejas que maxAgeMs al añadir', async () => {
    const store = createNotificationLogStore({ filePath: join(dir, 'prune.json'), maxAgeMs: 60 * 60 * 1000 });
    await store.load();
    await store.add({ text: 'vieja', level: 'info' }, new Date(2026, 9, 11, 6, 0));
    await store.add({ text: 'nueva', level: 'info' }, new Date(2026, 9, 11, 8, 0));
    assert.deepEqual(store.data.entries.map((e) => e.text), ['nueva']);
  });

  it('fichero corrupto → vacío y avisa', async () => {
    const filePath = join(dir, 'bad.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, '{no json', 'utf8');
    const warnings = [];
    const store = createNotificationLogStore({ filePath, logger: { warn: (...a) => warnings.push(a) } });
    await store.load();
    assert.deepEqual(store.today(), []);
    assert.equal(warnings.length, 1);
  });
});
