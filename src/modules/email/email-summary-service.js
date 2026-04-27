/**
 * Email summary service placeholder.
 * Will use the local LLM to summarise email batches.
 *
 * @returns {object}
 */
export function createEmailSummaryService() {
  /** @returns {Promise<never>} */
  async function summariseUnread() {
    throw new Error('Email summary service not implemented. Set EMAIL_PROVIDER to enable.');
  }

  return { summariseUnread };
}
