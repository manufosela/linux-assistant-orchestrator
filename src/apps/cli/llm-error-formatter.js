/**
 * Formats an LLM-related error into a single, user-friendly line.
 * Detects connection-refused and fetch failures and points the user to the LLM endpoint config.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function formatLlmError(error) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = /** @type {{ message: string }} */ (error).message;
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      return 'LLM provider is not reachable. Check LOCAL_LLM_BASE_URL and that the cluster is up.';
    }
    return `LLM error: ${message}`;
  }
  return 'LLM error: unknown failure.';
}
