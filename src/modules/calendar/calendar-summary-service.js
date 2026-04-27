/**
 * Calendar summary service placeholder.
 *
 * @returns {object}
 */
export function createCalendarSummaryService() {
  /** @returns {Promise<never>} */
  async function summariseDay() {
    throw new Error('Calendar summary service not implemented. Set CALENDAR_PROVIDER to enable.');
  }

  return { summariseDay };
}
