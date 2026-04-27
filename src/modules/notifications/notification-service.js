/**
 * Creates a notification service that dispatches messages through configured channels.
 * Supports multiple channels: Telegram (initial), desktop, email, Slack (future).
 *
 * @param {NotificationChannel[]} channels
 * @param {import('pino').Logger} logger
 * @returns {NotificationService}
 */
export function createNotificationService(channels, logger) {
  /**
   * Sends a notification through all configured channels.
   *
   * @param {NotificationMessage} message
   * @returns {Promise<void>}
   */
  async function sendNotification(message) {
    if (channels.length === 0) {
      logger.warn({ message: message.text }, 'No notification channels configured');
      return;
    }

    await Promise.allSettled(
      channels.map((channel) =>
        channel.send(message).catch((error) => {
          logger.error(
            { channel: channel.name, err: error.message },
            'Notification channel failed to send'
          );
        })
      )
    );
  }

  return { sendNotification };
}

/**
 * @typedef {Object} NotificationMessage
 * @property {string} text
 * @property {'info' | 'warn' | 'error' | 'success'} [level]
 * @property {string} [chatId] - target chat override for Telegram
 */

/**
 * @typedef {Object} NotificationChannel
 * @property {string} name
 * @property {(message: NotificationMessage) => Promise<void>} send
 */

/**
 * @typedef {Object} NotificationService
 * @property {(message: NotificationMessage) => Promise<void>} sendNotification
 */
