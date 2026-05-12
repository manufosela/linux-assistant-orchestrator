import { createCliCommandRouter } from './cli-command-router.js';
import { createInteractiveCliSession } from './interactive-cli-session.js';
import { createTerminalRenderer } from './terminal-renderer.js';
import { formatLlmError } from './llm-error-formatter.js';

/**
 * Composition root for the CLI application.
 * Wires the command router with the supplied services and registers every supported command.
 *
 * Dependencies are passed in (DI) so tests can inject stubs without touching the filesystem,
 * the network or the real configuration.
 *
 * @param {{
 *   llmService: import('../../modules/llm/llm-service.js').LlmService,
 *   statusService: import('../../modules/assistant/assistant-status-service.js').AssistantStatusService,
 *   rulesRepository: import('../../modules/downloads/download-rules-repository.js').DownloadRulesRepository,
 *   approvalService: import('../../modules/security/approval-service.js').ApprovalService,
 *   urlFetcher?: import('../../modules/web/url-fetcher.js').UrlFetcher,
 *   webSearch?: import('../../modules/web/web-search.js').WebSearchService,
 *   homeAssistant?: import('../../modules/home-assistant/ha-client.js').HomeAssistantClient,
 *   logger: import('pino').Logger,
 *   appName: string,
 *   appVersion: string,
 *   llmProvider: string,
 *   remoteCodeTasksEnabled: boolean,
 *   renderer?: import('./terminal-renderer.js').TerminalRenderer,
 * }} deps
 * @returns {CliApp}
 */
export function createCliApp(deps) {
  const renderer = deps.renderer ?? createTerminalRenderer();
  const router = createCliCommandRouter({ renderer, logger: deps.logger });

  registerCommands({ ...deps, renderer, router });

  /**
   * Runs a single command from argv tokens (non-interactive mode).
   *
   * @param {string[]} argv
   * @returns {Promise<number>}
   */
  async function runCommand(argv) {
    return router.route(argv);
  }

  /**
   * Starts the interactive REPL session.
   *
   * @returns {Promise<number>}
   */
  async function runInteractive() {
    const session = createInteractiveCliSession({
      llmService: deps.llmService,
      urlFetcher: deps.urlFetcher,
      webSearch: deps.webSearch,
      homeAssistant: deps.homeAssistant,
      renderer,
      logger: deps.logger,
      appName: deps.appName,
      appVersion: deps.appVersion,
      llmProvider: deps.llmProvider,
    });
    return session.start();
  }

  return { runCommand, runInteractive, router, renderer };
}

/**
 * Registers every supported command on the router.
 *
 * @param {{
 *   llmService: import('../../modules/llm/llm-service.js').LlmService,
 *   statusService: import('../../modules/assistant/assistant-status-service.js').AssistantStatusService,
 *   rulesRepository: import('../../modules/downloads/download-rules-repository.js').DownloadRulesRepository,
 *   approvalService: import('../../modules/security/approval-service.js').ApprovalService,
 *   logger: import('pino').Logger,
 *   remoteCodeTasksEnabled: boolean,
 *   renderer: import('./terminal-renderer.js').TerminalRenderer,
 *   router: import('./cli-command-router.js').CliCommandRouter,
 * }} deps
 */
