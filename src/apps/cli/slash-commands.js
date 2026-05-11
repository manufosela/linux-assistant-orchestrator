/**
 * Slash command framework for the interactive REPL.
 *
 * A slash command is any line starting with `/`. The first token (without the slash) is the
 * command name; the remainder of the line is the argument string. Built-in commands cover
 * fetching URLs, searching the web, switching the model in-session, resetting the conversation
 * history and showing help. Unknown commands are reported with a friendly hint.
 *
 * Handlers receive a {@link SlashContext} with the conversation manager, the renderer and any
 * services needed to act on the command. Handlers can mutate session state (model override),
 * add context to the conversation, print to the renderer or signal exit.
 *
 * @param {{
 *   conversation: import('./conversation-manager.js').ConversationManager,
 *   renderer: import('./terminal-renderer.js').TerminalRenderer,
 *   urlFetcher?: import('../../modules/web/url-fetcher.js').UrlFetcher,
 *   webSearch?: import('../../modules/web/web-search.js').WebSearchService,
 *   homeAssistant?: import('../../modules/home-assistant/ha-client.js').HomeAssistantClient,
 *   sessionState: SessionState,
 *   logger: import('pino').Logger,
 * }} deps
 * @returns {SlashCommandRegistry}
 */
export function createSlashCommandRegistry(deps) {
  /** @type {Map<string, SlashCommandDefinition>} */
  const commands = new Map();

  /**
   * Registers a slash command.
   *
   * @param {string} name - without leading slash
   * @param {SlashHandler} handler
   * @param {{ description?: string, usage?: string }} [meta]
   */
  function register(name, handler, meta = {}) {
    commands.set(name.toLowerCase(), { handler, description: meta.description ?? '', usage: meta.usage ?? `/${name}` });
  }

  /**
   * Returns true if the input string starts with a slash (i.e. is a slash command).
   *
   * @param {string} line
   * @returns {boolean}
   */
  function isSlashCommand(line) {
    return /^\s*\/[a-z][a-z0-9_-]*/i.test(line);
  }

  /**
   * Parses and executes a slash command line. Returns the result so the REPL knows whether to
   * continue, exit, or do nothing more.
   *
   * @param {string} line
   * @returns {Promise<SlashResult>}
   */
  async function execute(line) {
    const trimmed = line.trim().slice(1); // strip leading slash
    const spaceIndex = trimmed.search(/\s/);
    const name = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
    const args = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();

    const definition = commands.get(name);
    if (!definition) {
      deps.renderer.error(`Unknown slash command: /${name}. Try /help.`);
      return { handled: true };
    }

    try {
      const result = await definition.handler({
        args,
        renderer: deps.renderer,
        conversation: deps.conversation,
        urlFetcher: deps.urlFetcher,
        webSearch: deps.webSearch,
        homeAssistant: deps.homeAssistant,
        sessionState: deps.sessionState,
        logger: deps.logger,
        listCommands: () => [...commands.entries()].sort(([a], [b]) => a.localeCompare(b)),
      });
      return result ?? { handled: true };
    } catch (error) {
      deps.logger?.warn({ err: error?.message, slash: name }, 'Slash command failed');
      deps.renderer.error(`/${name} failed: ${error?.message ?? 'unknown error'}`);
      return { handled: true };
    }
  }

  return { register, execute, isSlashCommand };
}

/**
 * Registers the default slash commands: /fetch, /search, /reset, /clear, /model, /help.
 *
 * @param {ReturnType<typeof createSlashCommandRegistry>} registry
 */
