import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createNotificationService } from '../../../src/modules/notifications/notification-service.js';

const silentLogger = { warn: () => {}, error: () => {} };

function fakeChannel() {
  const sent = [];
  return { sent, channel: { name: 'fake', send: async (m) => { sent.push(m); } } };
}

function fakeLogStore() {
  const added = [];
  return { added, store: { add: async (m) => { added.push(m); } } };
}

describe('createNotificationService', () => {
  it('un aviso urgente sale por los canales y queda en el registro', async () => {
    const { sent, channel } = fakeChannel();
    const { added, store } = fakeLogStore();
    const service = createNotificationService([channel], silentLogger, { logStore: store });

    await service.sendNotification({ text: 'tormenta', level: 'warn', urgent: true });

    assert.deepEqual(sent.map((m) => m.text), ['tormenta']);
    assert.deepEqual(added, [{ text: 'tormenta', level: 'warn', urgent: true }]);
  });

  it('un aviso no urgente (aunque sea warn) solo queda en el registro', async () => {
    const { sent, channel } = fakeChannel();
    const { added, store } = fakeLogStore();
    const service = createNotificationService([channel], silentLogger, { logStore: store });

    await service.sendNotification({ text: 'n2 pendiente de actualizar', level: 'warn' });
    await service.sendNotification({ text: 'persiana subida', level: 'info' });

    assert.equal(sent.length, 0);
    assert.deepEqual(added.map((m) => [m.text, m.urgent]), [
      ['n2 pendiente de actualizar', false],
      ['persiana subida', false],
    ]);
  });

  it('si el registro falla, el aviso urgente se envía igual y se loguea el error', async () => {
    const { sent, channel } = fakeChannel();
    const errors = [];
    const logger = { warn: () => {}, error: (...a) => errors.push(a) };
    const store = { add: async () => { throw new Error('disco lleno'); } };
    const service = createNotificationService([channel], logger, { logStore: store });

    await service.sendNotification({ text: 'nodo caído', level: 'warn', urgent: true });

    assert.equal(sent.length, 1);
    assert.equal(errors.length, 1);
  });

  it('sin registro configurado, los no urgentes se descartan con aviso en el log', async () => {
    const { sent, channel } = fakeChannel();
    const warnings = [];
    const logger = { warn: (...a) => warnings.push(a), error: () => {} };
    const service = createNotificationService([channel], logger);

    await service.sendNotification({ text: 'lavavajillas', level: 'info' });

    assert.equal(sent.length, 0);
    assert.equal(warnings.length, 1);
  });
});
