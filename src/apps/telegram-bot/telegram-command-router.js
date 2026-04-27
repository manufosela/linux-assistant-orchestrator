/**
 * Creates a Telegram command router.
 * Routes incoming commands to registered handlers, enforcing the allowed-chat policy.
 *
 * @param {import('../../modules/security/allowed-chat-policy.js').AllowedChatPolicy} allowedChatPolicy
 * @param {import('pino').Logger} logger
 * @returns {TelegramCommandRouter}
 */
export function createTelegramCommandRouter(allowedChatPolicy, logger) {
  /** @type {Map<string, CommandHandler>} */
  const handlers = new Map();

  /**
   * Registers a handler for a given command (e.g. '/status').
   *
   * @param {string} command - slash command including the leading slash
   * @param {CommandHandler} handler
   */
  function register(command, handler) {
    handlers.set(command.toLowerCase(), handler);
  }

  /**
   * Routes an incoming message to the appropriate handler.
   * Rejects messages from unauthorised chat IDs.
   *
   * @param {TelegramMessage} message
   * @returns {Promise<void>}
   */
  async function route(message) {
    const chatId = message.chat?.id;
    const text = message.text ?? '';

    if (!allowedChatPolicy.validate(chatId)) {
      logger.warn({ chatId }, 'Message from unauthorised chat rejected');
      return;
    }

    const command = extractCommand(text);
    if (!command) {
      logger.debug({ chatId, text: text.slice(0, 50) }, 'Non-command message received — ignoring');
      return;
    }

    const handler = handlers.get(command.toLowerCase());
    if (!handler) {
      logger.debug({ chatId, command }, 'Unknown command');
      await handleUnknownCommand(message, command);
      return;
    }

    logger.debug({ chatId, command }, 'Routing command');

    try {
      await handler(message);
    } catch (error) {
      logger.error({ chatId, command, err: error.message }, 'Command handler threw an error');
    }
  }

  /**
   * Default response when a command is not registered.
   *
   * @param {TelegramMessage} message
   * @param {string} command
   */
  async function handleUnknownCommand(message, command) {
    const knownCommands = [...handlers.keys()].sort().join(', ');
    void message;
    void command;
    void knownCommands;
    // Response is sent by the message handler — router only dispatches.
  }

  /**
   * Returns a list of all registered commands.
   *
   * @returns {string[]}
   */
  function listCommands() {
    return [...handlers.keys()].sort();
  }

  /**
   * Extracts the command name from a message text.
   * Handles '/command', '/command@bot_name', and '/command arg' forms.
   *
   * @param {string} text
   * @returns {string | null}
   */
  function extractCommand(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    const parts = trimmed.split(/\s+/);
    const commandWithBot = parts[0].slice(1); // remove leading slash
    const command = commandWithBot.split('@')[0]; // remove @botname suffix

    return command ? `/${command}` : null;
  }

  return { register, route, listCommands };
}

/**
 * @typedef {Object} TelegramMessage
 * @property {{ id: number | string }} chat
 * @property {string} [text]
 * @property {{ id: number }} [from]
 */

/**
 * @callback CommandHandler
 * @param {TelegramMessage} message
 * @returns {Promise<void>}
 */

/**
 * @typedef {Object} TelegramCommandRouter
 * @property {(command: string, handler: CommandHandler) => void} register
 * @property {(message: TelegramMessage) => Promise<void>} route
 * @property {() => string[]} listCommands
 */
