import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGoogleCalendarClient } from '../../../src/modules/calendar/google-calendar-client.js';

function stubCalendarApi(options = {}) {
  const calls = [];
  return {
    calls,
    events: {
      async list(params) {
        calls.push(params);
        const items = options.itemsPerCall?.shift() ?? options.items ?? [];
        return { data: { items } };
      },
    },
  };
}

const stubAuth = { getClient: async () => ({}) };

const FIXED_NOW = new Date('2026-05-13T11:00:00+02:00');

function buildClient(options = {}) {
  const api = stubCalendarApi(options.api);
  const client = createGoogleCalendarClient({
    googleAuth: stubAuth,
    calendarFactory: () => api,
    now: () => new Date(FIXED_NOW),
  });
  return { client, api };
}

function event(overrides = {}) {
  return {
    id: 'evt1',
    summary: 'Reunión equipo',
    description: 'desc',
    location: 'Sala 1',
    start: { dateTime: '2026-05-13T10:00:00+02:00' },
    end: { dateTime: '2026-05-13T11:00:00+02:00' },
    attendees: [{ email: 'a@b.com' }, { email: 'c@d.com' }],
    htmlLink: 'https://calendar.google.com/...',
    ...overrides,
  };
}

describe('createGoogleCalendarClient', () => {
  describe('today', () => {
    it('queries [startOfDay, startOfNextDay) and returns mapped events', async () => {
      const { client, api } = buildClient({ api: { items: [event()] } });
      const events = await client.today();
      assert.equal(events.length, 1);
      assert.equal(events[0].summary, 'Reunión equipo');
      assert.equal(events[0].allDay, false);
      assert.deepEqual(events[0].attendees, ['a@b.com', 'c@d.com']);
      // El rango debe abarcar todo "el día de hoy" en zona local
      const params = api.calls[0];
      const min = new Date(params.timeMin);
      const max = new Date(params.timeMax);
      assert.equal(max - min, 24 * 60 * 60 * 1000);
      assert.equal(params.singleEvents, true);
      assert.equal(params.orderBy, 'startTime');
      assert.equal(params.calendarId, 'primary');
    });

    it('returns [] when no items', async () => {
      const { client } = buildClient({ api: { items: [] } });
      assert.deepEqual(await client.today(), []);
    });

    it('detects all-day events (start.date, no dateTime)', async () => {
      const { client } = buildClient({
        api: { items: [event({ start: { date: '2026-05-13' }, end: { date: '2026-05-14' } })] },
      });
      const [e] = await client.today();
      assert.equal(e.allDay, true);
      assert.equal(e.start, '2026-05-13');
    });

    it('skips items without start', async () => {
      const { client } = buildClient({
        api: { items: [event({ start: null }), event({ id: 'ok' })] },
      });
      const events = await client.today();
      assert.equal(events.length, 1);
      assert.equal(events[0].id, 'ok');
    });
  });

  describe('tomorrow', () => {
    it('shifts the window by 1 day', async () => {
      const { client, api } = buildClient({ api: { items: [] } });
      await client.tomorrow();
      const params = api.calls[0];
      const min = new Date(params.timeMin);
      // El timeMin de tomorrow debería ser mayor que el de today
      const todayClient = buildClient({ api: { items: [] } });
      await todayClient.client.today();
      const todayMin = new Date(todayClient.api.calls[0].timeMin);
      assert.ok(min > todayMin);
    });
  });

  describe('week', () => {
    it('covers a 7-day window from start of today', async () => {
      const { client, api } = buildClient({ api: { items: [] } });
      await client.week();
      const params = api.calls[0];
      const min = new Date(params.timeMin);
      const max = new Date(params.timeMax);
      assert.equal(max - min, 7 * 24 * 60 * 60 * 1000);
    });
  });

  describe('next', () => {
    it('returns the first event when there is one', async () => {
      const { client, api } = buildClient({ api: { items: [event({ summary: 'Próximo' })] } });
      const evt = await client.next();
      assert.ok(evt);
      assert.equal(evt.summary, 'Próximo');
      // maxResults=1 para no malgastar cuota
      assert.equal(api.calls[0].maxResults, 1);
    });

    it('returns null when nothing scheduled', async () => {
      const { client } = buildClient({ api: { items: [] } });
      assert.equal(await client.next(), null);
    });

    it('horizon is 30 days from now', async () => {
      const { client, api } = buildClient({ api: { items: [] } });
      await client.next();
      const params = api.calls[0];
      const min = new Date(params.timeMin);
      const max = new Date(params.timeMax);
      assert.equal(max - min, 30 * 24 * 60 * 60 * 1000);
    });
  });
});
