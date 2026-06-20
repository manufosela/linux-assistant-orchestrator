import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createClusterWatcher } from '../../../src/modules/cluster/cluster-watcher.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const TARGET = { id: 'n3:ollama', node: 'n3', service: 'Ollama', host: '192.168.1.12', port: 11434, kind: 'http', path: '/api/tags' };

/** Scheduler stub: the interval is never used (we drive checkAll() manually);
 *  delayed retries are captured so the test can fire them on demand. */
function makeScheduler() {
  const pending = [];
  return {
    schedule: () => ({ stop() {} }),
    delay: (task) => { pending.push(task); return { cancel() {} }; },
    stopAll() {},
    /** Run every retry scheduled so far (and clear the queue). */
    async flush() {
      const tasks = pending.splice(0);
      for (const task of tasks) await task();
    },
    get count() { return pending.length; },
  };
}

/** Health checker stub with a flippable health flag. */
function makeChecker(initialOk = true) {
  let ok = initialOk;
  return {
    set: (value) => { ok = value; },
    check: async () => (ok ? { ok: true } : { ok: false, detail: 'down' }),
  };
}

function makeNotificationService() {
  const sent = [];
  return { sent, sendNotification: async (m) => { sent.push(m); } };
}

function makeHistoryStore() {
  const entries = [];
  return {
    entries,
    read: async () => entries,
    append: async (e) => { entries.push(e); return entries; },
  };
}

describe('createClusterWatcher', () => {
  let scheduler;
  let checker;
  let notifications;
  let history;
  let watcher;

  beforeEach(() => {
    scheduler = makeScheduler();
    checker = makeChecker(true);
    notifications = makeNotificationService();
    history = makeHistoryStore();
    watcher = createClusterWatcher({
      logger: silentLogger,
      scheduler,
      notificationService: notifications,
      healthChecker: checker,
      targets: [TARGET],
      historyStore: history,
      checkIntervalMs: 60_000,
      retryDelayMs: 10,
    });
  });

  it('no notifica mientras el servicio está OK', async () => {
    await watcher.checkAll();
    await watcher.checkAll();
    assert.equal(notifications.sent.length, 0);
    assert.equal(history.entries.length, 0);
  });

  it('fallo transitorio (se recupera en el reintento) NO genera notificación', async () => {
    checker.set(false);
    // Cambiar a OK justo después del primer probe → el retry inline lo verá OK
    setTimeout(() => checker.set(true), 5);
    await watcher.checkAll();

    assert.equal(notifications.sent.length, 0);
    assert.equal(history.entries.length, 0);
  });

  it('notifica al caer Y al recuperarse, sin spam mientras sigue caído', async () => {
    // Cae y sigue caído tras el reintento inline -> 1 notificación de caída.
    checker.set(false);
    await watcher.checkAll();

    assert.equal(notifications.sent.length, 1);
    assert.equal(notifications.sent[0].level, 'warn');
    // Mensaje sin la dirección (formato nuevo agrupado por digest)
    assert.match(notifications.sent[0].text, /Ollama en n3 no responde/);
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0].type, 'down');

    // Sigue caído varios ticks -> NO más notificaciones (anti-spam).
    await watcher.checkAll();
    await watcher.checkAll();
    await watcher.checkAll();
    assert.equal(notifications.sent.length, 1);
    assert.equal(history.entries.length, 1);

    // Se recupera -> 1 notificación de recuperación con duración.
    checker.set(true);
    await watcher.checkAll();

    assert.equal(notifications.sent.length, 2);
    assert.equal(notifications.sent[1].level, 'success');
    assert.match(notifications.sent[1].text, /Ollama en n3 recuperado tras \d+/);
    assert.equal(history.entries.length, 2);
    assert.equal(history.entries[1].type, 'recovered');

    // Y tras recuperarse no vuelve a notificar en cada tick.
    await watcher.checkAll();
    assert.equal(notifications.sent.length, 2);
  });

  it('getStatus refleja el estado actual', async () => {
    await watcher.checkAll();
    let status = watcher.getStatus();
    assert.equal(status[0].state, 'up');

    checker.set(false);
    await watcher.checkAll();
    status = watcher.getStatus();
    assert.equal(status[0].state, 'down');
    assert.equal(status[0].service, 'Ollama');
  });
});
