/**
 * Creates a notification service that dispatches messages through configured channels.
 * Supports multiple channels: Telegram (initial), desktop, email, Slack (future).
 *
 * LUI-TSK-0100: every message is recorded in `logStore` (read back with the
 * "informe" command); only messages flagged `urgent` reach the channels, so the
 * user is woken up only for things that really matter.
 *
 * @param {NotificationChannel[]} channels
 * @param {import('pino').Logger} logger
 * @param {{ logStore?: { add: (entry: { text: string, level: string, urgent: boolean }) => Promise<void> } }} [options]
 * @returns {NotificationService}
 */
export function createNotificationService(channels, logger, { logStore } = {}) {
  /**
   * Records the message and, when urgent, sends it through all configured channels.
   *
   * @param {NotificationMessage} message
   * @returns {Promise<void>}
   */
  async function sendNotification(message) {
    const urgent = message.urgent === true;
    if (logStore) {
      try {
        await logStore.add({ text: message.text, level: message.level ?? 'info', urgent });
      } catch (error) {
        logger.error({ err: error.message }, 'Notification log failed to record');
      }
    } else if (!urgent) {
      logger.warn({ message: message.text }, 'Non-urgent notification dropped: no log store configured');
    }

    if (!urgent) return;

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
 * @property {boolean} [urgent] - true only for things that need attention now (storm, temperature, node down); the rest only goes to the "informe"
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
