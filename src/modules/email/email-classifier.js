/**
 * Email classifier placeholder.
 * Will use the local LLM to detect emails requiring attention.
 *
 * @returns {object}
 */
export function createEmailClassifier() {
  /** @returns {Promise<never>} */
  async function classifyBatch() {
    throw new Error('Email classifier not implemented. Set EMAIL_PROVIDER to enable.');
  }

  return { classifyBatch };
}