export function registerDefaultSlashCommands(registry) {
  registry.register('fetch', async ({ args, renderer, conversation, urlFetcher }) => {
    if (!args) {
      renderer.error('Usage: /fetch <url>');
      return;
    }
    if (!urlFetcher) {
      renderer.error('URL fetcher is not configured.');
      return;
    }
    renderer.info(`Fetching ${args} ...`);
    const result = await urlFetcher.fetchUrl(args);
    const label = result.title ? `${result.title} — ${result.url}` : result.url;
    conversation.appendContext(`Fetched ${result.url}`, `# ${result.title || '(no title)'}\n\n${result.text}`);
    renderer.success(`Added ${result.bytes} bytes from ${label} to the conversation context.`);
  }, { description: 'Download a URL and add its text to the conversation context', usage: '/fetch <url>' });

  registry.register('search', async ({ args, renderer, conversation, webSearch }) => {
    if (!args) {
      renderer.error('Usage: /search <query>');
      return;
    }
    if (!webSearch) {
      renderer.error('Web search is not configured.');
      return;
    }
    renderer.info(`Searching: ${args} ...`);
    const results = await webSearch.search(args);
    if (results.length === 0) {
      renderer.warning('No results.');
      return;
    }
    const lines = results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`);
    renderer.print(lines.join('\n'));
    conversation.appendContext(
      `Search: ${args}`,
      results.map((r) => `- ${r.title}\n  ${r.url}\n  ${r.snippet}`).join('\n')
    );
  }, { description: 'Search the web (SearXNG) and add the results to the conversation context', usage: '/search <query>' });

  registry.register('ha', async ({ args, renderer, sessionState, homeAssistant }) => {
    if (!args) {
      renderer.error('Usage: /ha <texto> — ej: /ha enciende el termostato');
      return;
    }
    if (!homeAssistant) {
      renderer.error('Home Assistant no configurado.');
      return;
    }
    const result = await homeAssistant.processConversation(args, {
      conversationId: sessionState.haConversationId,
    });
    if (result.conversationId) sessionState.haConversationId = result.conversationId;
    const icon = result.responseType === 'error' ? '⚠️' : '🏠';
    renderer.print(`${icon} ${result.speech || '(sin respuesta)'}`);
  }, { description: 'Send a natural-language command to Home Assistant', usage: '/ha <texto>' });

  registry.register('reset', async ({ renderer, conversation, sessionState }) => {
    conversation.reset();
    sessionState.haConversationId = undefined;
    renderer.info('Conversation history cleared.');
  }, { description: 'Clear the conversation history', usage: '/reset' });

  registry.register('clear', async ({ renderer, conversation, sessionState }) => {
    conversation.reset();
    sessionState.haConversationId = undefined;
    renderer.info('Conversation history cleared.');
  }, { description: 'Alias of /reset', usage: '/clear' });

  registry.register('model', async ({ args, renderer, sessionState }) => {
    if (!args) {
      renderer.info(`Current model: ${sessionState.model || '(default)'}`);
      return;
    }
    sessionState.model = args.trim();
    renderer.success(`Model switched to ${sessionState.model} for this session only.`);
  }, { description: 'Show or change the LLM model used in this session', usage: '/model [name]' });

  registry.register('help', async ({ renderer, listCommands }) => {
    renderer.print('Available slash commands:');
    for (const [name, definition] of listCommands()) {
      const description = definition.description ? ` — ${definition.description}` : '';
      renderer.print(`  ${definition.usage}${description}`);
    }
    renderer.print('');
    renderer.print('Anything that does not start with `/` is sent to the LLM with the full conversation context.');
    renderer.print('Type `exit` or `quit` to leave.');
  }, { description: 'List slash commands', usage: '/help' });
}

/**
 * @typedef {Object} SessionState
 * @property {string} [model] - per-session model override
 * @property {string} [haConversationId] - per-session HA conversation id
 */

/**
 * @typedef {Object} SlashContext
 * @property {string} args
 * @property {import('./terminal-renderer.js').TerminalRenderer} renderer
 * @property {import('./conversation-manager.js').ConversationManager} conversation
 * @property {import('../../modules/web/url-fetcher.js').UrlFetcher | undefined} urlFetcher
 * @property {import('../../modules/web/web-search.js').WebSearchService | undefined} webSearch
 * @property {import('../../modules/home-assistant/ha-client.js').HomeAssistantClient | undefined} homeAssistant
 * @property {SessionState} sessionState
 * @property {import('pino').Logger} logger
 * @property {() => Array<[string, SlashCommandDefinition]>} listCommands
 */

/**
 * @callback SlashHandler
 * @param {SlashContext} context
 * @returns {Promise<SlashResult | void>}
 */

/**
 * @typedef {Object} SlashCommandDefinition
 * @property {SlashHandler} handler
 * @property {string} description
 * @property {string} usage
 */

/**
 * @typedef {Object} SlashResult
 * @property {boolean} [handled]
 * @property {boolean} [exit]
 */

/**
 * @typedef {Object} SlashCommandRegistry
 * @property {(name: string, handler: SlashHandler, meta?: { description?: string, usage?: string }) => void} register
 * @property {(line: string) => Promise<SlashResult>} execute
 * @property {(line: string) => boolean} isSlashCommand
 */
