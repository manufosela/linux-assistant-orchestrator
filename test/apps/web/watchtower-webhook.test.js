import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createWebApp } from '../../../src/apps/web/create-web-app.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function baseDeps(overrides = {}) {
  return {
    llmService: { checkHealth: async () => ({ healthy: true }) },
    statusService: { getStatus: () => ({ modules: [] }) },
    rulesRepository: { loadRules: async () => [] },
    logger: silentLogger,
    host: '127.0.0.1',
    port: 0,
    ...overrides,
  };
}

async function start(overrides) {
  const app = createWebApp(baseDeps(overrides));
  await app.start();
  const { port } = app.server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, stop: () => app.stop() };
}

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/hooks/watchtower', () => {
  it('503 cuando no hay token configurado (webhook desactivado)', async () => {
    const app = await start({ notificationService: { sendNotification: async () => {} } });
    try {
      const res = await post(`${app.baseUrl}/api/hooks/watchtower`, { message: 'x' });
      assert.equal(res.status, 503);
    } finally {
      await app.stop();
    }
  });

  it('401 con token ausente o incorrecto', async () => {
    const sent = [];
    const app = await start({
      watchtowerWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      const noToken = await post(`${app.baseUrl}/api/hooks/watchtower`, { message: 'x' });
      assert.equal(noToken.status, 401);
      const badToken = await post(`${app.baseUrl}/api/hooks/watchtower?token=nope`, { message: 'x' });
      assert.equal(badToken.status, 401);
      assert.equal(sent.length, 0);
    } finally {
      await app.stop();
    }
  });

  it('200 con token válido y reenvía la notificación formateada', async () => {
    const sent = [];
    const app = await start({
      watchtowerWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      const res = await post(`${app.baseUrl}/api/hooks/watchtower?token=secret`, {
        host: 'n2',
        updated: [{ name: 'luis', image: 'luis:local', old: 'a1', new: 'b2' }],
      });
      assert.equal(res.status, 200);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].level, 'success');
      assert.match(sent[0].text, /Watchtower · n2/);
      assert.match(sent[0].text, /✅ luis/);
    } finally {
      await app.stop();
    }
  });

  it('acepta el token por cabecera X-Webhook-Token', async () => {
    const sent = [];
    const app = await start({
      watchtowerWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      const res = await fetch(`${app.baseUrl}/api/hooks/watchtower`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Token': 'secret' },
        body: JSON.stringify({ message: 'Found 0 containers to update' }),
      });
      assert.equal(res.status, 200);
      assert.equal(sent.length, 1);
    } finally {
      await app.stop();
    }
  });

  it('acepta cuerpo NO-JSON (texto plano de shoutrrr) sin 400', async () => {
    const sent = [];
    const app = await start({
      watchtowerWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      const res = await fetch(`${app.baseUrl}/api/hooks/watchtower?token=secret`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'Found 1 container to update: luis',
      });
      assert.equal(res.status, 200);
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /Found 1 container to update: luis/);
    } finally {
      await app.stop();
    }
  });
});
