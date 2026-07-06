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

describe('POST /api/hooks/notify', () => {
  it('503 cuando no hay token configurado', async () => {
    const app = await start({ notificationService: { sendNotification: async () => {} } });
    try {
      const res = await post(`${app.baseUrl}/api/hooks/notify`, { message: 'x' });
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
      const noToken = await post(`${app.baseUrl}/api/hooks/notify`, { message: 'x' });
      assert.equal(noToken.status, 401);
      const badToken = await post(`${app.baseUrl}/api/hooks/notify?token=nope`, { message: 'x' });
      assert.equal(badToken.status, 401);
      assert.equal(sent.length, 0);
    } finally {
      await app.stop();
    }
  });

  it('400 si el message está vacío', async () => {
    const sent = [];
    const app = await start({
      watchtowerWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      const res = await post(`${app.baseUrl}/api/hooks/notify?token=secret`, { message: '   ' });
      assert.equal(res.status, 400);
      assert.equal(sent.length, 0);
    } finally {
      await app.stop();
    }
  });

  it('200 y reemite el texto multilínea TAL CUAL (preserva el desglose)', async () => {
    const sent = [];
    const app = await start({
      watchtowerWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      const message = '✅ Descargas de Telegram organizadas en el NAS\n📦 38 archivos movidos\n📖 Cómics: 38';
      const res = await post(`${app.baseUrl}/api/hooks/notify?token=secret`, { message });
      assert.equal(res.status, 200);
      assert.equal(sent.length, 1);
      // No se aplana: siguen las 3 líneas y el desglose.
      assert.match(sent[0].text, /Descargas de Telegram organizadas en el NAS/);
      assert.match(sent[0].text, /📦 38 archivos movidos/);
      assert.match(sent[0].text, /📖 Cómics: 38/);
      assert.equal(sent[0].text.split('\n').length, 3);
      assert.equal(sent[0].level, 'info');
    } finally {
      await app.stop();
    }
  });

  it('acepta token por cabecera y nivel personalizado', async () => {
    const sent = [];
    const app = await start({
      watchtowerWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      const res = await fetch(`${app.baseUrl}/api/hooks/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Token': 'secret' },
        body: JSON.stringify({ message: 'línea 1\nlínea 2', level: 'success' }),
      });
      assert.equal(res.status, 200);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].level, 'success');
    } finally {
      await app.stop();
    }
  });

  it('escapa < > & para HTML de Telegram', async () => {
    const sent = [];
    const app = await start({
      watchtowerWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      const res = await post(`${app.baseUrl}/api/hooks/notify?token=secret`, { message: 'a < b & c > d' });
      assert.equal(res.status, 200);
      assert.match(sent[0].text, /a &lt; b &amp; c &gt; d/);
    } finally {
      await app.stop();
    }
  });
});
