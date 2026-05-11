/**
 * Sends a placeholder "thinking" message and returns an updater that edits or replaces it
 * once the async work is done. Designed to give the user immediate feedback while a slow
 * LLM call, web fetch or smart-home command runs in the background.
 *
 * Telegram's `editMessageText` fails when the new text equals the old one, when the message
 * is too old, or when its parse mode is different — in any of those cases we fall back to
 * sending a new message and deleting the placeholder so the chat stays tidy.
 *
 * @param {object} bot - node-telegram-bot-api instance
 * @param {number | string} chatId
 * @param {object} [options]
 * @param {string} [options.text='⏳ Pensando…'] - text shown while the work runs
 * @param {string} [options.parseMode] - parse mode used for the initial placeholder
 * @param {import('pino').Logger} [options.logger]
 * @returns {Promise<ThinkingIndicator>}
 */
export async function createThinkingIndicator(bot, chatId, options = {}) {
  const { text = '⏳ Pensando…', parseMode, logger } = options;

  const initialOptions = parseMode ? { parse_mode: parseMode } : {};
  const sent = await bot.sendMessage(chatId, text, initialOptions);
  const messageId = sent?.message_id;

  let resolved = false;

  /**
   * Replaces the placeholder with the final text. Idempotent: only the first call has effect.
   *
   * @param {string} finalText
   * @param {object} [opts] - extra options forwarded to editMessageText / sendMessage
   * @returns {Promise<void>}
   */
  async function finish(finalText, opts = {}) {
    if (resolved) return;
    resolved = true;

    try {
      await bot.editMessageText(finalText, {
        chat_id: chatId,
        message_id: messageId,
        ...opts,
      });
    } catch (error) {
      logger?.warn(
        { chatId, messageId, err: error?.message },
        'editMessageText failed — falling back to send + delete',
      );
      try {
        await bot.sendMessage(chatId, finalText, opts);
      } catch (sendError) {
        logger?.error({ chatId, err: sendError?.message }, 'Fallback sendMessage also failed');
      }
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch {
        // Deleting may fail if the message is older than 48h or if the bot lacks
        // permission; either way the user already got the final answer.
      }
    }
  }

  /**
   * Removes the placeholder without replacing it. Use when the response is delivered via
   * a different message (e.g. one new message per item) and the placeholder should just vanish.
   *
   * @returns {Promise<void>}
   */
  async function cancel() {
    if (resolved) return;
    resolved = true;
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (error) {
      logger?.warn({ chatId, messageId, err: error?.message }, 'deleteMessage failed during cancel');
    }
  }

  return { messageId, finish, cancel };
}

/**
 * @typedef {Object} ThinkingIndicator
 * @property {number | undefined} messageId - Telegram message id of the placeholder
 * @property {(finalText: string, opts?: object) => Promise<void>} finish - Replace placeholder with final text
 * @property {() => Promise<void>} cancel - Delete placeholder without sending a replacement
 */
