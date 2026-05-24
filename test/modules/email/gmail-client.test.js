import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGmailClient } from '../../../src/modules/email/gmail-client.js';

/**
 * Builds a stubbed Gmail API that records calls and returns canned results.
 *
 * @param {{
 *   messageIds?: string[],
 *   messageDetails?: Record<string, { headers: Record<string,string>, snippet: string }>,
 *   listError?: Error,
 *   getErrorIds?: Set<string>,
 * }} [options]
 */
function stubGmailApi(options = {}) {
  const calls = { list: [], get: [] };
  return {
    calls,
    users: {
      messages: {
        async list(params) {
          calls.list.push(params);
          if (options.listError) throw options.listError;
          const ids = options.messageIds ?? [];
          return { data: { messages: ids.map((id) => ({ id })) } };
        },
        async get(params) {
          calls.get.push(params);
          if (options.getErrorIds?.has(params.id)) throw new Error(`get failed for ${params.id}`);
          const details = options.messageDetails?.[params.id];
          if (!details) return { data: { id: params.id, payload: { headers: [] }, snippet: '' } };
          const headers = Object.entries(details.headers).map(([name, value]) => ({ name, value }));
          return { data: { id: params.id, payload: { headers }, snippet: details.snippet } };
        },
      },
    },
  };
}

function stubGoogleAuth() {
  return { getClient: async () => ({ /* opaque auth */ }) };
}

function buildClient(options = {}) {
  const api = stubGmailApi(options.api);
  const client = createGmailClient({
    googleAuth: options.googleAuth ?? stubGoogleAuth(),
    llmService: options.llmService,
    gmailFactory: () => api,
  });
  return { client, api };
}

describe('createGmailClient', () => {
  describe('unreadToday', () => {
    it('returns [] when there are no unread emails', async () => {
      const { client, api } = buildClient({ api: { messageIds: [] } });
      const result = await client.unreadToday();
      assert.deepEqual(result, []);
      assert.equal(api.calls.list.length, 1);
      assert.equal(api.calls.list[0].q, 'is:unread newer_than:1d');
      assert.equal(api.calls.list[0].maxResults, 10);
      assert.equal(api.calls.list[0].userId, 'me');
    });

    it('maps Gmail metadata into EmailSummary objects', async () => {
      const { client } = buildClient({
        api: {
          messageIds: ['m1', 'm2'],
          messageDetails: {
            m1: {
              headers: { From: 'Alice <a@example.com>', Subject: 'Reunión mañana', Date: 'Mon, 13 May 2026 09:00:00 +0200' },
              snippet: 'Confirmamos a las 10',
            },
            m2: {
              headers: { From: 'Bob <b@example.com>', Subject: 'Factura', Date: 'Mon, 13 May 2026 08:30:00 +0200' },
              snippet: 'Adjunto factura del mes',
            },
          },
        },
      });
      const result = await client.unreadToday();
      assert.equal(result.length, 2);
      assert.equal(result[0].from, 'Alice <a@example.com>');
      assert.equal(result[0].subject, 'Reunión mañana');
      assert.equal(result[0].snippet, 'Confirmamos a las 10');
      assert.equal(result[1].from, 'Bob <b@example.com>');
    });

    it('caps maxResults to the hard limit (50) even if a higher number is passed', async () => {
      const { client, api } = buildClient({ api: { messageIds: [] } });
      await client.unreadToday({ maxResults: 9999 });
      assert.equal(api.calls.list[0].maxResults, 50);
    });

    it('clamps maxResults below 1 to 1', async () => {
      const { client, api } = buildClient({ api: { messageIds: [] } });
      await client.unreadToday({ maxResults: 0 });
      assert.equal(api.calls.list[0].maxResults, 1);
    });

    it('drops a single message that fails to fetch instead of aborting the whole list', async () => {
      const { client } = buildClient({
        api: {
          messageIds: ['ok1', 'bad', 'ok2'],
          messageDetails: {
            ok1: { headers: { From: 'a@b', Subject: 'A', Date: 'd' }, snippet: 's1' },
            ok2: { headers: { From: 'c@d', Subject: 'B', Date: 'd' }, snippet: 's2' },
          },
          getErrorIds: new Set(['bad']),
        },
      });
      const result = await client.unreadToday();
      assert.equal(result.length, 2);
      assert.equal(result[0].id, 'ok1');
      assert.equal(result[1].id, 'ok2');
    });

    it('header lookup is case-insensitive', async () => {
      const { client } = buildClient({
        api: {
          messageIds: ['x'],
          messageDetails: { x: { headers: { FROM: 'a@b', subject: 's' }, snippet: '' } },
        },
      });
      const [msg] = await client.unreadToday();
      assert.equal(msg.from, 'a@b');
      assert.equal(msg.subject, 's');
    });
  });

  describe('fromSender', () => {
    it('builds the Gmail "from:" query with the supplied sender', async () => {
      const { client, api } = buildClient({ api: { messageIds: [] } });
      await client.fromSender({ sender: 'mariano@example.com' });
      assert.equal(api.calls.list[0].q, 'from:mariano@example.com');
    });

    it('accepts partial name and domain', async () => {
      const { client, api } = buildClient({ api: { messageIds: [] } });
      await client.fromSender({ sender: 'banco' });
      assert.equal(api.calls.list[0].q, 'from:banco');
    });

    it('rejects empty sender', async () => {
      const { client } = buildClient();
      await assert.rejects(() => client.fromSender({ sender: '' }), /remitente/);
      await assert.rejects(() => client.fromSender({ sender: '   ' }), /remitente/);
    });
  });

  describe('byKeyword', () => {
    it('passes the keyword as raw Gmail query', async () => {
      const { client, api } = buildClient({ api: { messageIds: [] } });
      await client.byKeyword({ keyword: 'factura' });
      assert.equal(api.calls.list[0].q, 'factura');
    });

    it('rejects empty keyword', async () => {
      const { client } = buildClient();
      await assert.rejects(() => client.byKeyword({ keyword: '' }), /palabra/);
    });
  });

  describe('summarize', () => {
    it('returns a friendly message when emails array is empty', async () => {
      const { client } = buildClient();
      assert.equal(await client.summarize([]), 'No hay correos que resumir.');
    });

    it('returns null when llmService is not configured', async () => {
      const { client } = buildClient();
      assert.equal(await client.summarize([{ id: 'x', from: 'a', subject: 's', date: 'd', snippet: 'sn' }]), null);
    });

    it('calls the LLM with a prompt that includes every email', async () => {
      const captured = { calls: [] };
      const llmService = {
        async generateText(prompt, metadata) {
          captured.calls.push({ prompt, metadata });
          return 'resumen del LLM';
        },
      };
      const { client } = buildClient({ llmService });
      const emails = [
        { id: '1', from: 'Alice', subject: 'Reunión', date: 'd', snippet: 'Mañana 10h' },
        { id: '2', from: 'Banco', subject: 'Cargo', date: 'd', snippet: 'Adeudo 42€' },
      ];
      const summary = await client.summarize(emails);
      assert.equal(summary, 'resumen del LLM');
      assert.equal(captured.calls.length, 1);
      assert.match(captured.calls[0].prompt, /Alice/);
      assert.match(captured.calls[0].prompt, /Banco/);
      assert.equal(captured.calls[0].metadata.module, 'gmail');
      assert.equal(captured.calls[0].metadata.private, true);
    });
  });
});
