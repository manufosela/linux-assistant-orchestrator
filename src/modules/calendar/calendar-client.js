/**
 * Calendar client placeholder.
 *
 * Real implementations will support Google Calendar and Microsoft Graph.
 * This module is read-only.
 *
 * @returns {import('../../../types/calendar.js').CalendarClient}
 */
export function createCalendarClient() {
  /** @returns {Promise<never>} */
  async function getTodayEvents() {
    throw new CalendarNotImplementedError('getTodayEvents');
  }

  /**
   * @param {number} [days]
   * @returns {Promise<never>}
   */
  async function getUpcomingEvents(days) {
    void days;
    throw new CalendarNotImplementedError('getUpcomingEvents');
  }

  /**
   * @param {string} eventId
   * @returns {Promise<never>}
   */
  async function getEventById(eventId) {
    void eventId;
    throw new CalendarNotImplementedError('getEventById');
  }

  return { getTodayEvents, getUpcomingEvents, getEventById };
}

export class CalendarNotImplementedError extends Error {
  /** @param {string} operation */
  constructor(operation) {
    super(`Calendar integration not implemented: ${operation}. Set CALENDAR_PROVIDER to enable.`);
    this.name = 'CalendarNotImplementedError';
  }
}
