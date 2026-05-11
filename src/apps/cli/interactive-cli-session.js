import readline from 'node:readline';
import { formatLlmError } from './llm-error-formatter.js';
import { createConversationManager } from './conversation-manager.js';
import { createSlashCommandRegistry, registerDefaultSlashCommands } from './slash-commands.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are luis, a local-first assistant. Reply concisely. The user may give you context via ' +
  '/fetch (downloaded URLs) and /search (web results); reason over that context when answering. ' +
  'If you do not know something, say so.';

/**
 * Creates an interactive CLI session with conversation memory and slash commands.
 *
 * Built around three collaborators:
 *  - {@link createConversationManager} keeps the rolling message history.
 *  - {@link createSlashCommandRegistry} parses and dispatches `/fetch`, `/search`, `/reset`,
 *    `/model`, `/help`, etc.
 *  - {@link import('../../modules/llm/llm-service.js').LlmService.chat} is invoked for each
 *    natural-language turn with the full message history.
 *
 * Errors are caught per turn so a single failure does not kill the session.
 *
 * @param {{
 *   llmService: import('../../modules/llm/llm-service.js').LlmService,
 *   urlFetcher?: import('../../modules/web/url-fetcher.js').UrlFetcher,
 *   webSearch?: import('../../modules/web/web-search.js').WebSearchService,
 *   homeAssistant?: import('../../modules/home-assistant/ha-client.js').HomeAssistantClient,
 *   renderer: import('./terminal-renderer.js').TerminalRenderer,
 *   logger: import('pino').Logger,
 *   appName: string,
 *   appVersion: string,
 *   llmProvider: string,
 *   systemPrompt?: string,
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 * }} deps
 * @returns {InteractiveCliSession}
 */
export function createInteractiveCliSession({
  llmService,
  urlFetcher,
  webSearch,
  homeAssistant,
  renderer,
  logger,
  appName,
  appVersion,
  llmProvider,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  input,
  output,
}) {
  const exitWords = new Set(['exit', 'quit', ':q', 'salir']);

  /**
   * Starts the session loop and resolves when the user exits.
   *
   * @returns {Promise<number>} exit code
   */
  async function start() {
    const conversation = createConversationManager({ systemPrompt });
    /** @type {{ model: string }} */
    const sessionState = { model: '' };

    const slashes = createSlashCommandRegistry({
      conversation,
      renderer,
      urlFetcher,
      webSearch,
      homeAssistant,
      sessionState,
      logger,
    });
    registerDefaultSlashCommands(slashes);

    const usingDefaultInput = !input;
    const rl = readline.createInterface({
      input: input ?? process.stdin,
      output: output ?? process.stdout,
      terminal: usingDefaultInput ? Boolean(process.stdout.isTTY) : false,
      prompt: renderer.promptString(),
    });

    renderer.header({ name: appName, version: appVersion, llmProvider });
    renderer.print('Type /help for commands, exit to leave.');
    renderer.print('');

    rl.on('SIGINT', () => {
      renderer.print('');
      renderer.info('Session ended.');
      rl.close();
    });

    rl.prompt();

    for await (const rawLine of rl) {
      const text = rawLine.trim();
      if (!text) {
        rl.prompt();
        continue;
      }

      if (exitWords.has(text.toLowerCase())) {
        renderer.info('Bye.');
        rl.close();
        break;
      }

      if (slashes.isSlashCommand(text)) {
        const result = await slashes.execute(text);
        if (result?.exit) {
          rl.close();
          break;
        }
        rl.prompt();
        continue;
      }

      // Natural language turn — full conversation context goes to the LLM.
      conversation.appendUser(text);
      try {
        const response = await llmService.chat(conversation.snapshot(), {
          module: 'cli',
          operation: 'interactive',
          private: true,
          model: sessionState.model || undefined,
        });
        conversation.appendAssistant(response);
        renderer.print(response);
      } catch (error) {
        logger.warn({ err: error?.message }, 'CLI interactive turn failed');
        renderer.error(formatLlmError(error));
      }

      rl.prompt();
    }

    return 0;
  }

  return { start };
}

/**
 * @typedef {Object} InteractiveCliSession
 * @property {() => Promise<number>} start
 */
