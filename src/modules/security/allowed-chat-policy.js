/**
 * Creates a policy that validates Telegram chat IDs against an allowlist.
 * Unauthorized chats are rejected without exposing the allowlist contents.
 *
 * @param {string[]} allowedChatIds
 * @param {import('pino').Logger} logger
 * @returns {AllowedChatPolicy}
 */
export function createAllowedChatPolicy(allowedChatIds, logger) {
  const allowedSet = new Set(allowedChatIds.map(String));

  /**
   * Returns true if the given chat ID is in the allowlist.
   *
   * @param {string | number} chatId
   * @returns {boolean}
   */
  function isAllowed(chatId) {
    return allowedSet.has(String(chatId));
  }

  /**
   * Validates a chat ID and logs a warning for unauthorized access attempts.
   * Never logs the allowlist contents to avoid leaking sensitive IDs.
   *
   * @param {string | number} chatId
   * @returns {boolean}
   */
  function validate(chatId) {
    if (isAllowed(chatId)) return true;

    logger.warn({ chatId }, 'Unauthorized Telegram chat ID rejected');
    return false;
  }

  /**
   * Returns the number of allowed chat IDs (without exposing them).
   *
   * @returns {number}
   */
  function getAllowedCount() {
    return allowedSet.size;
  }

  return { isAllowed, validate, getAllowedCount };
}

/**
 * @typedef {Object} AllowedChatPolicy
 * @property {(chatId: string | number) => boolean} isAllowed
 * @property {(chatId: string | number) => boolean} validate
 * @property {() => number} getAllowedCount
 */
