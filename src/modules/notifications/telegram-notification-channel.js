/**
 * Creates a Telegram notification channel.
 * Sends messages to the configured default chat ID.
 *
 * @param {object} bot - node-telegram-bot-api instance
 * @param {string} defaultChatId
 * @param {import('pino').Logger} logger
 * @returns {import('./notification-service.js').NotificationChannel}
 */
export function createTelegramNotificationChannel(bot, defaultChatId, logger) {
  /**
   * Sends a notification to Telegram.
   *
   * @param {import('./notification-service.js').NotificationMessage} message
   * @returns {Promise<void>}
   */
  async function send(message) {
    const chatId = message.chatId ?? defaultChatId;

    if (!chatId) {
      logger.warn('Telegram notification skipped: no chat ID configured');
      return;
    }

    const prefix = levelPrefix(message.level);
    const text = prefix ? `${prefix} ${message.text}` : message.text;

    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    logger.debug({ chatId }, 'Telegram notification sent');
  }

  /**
   * Returns a plain-text prefix for a notification level.
   *
   * @param {string | undefined} level
   * @returns {string}
   */
  function levelPrefix(level) {
    switch (level) {
      case 'error': return '[ERROR]';
      case 'warn': return '[WARN]';
      case 'success': return '[OK]';
      default: return '';
    }
  }

  return { name: 'telegram', send };
}
