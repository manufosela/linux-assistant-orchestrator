import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClusterWatcher, formatDuration } from '../../../src/modules/cluster/cluster-watcher.js';
import { createClusterStateStore } from '../../../src/modules/cluster/cluster-state-store.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function buildFakeScheduler() {
  const delays = [];
  return {
    scheduler: {
      schedule() { return { stop() {} }; },
      delay(task, ms) { delays.push({ task, ms }); return { cancel() {} }; },
      stopAll() {},
    },
    async runPending() {
      while (delays.length > 0) {
        const { task } = delays.shift();
        await task();
      }
    },
  };
}

function buildFakeNotifier() {
  const sent = [];
  return {
    sent,
    service: { async sendNotification(msg) { sent.push(msg); } },
  };
}

const allDownChecker = {
  async check(target) {
    return { ok: false, detail: 'host unreachable' };
  },
};

const allOkChecker = { async check() { return { ok: true }; } };

const targets = [
  { id: 'n4:ollama', node: 'n4', service: 'Ollama', host: '192.168.1.13', port: 11434 },
  { id: 'n4:qdrant', node: 'n4', service: 'Qdrant', host: '192.168.1.13', port: 6333 },
  { id: 'n4:postgres', node: 'n4', service: 'Postgres', host: '192.168.1.13', port: 5432 },
];

describe('formatDuration', () => {
  it('formatos esperados', () => {
    assert.equal(formatDuration(45 * 1000), '45s');
    assert.equal(formatDuration((14 * 60 + 32) * 1000), '14m32s');
    assert.equal(formatDuration(14 * 60 * 1000), '14m');
    assert.equal(formatDuration((2 * 60 + 14) * 60 * 1000), '2h14m');
    assert.equal(formatDuration(3 * 60 * 60 * 1000), '3h');
    assert.equal(formatDuration((3 * 24 + 2) * 60 * 60 * 1000), '3d2h');
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(-1), '?');
  });
});

describe('createClusterWatcher — agrupación por nodo', () => {
  it('si 3 servicios caen en el mismo tick, envía UN mensaje agrupado', async () => {
    const sched = buildFakeScheduler();
    const notif = buildFakeNotifier();
    const w = createClusterWatcher({
      logger: noopLogger,
      scheduler: sched.scheduler,
      notificationService: notif.service,
      healthChecker: allDownChecker,
      targets,
      historyStore: { append: async () => {}, read: async () => [] },
      retryDelayMs: 10,
    });
    await w.checkAll();
    await sched.runPending();
    assert.equal(notif.sent.length, 1, 'un único mensaje, no 3');
    assert.match(notif.sent[0].text, /3 servicios caídos/);
    assert.match(notif.sent[0].text, /Ollama en n4/);
    assert.match(notif.sent[0].text, /Qdrant en n4/);
    assert.match(notif.sent[0].text, /Postgres en n4/);
  });

  it('si los 3 servicios siguen caídos en el siguiente tick, NO se notifica de nuevo', async () => {
    const sched = buildFakeScheduler();
    const notif = buildFakeNotifier();
    const w = createClusterWatcher({
      logger: noopLogger,
      scheduler: sched.scheduler,
      notificationService: notif.service,
      healthChecker: allDownChecker,
      targets,
      historyStore: { append: async () => {}, read: async () => [] },
      retryDelayMs: 10,
    });
    await w.checkAll();
    await sched.runPending();
    assert.equal(notif.sent.length, 1);
    // Tick siguiente: sigue todo down
    await w.checkAll();
    await sched.runPending();
    assert.equal(notif.sent.length, 1, 'no debe repetir el mensaje');
  });
});

describe('createClusterWatcher — recovered con duración', () => {
  it('formato "recuperado tras XmYs" en el mensaje', async () => {
    const sched = buildFakeScheduler();
    const notif = buildFakeNotifier();
    let checker = allDownChecker;
    const w = createClusterWatcher({
      logger: noopLogger,
      scheduler: sched.scheduler,
      notificationService: notif.service,
      healthChecker: { async check(t) { return checker.check(t); } },
      targets: [targets[0]],
      historyStore: { append: async () => {}, read: async () => [] },
      retryDelayMs: 10,
    });
    await w.checkAll();
    await sched.runPending();
    assert.equal(notif.sent.length, 1, 'mensaje DOWN enviado');
    // Recupera
    checker = allOkChecker;
    await w.checkAll();
    await sched.runPending();
    assert.equal(notif.sent.length, 2, 'mensaje RECOVERED enviado');
    assert.match(notif.sent[1].text, /recuperado tras \d+s/);
  });
});

describe('createClusterWatcher — estado persistente', () => {
  let tmp;
  let stateStore;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'luis-cluster-state-'));
    stateStore = createClusterStateStore({ filePath: join(tmp, 'state.json') });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('tras restart, NO renotifica los DOWN ya conocidos', async () => {
    // Primer "proceso": detecta down, notifica, persiste
    const sched1 = buildFakeScheduler();
    const notif1 = buildFakeNotifier();
    const w1 = createClusterWatcher({
      logger: noopLogger,
      scheduler: sched1.scheduler,
      notificationService: notif1.service,
      healthChecker: allDownChecker,
      targets: [targets[0]],
      historyStore: { append: async () => {}, read: async () => [] },
      stateStore,
      retryDelayMs: 10,
    });
    w1.start();
    await w1.checkAll();
    await sched1.runPending();
    assert.equal(notif1.sent.length, 1, 'primer proceso notifica');
    // Esperamos al debounce de persist
    await new Promise((r) => setTimeout(r, 600));

    // Segundo "proceso": rearma desde el store, sigue down, no debe notificar
    const sched2 = buildFakeScheduler();
    const notif2 = buildFakeNotifier();
    const w2 = createClusterWatcher({
      logger: noopLogger,
      scheduler: sched2.scheduler,
      notificationService: notif2.service,
      healthChecker: allDownChecker,
      targets: [targets[0]],
      historyStore: { append: async () => {}, read: async () => [] },
      stateStore,
      retryDelayMs: 10,
    });
    w2.start();
    // start() hidrata async; esperamos
    await new Promise((r) => setTimeout(r, 50));
    await w2.checkAll();
    await sched2.runPending();
    assert.equal(notif2.sent.length, 0, 'tras restart NO renotifica down conocido');
  });
});
