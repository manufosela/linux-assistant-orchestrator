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
  /** @type {Map<string, string>} */
  const aliases = new Map();
  /** @type {CommandHandler | null} */
  let fallbackHandler = null;
  /** @type {UnknownCommandHandler | null} */
  let unknownCommandHandler = null;

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
   * Registers an alias that resolves to an existing canonical command.
   * Typos típicos en español: '/guardar' → '/guarda', '/resume' → '/resumir',
   * '/abre' → '/abrir'. Invocar el alias ejecuta exactamente el handler del
   * canonical, sin duplicar lógica.
   *
   * @param {string} alias       - slash command including the leading slash (typo común)
   * @param {string} canonical   - slash command including the leading slash (comando real)
   */
  function registerAlias(alias, canonical) {
    if (typeof alias !== 'string' || !alias.startsWith('/')) {
      throw new Error(`registerAlias: alias must start with /: ${alias}`);
    }
    if (typeof canonical !== 'string' || !canonical.startsWith('/')) {
      throw new Error(`registerAlias: canonical must start with /: ${canonical}`);
    }
    const aliasKey = alias.toLowerCase();
    if (handlers.has(aliasKey)) {
      throw new Error(`registerAlias: ${alias} is already a registered command`);
    }
    aliases.set(aliasKey, canonical.toLowerCase());
  }

  /**
   * Registers the handler invoked for non-command messages from authorised chats.
   * Used to bridge natural-language input into the LLM service.
   *
   * @param {CommandHandler} handler
   */
  function setFallback(handler) {
    fallbackHandler = handler;
  }

  /**
   * Registers the handler invoked when the user sends a slash command that
   * does not match any registered handler or alias. Allows the message layer
   * to send a "use /help" hint without the router needing access to the bot.
   *
   * @param {UnknownCommandHandler} handler
   */
  function setUnknownCommandHandler(handler) {
    unknownCommandHandler = handler;
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
      if (!fallbackHandler) {
        logger.debug({ chatId, text: text.slice(0, 50) }, 'Non-command message received — no fallback registered');
        return;
      }
      logger.debug({ chatId }, 'Routing to fallback handler');
      try {
        await fallbackHandler(message);
      } catch (error) {
        logger.error({ chatId, err: error.message }, 'Fallback handler threw an error');
      }
      return;
    }

    const lookupKey = command.toLowerCase();
    const canonicalKey = aliases.get(lookupKey) ?? lookupKey;
    const handler = handlers.get(canonicalKey);
    if (!handler) {
      logger.debug({ chatId, command }, 'Unknown command');
      await handleUnknownCommand(message, command);
      return;
    }

    logger.debug({ chatId, command, canonical: canonicalKey === lookupKey ? undefined : canonicalKey }, 'Routing command');

    try {
      await handler(message);
    } catch (error) {
      logger.error({ chatId, command, err: error.message }, 'Command handler threw an error');
    }
  }

  /**
   * Invoked when the user sends `/something` that is not registered (and not
   * an alias). If a handler is set via `setUnknownCommandHandler`, it gets the
   * message + the typed command; otherwise the router stays silent (preserves
   * historical behaviour).
   *
   * @param {TelegramMessage} message
   * @param {string} command
   */
  async function handleUnknownCommand(message, command) {
    if (!unknownCommandHandler) return;
    try {
      await unknownCommandHandler(message, command);
    } catch (error) {
      logger.error(
        { chatId: message.chat?.id, command, err: error.message },
        'Unknown-command handler threw an error',
      );
    }
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

  /**
   * Returns the map of registered aliases (read-only snapshot).
   *
   * @returns {Array<{ alias: string, canonical: string }>}
   */
  function listAliases() {
    return [...aliases.entries()].map(([alias, canonical]) => ({ alias, canonical }));
  }

  return {
    register,
    registerAlias,
    setFallback,
    setUnknownCommandHandler,
    route,
    listCommands,
    listAliases,
  };
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
 * @callback UnknownCommandHandler
 * @param {TelegramMessage} message
 * @param {string} command  - the typed command (e.g. '/pepito')
 * @returns {Promise<void>}
 */

/**
 * @typedef {Object} TelegramCommandRouter
 * @property {(command: string, handler: CommandHandler) => void} register
 * @property {(alias: string, canonical: string) => void} registerAlias
 * @property {(handler: CommandHandler) => void} setFallback
 * @property {(handler: UnknownCommandHandler) => void} setUnknownCommandHandler
 * @property {(message: TelegramMessage) => Promise<void>} route
 * @property {() => string[]} listCommands
 * @property {() => Array<{alias: string, canonical: string}>} listAliases
 */
