/**
 * Calendar reminder service placeholder.
 *
 * @returns {object}
 */
export function createCalendarReminderService() {
  /** @returns {Promise<never>} */
  async function sendUpcomingReminders() {
    throw new Error('Calendar reminder service not implemented. Set CALENDAR_PROVIDER to enable.');
  }

  return { sendUpcomingReminders };
}
