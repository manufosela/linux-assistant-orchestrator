import { google } from 'googleapis';

const DEFAULT_TIMEZONE = 'Europe/Madrid';
const NEXT_EVENT_HORIZON_DAYS = 30;
const MAX_RESULTS_DEFAULT = 25;

/**
 * Read-only Google Calendar client used by LUIS.
 *
 * Métodos públicos:
 *  - `today()`     → eventos del calendario primario entre 00:00 y 24:00 de hoy
 *  - `tomorrow()`  → eventos del día siguiente completo
 *  - `week()`      → eventos desde ahora hasta 7 días después
 *  - `next()`      → próximo evento dentro de los siguientes 30 días (o null si no hay)
 *
 * Solo usa el calendario `primary` del usuario autenticado. Solo lectura — no expone create,
 * update ni delete, y los scopes OAuth son `calendar.readonly`.
 *
 * @param {{
 *   googleAuth: import('../google/google-auth.js').GoogleAuth,
 *   logger?: import('pino').Logger,
 *   calendarFactory?: (auth: object) => CalendarApi,
 *   timezone?: string,
 *   now?: () => Date,
 * }} deps
 * @returns {GoogleCalendarClient}
 */
export function createGoogleCalendarClient({ googleAuth, logger, calendarFactory, timezone = DEFAULT_TIMEZONE, now }) {
  const createApi = calendarFactory ?? ((auth) => google.calendar({ version: 'v3', auth }));
  const clock = typeof now === 'function' ? now : () => new Date();

  /**
   * @returns {Promise<CalendarApi>}
   */
  async function calendar() {
    const auth = await googleAuth.getClient();
    return createApi(auth);
  }

  /**
   * Lists events in the given range from the user's primary calendar, expanded (recurring
   * events become single instances) and sorted by start time.
   *
   * @param {{ timeMin: Date, timeMax: Date, maxResults?: number }} input
   * @returns {Promise<CalendarEvent[]>}
   */
  async function listEvents({ timeMin, timeMax, maxResults = MAX_RESULTS_DEFAULT }) {
    const api = await calendar();
    logger?.info(
      { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), maxResults },
      'Calendar listEvents: requesting',
    );

    const res = await api.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: timezone,
    });
    const items = res?.data?.items ?? [];
    const events = items.map(toCalendarEvent).filter(Boolean);
    logger?.info({ count: events.length }, 'Calendar listEvents: fetched');
    return events;
  }

  /**
   * @returns {Promise<CalendarEvent[]>}
   */
  async function today() {
    const { start, end } = dayRange(clock());
    return listEvents({ timeMin: start, timeMax: end });
  }

  /**
   * @returns {Promise<CalendarEvent[]>}
   */
  async function tomorrow() {
    const ref = clock();
    ref.setDate(ref.getDate() + 1);
    const { start, end } = dayRange(ref);
    return listEvents({ timeMin: start, timeMax: end });
  }

  /**
   * Desde el inicio del día actual hasta 7 días después.
   *
   * @returns {Promise<CalendarEvent[]>}
   */
  async function week() {
    const start = startOfDay(clock());
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return listEvents({ timeMin: start, timeMax: end });
  }

  /**
   * Próximo evento (uno solo) en los siguientes 30 días.
   *
   * @returns {Promise<CalendarEvent | null>}
   */
  async function next() {
    const start = clock();
    const end = new Date(start);
    end.setDate(end.getDate() + NEXT_EVENT_HORIZON_DAYS);
    const [first] = await listEvents({ timeMin: start, timeMax: end, maxResults: 1 });
    return first ?? null;
  }

  return { today, tomorrow, week, next, listEvents };
}

/**
 * Normalises a Google Calendar event item into the shape LUIS uses internally.
 *
 * @param {any} item
 * @returns {CalendarEvent | null}
 */
function toCalendarEvent(item) {
  const startRaw = item?.start?.dateTime ?? item?.start?.date;
  const endRaw = item?.end?.dateTime ?? item?.end?.date;
  if (!startRaw) return null;
  return {
    id: String(item.id ?? ''),
    summary: String(item.summary ?? '(sin título)'),
    description: String(item.description ?? ''),
    location: String(item.location ?? ''),
    start: startRaw,
    end: endRaw ?? '',
    allDay: !item?.start?.dateTime,
    attendees: Array.isArray(item.attendees)
      ? item.attendees.map((a) => String(a?.email ?? '')).filter(Boolean)
      : [],
    htmlLink: String(item.htmlLink ?? ''),
  };
}

/**
 * Returns the [start, end) range covering the entire local day of the given date.
 *
 * @param {Date} date
 * @returns {{ start: Date, end: Date }}
 */
function dayRange(date) {
  const start = startOfDay(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

/**
 * @param {Date} date
 * @returns {Date}
 */
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * @typedef {Object} CalendarEvent
 * @property {string} id
 * @property {string} summary
 * @property {string} description
 * @property {string} location
 * @property {string} start  - ISO timestamp (dateTime) or date string (YYYY-MM-DD) for all-day
 * @property {string} end
 * @property {boolean} allDay
 * @property {string[]} attendees
 * @property {string} htmlLink
 */

/**
 * @typedef {Object} CalendarApi
 * @property {{ list: (params: object) => Promise<any> }} events
 */

/**
 * @typedef {Object} GoogleCalendarClient
 * @property {() => Promise<CalendarEvent[]>} today
 * @property {() => Promise<CalendarEvent[]>} tomorrow
 * @property {() => Promise<CalendarEvent[]>} week
 * @property {() => Promise<CalendarEvent | null>} next
 * @property {(input: { timeMin: Date, timeMax: Date, maxResults?: number }) => Promise<CalendarEvent[]>} listEvents
 */
