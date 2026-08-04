import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTuyaGuardian, findStaleTuya } from '../../../src/modules/health/tuya-guardian.js';

const NOW = new Date('2026-08-04T10:00:00Z');
const nowMs = NOW.getTime();
function ent(id, hoursAgo) {
  return { entity_id: id, state: 'off', last_updated: new Date(nowMs - hoursAgo * 3600000).toISOString() };
}
const WATCHED = ['cover.persiana', 'switch.valv1'];

describe('findStaleTuya', () => {
  it('detecta los mudos > staleHours', () => {
    const states = [ent('cover.persiana', 20), ent('switch.valv1', 1)];
    const stale = findStaleTuya(states, WATCHED, 8, nowMs);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].id, 'cover.persiana');
    assert.equal(stale[0].hours, 20);
  });
  it('nada mudo si todos frescos', () => {
    const states = [ent('cover.persiana', 1), ent('switch.valv1', 2)];
    assert.equal(findStaleTuya(states, WATCHED, 8, nowMs).length, 0);
  });
  it('ignora entidades ausentes', () => {
    assert.equal(findStaleTuya([ent('cover.persiana', 1)], WATCHED, 8, nowMs).length, 0);
  });
});

describe('createTuyaGuardian.checkOnce', () => {
  const noop = { info() {}, warn() {}, error() {}, debug() {} };
  const sched = { schedule: () => ({ stop() {} }) };

  function make({ states, reloads, sent, nowFn = () => NOW, minReloadGapMs = 2 * 3600000 }) {
    return createTuyaGuardian({
      logger: noop, scheduler: sched,
      notificationService: { async sendNotification(m) { sent?.push(m); } },
      fetchStates: async () => states,
      reloadTuya: async () => { reloads?.push(1); },
      watchedEntities: WATCHED, staleHours: 8, minReloadGapMs, nowFn,
    });
  }

  it('recarga Tuya y avisa cuando hay un dispositivo mudo', async () => {
    const reloads = [], sent = [];
    const g = make({ states: [ent('cover.persiana', 20), ent('switch.valv1', 1)], reloads, sent });
    await g.checkOnce();
    assert.equal(reloads.length, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Tuya se había colgado/);
    assert.match(sent[0].text, /cover\.persiana/);
  });

  it('NO recarga si todo está fresco', async () => {
    const reloads = [], sent = [];
    const g = make({ states: [ent('cover.persiana', 1), ent('switch.valv1', 1)], reloads, sent });
    await g.checkOnce();
    assert.equal(reloads.length, 0);
    assert.equal(sent.length, 0);
  });

  it('respeta el rate-limit: no recarga dos veces seguidas', async () => {
    const reloads = [], sent = [];
    const g = make({ states: [ent('cover.persiana', 20)], reloads, sent });
    await g.checkOnce(); // recarga
    await g.checkOnce(); // dentro del rate-limit → no recarga
    assert.equal(reloads.length, 1);
    assert.equal(sent.length, 1);
  });

  it('si fetchStates falla, no lanza ni recarga', async () => {
    const reloads = [];
    const g = createTuyaGuardian({
      logger: noop, scheduler: sched,
      notificationService: { async sendNotification() {} },
      fetchStates: async () => { throw new Error('down'); },
      reloadTuya: async () => { reloads.push(1); },
      watchedEntities: WATCHED, staleHours: 8, nowFn: () => NOW,
    });
    await g.checkOnce();
    assert.equal(reloads.length, 0);
  });

  it('requiere fetchStates y reloadTuya', () => {
    assert.throws(() => createTuyaGuardian({ scheduler: sched, notificationService: {}, reloadTuya: () => {} }), /fetchStates/);
    assert.throws(() => createTuyaGuardian({ scheduler: sched, notificationService: {}, fetchStates: () => {} }), /reloadTuya/);
  });
});
