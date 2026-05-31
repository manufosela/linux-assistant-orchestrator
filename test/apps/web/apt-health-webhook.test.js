import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createWebApp } from '../../../src/apps/web/create-web-app.js';
import { _resetAptHealthDedup } from '../../../src/apps/web/web-routes.js';

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

function post(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/hooks/apt-health', () => {
  beforeEach(() => _resetAptHealthDedup());

  it('503 cuando no hay token configurado', async () => {
    const app = await start({ notificationService: { sendNotification: async () => {} } });
    try {
      const res = await post(`${app.baseUrl}/api/hooks/apt-health`, { host: 'n4', event: 'upgrade-failed' });
      assert.equal(res.status, 503);
    } finally {
      await app.stop();
    }
  });

  it('401 con Bearer ausente o incorrecto', async () => {
    const sent = [];
    const app = await start({
      aptHealthWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      const noToken = await post(`${app.baseUrl}/api/hooks/apt-health`, { host: 'n4', event: 'upgrade-failed' });
      assert.equal(noToken.status, 401);
      const badToken = await post(`${app.baseUrl}/api/hooks/apt-health`, { host: 'n4', event: 'upgrade-failed' }, { Authorization: 'Bearer wrong' });
      assert.equal(badToken.status, 401);
      assert.equal(sent.length, 0);
    } finally {
      await app.stop();
    }
  });

  it('200 con Authorization: Bearer válido y reenvía notificación', async () => {
    const sent = [];
    const app = await start({
      aptHealthWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      const res = await post(
        `${app.baseUrl}/api/hooks/apt-health`,
        { host: 'n4', event: 'upgrade-failed', detail: 'dpkg roto', day: '2026-05-31' },
        { Authorization: 'Bearer secret' },
      );
      assert.equal(res.status, 200);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].level, 'warn');
      assert.match(sent[0].text, /APT.*n4.*unattended-upgrade falló/);
      assert.match(sent[0].text, /dpkg roto/);
    } finally {
      await app.stop();
    }
  });

  it('acepta también ?token= como fallback (curl simple desde scripts)', async () => {
    const sent = [];
    const app = await start({
      aptHealthWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      const res = await post(
        `${app.baseUrl}/api/hooks/apt-health?token=secret`,
        { host: 'n4', event: 'reboot-pending', days: 9, day: '2026-05-31' },
      );
      assert.equal(res.status, 200);
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /reboot pendiente desde hace 9 días/);
    } finally {
      await app.stop();
    }
  });

  it('deduplica el mismo (host+event+día) en envíos repetidos', async () => {
    const sent = [];
    const app = await start({
      aptHealthWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      const first = await post(
        `${app.baseUrl}/api/hooks/apt-health?token=secret`,
        { host: 'n4', event: 'upgrade-failed', day: '2026-05-31', detail: 'd1' },
      );
      assert.equal(first.status, 200);
      assert.equal(sent.length, 1);
      const second = await post(
        `${app.baseUrl}/api/hooks/apt-health?token=secret`,
        { host: 'n4', event: 'upgrade-failed', day: '2026-05-31', detail: 'd2' },
      );
      assert.equal(second.status, 200);
      const body = await second.json();
      assert.equal(body.deduplicated, true);
      assert.equal(sent.length, 1, 'no debe reenviar el segundo');
    } finally {
      await app.stop();
    }
  });

  it('día distinto rompe la dedup (mismo host+event al día siguiente sí avisa)', async () => {
    const sent = [];
    const app = await start({
      aptHealthWebhookToken: 'secret',
      notificationService: { sendNotification: async (m) => sent.push(m) },
    });
    try {
      await post(`${app.baseUrl}/api/hooks/apt-health?token=secret`, { host: 'n4', event: 'upgrade-failed', day: '2026-05-31' });
      await post(`${app.baseUrl}/api/hooks/apt-health?token=secret`, { host: 'n4', event: 'upgrade-failed', day: '2026-06-01' });
      assert.equal(sent.length, 2);
    } finally {
      await app.stop();
    }
  });

  it('503 cuando notificationService no está configurado', async () => {
    const app = await start({ aptHealthWebhookToken: 'secret' });
    try {
      const res = await post(
        `${app.baseUrl}/api/hooks/apt-health`,
        { host: 'n4', event: 'upgrade-failed' },
        { Authorization: 'Bearer secret' },
      );
      assert.equal(res.status, 503);
    } finally {
      await app.stop();
    }
  });
});