function registerCommands(deps) {
  const { router, llmService, statusService, rulesRepository, urlFetcher, webSearch, homeAssistant, alexaAnnouncer, logger, remoteCodeTasksEnabled } = deps;

  router.register('status', async ({ renderer }) => {
    const status = statusService.getStatus();
    renderer.renderStatus(status);
  }, { description: 'Show assistant status, uptime and modules' });

  router.register('llm status', async ({ renderer }) => {
    const health = await llmService.checkHealth();
    renderer.renderLlmStatus(health);
    return { exitCode: health.healthy ? 0 : 1 };
  }, { description: 'Check whether the local LLM provider is reachable' });

  router.register('ask', async ({ args, renderer }) => {
    const prompt = args.join(' ').trim();
    if (!prompt) {
      renderer.error('Usage: luis ask "your question"');
      return { exitCode: 1 };
    }
    try {
      const response = await llmService.generateText(prompt, {
        module: 'cli',
        operation: 'ask',
        private: true,
      });
      renderer.print(response);
    } catch (error) {
      logger.warn({ err: error?.message }, 'CLI ask failed');
      renderer.error(formatLlmError(error));
      return { exitCode: 1 };
    }
  }, { description: 'Send a one-shot prompt to the local LLM' });

  router.register('downloads rules', async ({ renderer }) => {
    const rules = await rulesRepository.loadRules();
    renderer.renderRules(rules);
  }, { description: 'List configured download rules' });

  router.register('downloads organize', async ({ renderer }) => {
    logger.info({ command: 'downloads organize' }, 'Downloads organize requested via CLI');
    renderer.warning('Downloads organizer service is not wired to the CLI yet (placeholder).');
    renderer.info('When available, this will run rule-based + LLM classification on the watch path.');
    return { exitCode: 0 };
  }, { description: 'Run the downloads organizer (placeholder until the service is wired)' });

  router.register('mail summary', async ({ renderer }) => {
    renderer.warning('Email integration is not implemented yet.');
  }, { description: 'Summarize email (not implemented yet)' });

  router.register('calendar today', async ({ renderer }) => {
    renderer.warning('Calendar integration is not implemented yet.');
  }, { description: 'Show today\'s calendar (not implemented yet)' });

  router.register('pg task', async ({ args, renderer }) => {
    const taskId = args[0];
    if (!taskId) {
      renderer.error('Usage: luis pg task <PG-XXX>');
      return { exitCode: 1 };
    }
    renderer.warning(`Planning Game integration is not implemented yet (requested task: ${taskId}).`);
  }, { description: 'Show a Planning Game task (not implemented yet)' });

  router.register('code', async ({ args, flags, renderer }) => {
    const taskId = args[0];
    const agent = flags.agent ?? 'unspecified';
    if (!remoteCodeTasksEnabled) {
      renderer.warning('Remote coding is disabled by default. Set ENABLE_REMOTE_CODE_TASKS=true to enable.');
      logger.warn({ taskId, agent }, 'Remote code task blocked: remote coding disabled');
      return { exitCode: 1 };
    }
    renderer.warning(`Remote coding is enabled but no agent runner is wired yet (task: ${taskId}, agent: ${agent}).`);
    return { exitCode: 0 };
  }, { description: 'Run a remote coding task (disabled by default)' });

  router.register('fetch', async ({ args, renderer }) => {
    const url = args[0];
    if (!url) {
      renderer.error('Usage: luis fetch <url>');
      return { exitCode: 1 };
    }
    if (!urlFetcher) {
      renderer.error('URL fetcher is not configured.');
      return { exitCode: 1 };
    }
    try {
      const result = await urlFetcher.fetchUrl(url);
      if (result.title) {
        renderer.print(`# ${result.title}`);
        renderer.print('');
      }
      renderer.print(result.text);
    } catch (error) {
      logger.warn({ err: error?.message, url }, 'CLI fetch failed');
      renderer.error(`Fetch failed: ${error?.message ?? 'unknown error'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Download a URL and print its extracted text' });

  router.register('search', async ({ args, flags, renderer }) => {
    const query = args.join(' ').trim();
    if (!query) {
      renderer.error('Usage: luis search "query" [--ask]');
      return { exitCode: 1 };
    }
    if (!webSearch) {
      renderer.error('Web search is not configured. Set web.search.baseUrl in ~/.config/luis/config.json.');
      return { exitCode: 1 };
    }
    try {
      const results = await webSearch.search(query);
      if (results.length === 0) {
        renderer.warning('No results.');
        return { exitCode: 0 };
      }
      const formatted = results.map((result, index) =>
        `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`
      ).join('\n');
      renderer.print(formatted);

      if (flags.ask) {
        renderer.print('');
        renderer.info('Asking the LLM to summarize…');
        const summary = await llmService.generateText(
          `Resume y compara estos resultados de búsqueda para la query "${query}":\n\n${formatted}`,
          { module: 'cli', operation: 'search-ask', private: true }
        );
        renderer.print('');
        renderer.print(summary);
      }
    } catch (error) {
      logger.warn({ err: error?.message, query }, 'CLI search failed');
      renderer.error(`Search failed: ${error?.message ?? 'unknown error'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Search the web (SearXNG). Add --ask to also pass results to the LLM for a summary' });

  router.register('ha', async ({ args, renderer }) => {
    const text = args.join(' ').trim();
    if (!text) {
      renderer.error('Usage: luis ha "texto" — ej: luis ha enciende el termostato');
      return { exitCode: 1 };
    }
    if (!homeAssistant) {
      renderer.error('Home Assistant no configurado. Añade homeAssistant.baseUrl y homeAssistant.token en ~/.config/luis/config.json.');
      return { exitCode: 1 };
    }
    try {
      const result = await homeAssistant.processConversation(text);
      const icon = result.responseType === 'error' ? '⚠️' : '🏠';
      renderer.print(`${icon} ${result.speech || '(sin respuesta)'}`);
      return { exitCode: result.responseType === 'error' ? 1 : 0 };
    } catch (error) {
      logger.warn({ err: error?.message, text }, 'CLI ha failed');
      renderer.error(`Home Assistant: ${error?.message ?? 'error desconocido'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Send a natural-language command to Home Assistant' });

  router.register('anuncia', async ({ args, flags, renderer }) => {
    const message = args.join(' ').trim();
    if (!message) {
      renderer.error('Uso: luis anuncia "mensaje" [--en <salon|dormitorio|cocina|show|pop|pueblo|casa|firetv>]');
      return { exitCode: 1 };
    }
    if (!alexaAnnouncer) {
      renderer.error('Anuncios Alexa no configurados. Necesita Home Assistant + integración alexa_media_player en ~/.config/luis/config.json.');
      return { exitCode: 1 };
    }
    const target = typeof flags.en === 'string'
      ? flags.en
      : typeof flags.to === 'string'
        ? flags.to
        : typeof flags.target === 'string'
          ? flags.target
          : undefined;
    try {
      const result = await alexaAnnouncer.announce(message, { target });
      renderer.print(`📣 Anunciado vía ${result.service}.`);
      return { exitCode: 0 };
    } catch (error) {
      logger.warn({ err: error?.message, target }, 'CLI anuncia failed');
      renderer.error(`No pude anunciar: ${error?.message ?? 'error desconocido'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Envía un anuncio hablado a un Echo de Alexa vía Home Assistant' });

  router.register('help', async () => {
    router.printHelp();
  }, { description: 'Show this help' });
}

/**
 * @typedef {Object} CliApp
 * @property {(argv: string[]) => Promise<number>} runCommand
 * @property {() => Promise<number>} runInteractive
 * @property {import('./cli-command-router.js').CliCommandRouter} router
 * @property {import('./terminal-renderer.js').TerminalRenderer} renderer
 */
