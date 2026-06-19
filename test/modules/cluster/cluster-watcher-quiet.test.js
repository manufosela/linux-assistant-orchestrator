import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createClusterWatcher, isInQuietWindow } from '../../../src/modules/cluster/cluster-watcher.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function buildFakeScheduler() {
  const delays = [];
  return {
    scheduler: {
      schedule(task, ms) { return { stop() {} }; },
      delay(task, ms) { delays.push({ task, ms }); return { cancel() {} }; },
      stopAll() {},
    },
    delays,
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
    service: {
      async sendNotification(msg) { sent.push(msg); },
    },
  };
}

function buildHealthChecker(perTargetResults) {
  return {
    checks: [],
    async check(target) {
      this.checks.push(target.id);
      const queue = perTargetResults[target.id] ?? [{ ok: true }];
      return queue.length === 1 ? queue[0] : queue.shift();
    },
  };
}

const targets = [{ id: 'ha:t1', node: 'n2', service: 'ha', host: '1.2.3.4', port: 8123 }];

describe('isInQuietWindow', () => {
  it('ventana mismo día (02:00-08:00) entra a 03:00, no a 09:00', () => {
    const w = { startMin: 120, endMin: 480 };
    assert.equal(isInQuietWindow(new Date(2026, 5, 19, 3, 0), w), true);
    assert.equal(isInQuietWindow(new Date(2026, 5, 19, 8, 0), w), false);
    assert.equal(isInQuietWindow(new Date(2026, 5, 19, 9, 0), w), false);
  });

  it('ventana cruzando medianoche (23:00-08:00)', () => {
    const w = { startMin: 23 * 60, endMin: 8 * 60 };
    assert.equal(isInQuietWindow(new Date(2026, 5, 19, 23, 30), w), true);
    assert.equal(isInQuietWindow(new Date(2026, 5, 20, 2, 0), w), true);
    assert.equal(isInQuietWindow(new Date(2026, 5, 20, 7, 59), w), true);
    assert.equal(isInQuietWindow(new Date(2026, 5, 20, 8, 0), w), false);
    assert.equal(isInQuietWindow(new Date(2026, 5, 20, 22, 59), w), false);
  });

  it('null window → siempre false', () => {
    assert.equal(isInQuietWindow(new Date(), null), false);
  });
});

describe('createClusterWatcher con quiet hours', () => {
  it('servicio cae a las 03:00 y se recupera a las 03:30: ninguna notificación', async () => {
    let mockNow = new Date(2026, 5, 19, 3, 0); // 03:00
    const sched = buildFakeScheduler();
    const notifier = buildFakeNotifier();
    const checker = buildHealthChecker({
      'ha:t1': [{ ok: false }, { ok: false }], // primer evaluate + retry → ambos fallan
    });
    const w = createClusterWatcher({
      logger: noopLogger,
      scheduler: sched.scheduler,
      notificationService: notifier.service,
      healthChecker: checker,
      targets,
      historyStore: { append: async () => {}, read: async () => [] },
      quietWindowStart: '23:00',
      quietWindowEnd: '08:00',
      nowFn: () => mockNow,
    });
    await w.checkAll();              // marca pending y agenda retry
    await sched.runPending();              // ejecuta retry (servicio sigue down)
    // En quiet hours: NO notify
    assert.equal(notifier.sent.length, 0, 'down suprimido en quiet hours');

    // Avanzamos a las 03:30 y se recupera
    mockNow = new Date(2026, 5, 19, 3, 30);
    checker.check = async () => ({ ok: true });
    await w.checkAll();
    assert.equal(notifier.sent.length, 0, 'recovered también suprimido (down no fue notificado)');
  });

  it('servicio cae a las 03:00 y SIGUE caído tras las 08:00 → SE NOTIFICA', async () => {
    let mockNow = new Date(2026, 5, 19, 3, 0);
    const sched = buildFakeScheduler();
    const notifier = buildFakeNotifier();
    const checker = buildHealthChecker({
      'ha:t1': [{ ok: false }, { ok: false }],
    });
    const w = createClusterWatcher({
      logger: noopLogger,
      scheduler: sched.scheduler,
      notificationService: notifier.service,
      healthChecker: checker,
      targets,
      historyStore: { append: async () => {}, read: async () => [] },
      quietWindowStart: '23:00',
      quietWindowEnd: '08:00',
      nowFn: () => mockNow,
    });
    await w.checkAll();
    await sched.runPending();
    assert.equal(notifier.sent.length, 0);

    // 08:30: ya fuera de quiet hours, servicio sigue down
    mockNow = new Date(2026, 5, 19, 8, 30);
    checker.check = async () => ({ ok: false, detail: 'sigue caído' });
    await w.checkAll();
    assert.equal(notifier.sent.length, 1, 'down notificado al salir de quiet hours');
    assert.match(notifier.sent[0].text, /no responde/);
  });

  it('comportamiento clásico sin quiet hours: down notifica inmediato', async () => {
    const sched = buildFakeScheduler();
    const notifier = buildFakeNotifier();
    const checker = buildHealthChecker({
      'ha:t1': [{ ok: false }, { ok: false }],
    });
    const w = createClusterWatcher({
      logger: noopLogger,
      scheduler: sched.scheduler,
      notificationService: notifier.service,
      healthChecker: checker,
      targets,
      historyStore: { append: async () => {}, read: async () => [] },
      // sin quietWindow*
    });
    await w.checkAll();
    await sched.runPending();
    assert.equal(notifier.sent.length, 1, 'down notificado al instante');
  });

  it('quiet hours mal formado → tratado como sin window', async () => {
    const sched = buildFakeScheduler();
    const notifier = buildFakeNotifier();
    const checker = buildHealthChecker({ 'ha:t1': [{ ok: false }, { ok: false }] });
    const w = createClusterWatcher({
      logger: noopLogger,
      scheduler: sched.scheduler,
      notificationService: notifier.service,
      healthChecker: checker,
      targets,
      historyStore: { append: async () => {}, read: async () => [] },
      quietWindowStart: 'no-valido',
      quietWindowEnd: '08:00',
    });
    await w.checkAll();
    await sched.runPending();
    assert.equal(notifier.sent.length, 1);
  });
});
