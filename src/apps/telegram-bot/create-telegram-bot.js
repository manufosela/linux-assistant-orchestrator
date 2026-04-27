import TelegramBot from 'node-telegram-bot-api';

/**
 * Creates and configures a Telegram bot instance.
 * Uses long-polling mode for simple deployment without a public HTTPS endpoint.
 *
 * @param {string} token
 * @param {import('pino').Logger} logger
 * @returns {{ bot: TelegramBot, start: () => void, stop: () => Promise<void> }}
 */
export function createTelegramBot(token, logger) {
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is required. Set it in your .env file.');
  }

  const bot = new TelegramBot(token, { polling: false });

  /**
   * Starts the bot polling loop.
   */
  function start() {
    bot.startPolling({ restart: true });
    logger.info('Telegram bot polling started');
  }

  /**
   * Stops the bot and cleans up.
   *
   * @returns {Promise<void>}
   */
  async function stop() {
    await bot.stopPolling();
    logger.info('Telegram bot polling stopped');
  }

  return { bot, start, stop };
}
