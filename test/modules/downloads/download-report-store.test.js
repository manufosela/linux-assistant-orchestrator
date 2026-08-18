import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDownloadReportStore, reportsSince } from '../../../src/modules/downloads/download-report-store.js';

describe('reportsSince (pura)', () => {
  const now = Date.parse('2026-08-18T10:00:00Z');
  const reports = [
    { ts: '2026-08-18T09:00:00Z', message: 'reciente' }, // hace 1h
    { ts: '2026-08-17T09:00:00Z', message: 'ayer' },     // hace 25h
    { ts: 'basura', message: 'ts inválido' },
  ];
  it('devuelve solo los de las últimas 24h', () => {
    const r = reportsSince(reports, 24 * 3600000, now);
    assert.equal(r.length, 1);
    assert.equal(r[0].message, 'reciente');
  });
  it('array nulo → []', () => {
    assert.deepEqual(reportsSince(null, 1000, now), []);
  });
});

describe('createDownloadReportStore', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'dlrep-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('requiere filePath', () => {
    assert.throws(() => createDownloadReportStore({}), /filePath/);
  });

  it('add persiste y recent() devuelve los mensajes de 24h', async () => {
    const filePath = join(dir, 'a.json');
    const store = createDownloadReportStore({ filePath });
    await store.load();
    await store.add('📥 3 pelis, 2 series', new Date('2026-08-18T03:00:00Z'));
    const msgs = store.recent(24 * 3600000, Date.parse('2026-08-18T07:30:00Z'));
    assert.deepEqual(msgs, ['📥 3 pelis, 2 series']);
    const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(onDisk.reports.length, 1);
  });

  it('poda los reports de más de maxAgeMs al añadir', async () => {
    const store = createDownloadReportStore({ filePath: join(dir, 'p.json'), maxAgeMs: 48 * 3600000 });
    await store.load();
    store.data.reports.push({ ts: '2026-08-15T03:00:00Z', message: 'viejo' }); // hace 3 días
    await store.add('nuevo', new Date('2026-08-18T03:00:00Z'));
    assert.equal(store.data.reports.length, 1);
    assert.equal(store.data.reports[0].message, 'nuevo');
  });

  it('load de fichero inexistente → vacío, no lanza', async () => {
    const store = createDownloadReportStore({ filePath: join(dir, 'noexiste.json') });
    await store.load();
    assert.deepEqual(store.recent(), []);
  });
});
