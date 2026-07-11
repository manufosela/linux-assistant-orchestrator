import { describe, it } from 'node:test';
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

const FIRING = {
  status: 'firing',
  alerts: [{
    status: 'firing',
    labels: { alertname: 'NodeDown', severity: 'critical', instance: '192.168.1.11:9100' },
    annotations: { summary: 'n2 no responde' },
  }],
};

describe('POST /api/hooks/alertmanager', () => {
  it('503 sin token configurado', async () => {
    const app = await start({ notificationService: { sendNotification: async () => {} } });
    try {
      assert.equal((await post(`${app.baseUrl}/api/hooks/alertmanager`, FIRING)).status, 503);
    } finally { await app.stop(); }
  });

  it('401 con token incorrecto', async () => {
    const sent = [];
    const app = await start({ watchtowerWebhookToken: 'secret', notificationService: { sendNotification: async (m) => sent.push(m) } });
    try {
      assert.equal((await post(`${app.baseUrl}/api/hooks/alertmanager?token=nope`, FIRING)).status, 401);
      assert.equal(sent.length, 0);
    } finally { await app.stop(); }
  });

  it('200 firing crítico → mensaje de alerta en español, nivel error', async () => {
    const sent = [];
    const app = await start({ watchtowerWebhookToken: 'secret', notificationService: { sendNotification: async (m) => sent.push(m) } });
    try {
      const res = await post(`${app.baseUrl}/api/hooks/alertmanager?token=secret`, FIRING);
      assert.equal(res.status, 200);
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /alerta.*activa/i);
      assert.match(sent[0].text, /NodeDown/);
      assert.match(sent[0].text, /crítico/);
      assert.match(sent[0].text, /n2 no responde/);
      assert.equal(sent[0].level, 'error');
    } finally { await app.stop(); }
  });

  it('200 resolved → mensaje de recuperación, nivel success', async () => {
    const sent = [];
    const app = await start({ watchtowerWebhookToken: 'secret', notificationService: { sendNotification: async (m) => sent.push(m) } });
    try {
      const payload = {
        status: 'resolved',
        alerts: [{ status: 'resolved', labels: { alertname: 'NodeDown', severity: 'critical', instance: '192.168.1.11:9100' }, annotations: { summary: 'n2 recuperado' } }],
      };
      const res = await post(`${app.baseUrl}/api/hooks/alertmanager?token=secret`, payload);
      assert.equal(res.status, 200);
      assert.match(sent[0].text, /recuperada/i);
      assert.equal(sent[0].level, 'success');
    } finally { await app.stop(); }
  });

  it('warning (no crítico) → nivel warn', async () => {
    const sent = [];
    const app = await start({ watchtowerWebhookToken: 'secret', notificationService: { sendNotification: async (m) => sent.push(m) } });
    try {
      const payload = { status: 'firing', alerts: [{ status: 'firing', labels: { alertname: 'HighTemp', severity: 'warning', instance: 'node-n3' }, annotations: { summary: 'temperatura alta' } }] };
      await post(`${app.baseUrl}/api/hooks/alertmanager?token=secret`, payload);
      assert.equal(sent[0].level, 'warn');
      assert.match(sent[0].text, /aviso/);
    } finally { await app.stop(); }
  });
});
