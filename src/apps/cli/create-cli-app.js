import { createCliCommandRouter } from './cli-command-router.js';
import { createInteractiveCliSession } from './interactive-cli-session.js';
import { createTerminalRenderer } from './terminal-renderer.js';
import { formatLlmError } from './llm-error-formatter.js';
import { parseAnnounceInvocation, listTargetChoices } from '../../modules/home-assistant/ha-alexa-announcer.js';
import { formatClusterStatus, formatClusterHistory } from '../../modules/cluster/cluster-status-service.js';

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
 *   youtubeService?: import('../../modules/youtube/youtube-service.js').YoutubeService,
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
  const { router, llmService, statusService, rulesRepository, urlFetcher, webSearch, homeAssistant, alexaAnnouncer, googleAuth, clusterStatus, gmailClient, calendarClient, driveClient, youtubeService, mediaTranscriber, logger, remoteCodeTasksEnabled } = deps;

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

  router.register('mail today', async ({ flags, renderer }) => {
    if (!gmailClient) {
      renderer.error('Gmail no configurado. Ejecuta `luis google login` primero y comprueba que google.credentialsPath / google.tokensPath están en la config.');
      return { exitCode: 1 };
    }
    try {
      const maxResults = Number(flags.max ?? flags.limit ?? 10) || 10;
      const emails = await gmailClient.unreadToday({ maxResults });
      if (emails.length === 0) {
        renderer.print('No tienes correos no leídos de hoy.');
        return { exitCode: 0 };
      }
      renderEmailList(renderer, emails);
      if (flags.summary && llmService) {
        renderer.print('');
        renderer.info('Resumiendo con el LLM…');
        const summary = await gmailClient.summarize(emails);
        if (summary) {
          renderer.print('');
          renderer.print(summary);
        }
      }
      return { exitCode: 0 };
    } catch (error) {
      logger.warn({ err: error?.message }, 'CLI mail today failed');
      renderer.error(`Mail today: ${error?.message ?? 'error desconocido'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Lista los correos no leídos de hoy (--summary para resumir con el LLM)' });

  router.register('mail from', async ({ args, flags, renderer }) => {
    const sender = args.join(' ').trim();
    if (!sender) {
      renderer.error('Uso: luis mail from <remitente>   (nombre, email parcial o dominio)');
      return { exitCode: 1 };
    }
    if (!gmailClient) {
      renderer.error('Gmail no configurado. Ejecuta `luis google login` primero.');
      return { exitCode: 1 };
    }
    try {
      const maxResults = Number(flags.max ?? flags.limit ?? 10) || 10;
      const emails = await gmailClient.fromSender({ sender, maxResults });
      if (emails.length === 0) {
        renderer.print(`No encuentro correos de "${sender}".`);
        return { exitCode: 0 };
      }
      renderEmailList(renderer, emails);
      return { exitCode: 0 };
    } catch (error) {
      logger.warn({ err: error?.message, sender }, 'CLI mail from failed');
      renderer.error(`Mail from: ${error?.message ?? 'error desconocido'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Lista correos de un remitente concreto (luis mail from "banco")' });

  router.register('calendar today', async ({ renderer }) => {
    return runCalendar('today', renderer);
  }, { description: 'Eventos del calendario de hoy' });

  router.register('calendar tomorrow', async ({ renderer }) => {
    return runCalendar('tomorrow', renderer);
  }, { description: 'Eventos del calendario de mañana' });

  router.register('calendar week', async ({ renderer }) => {
    return runCalendar('week', renderer);
  }, { description: 'Eventos de los próximos 7 días' });

  router.register('calendar next', async ({ renderer }) => {
    if (!calendarClient) {
      renderer.error('Calendar no configurado. Ejecuta `luis google login` primero.');
      return { exitCode: 1 };
    }
    try {
      const event = await calendarClient.next();
      if (!event) {
        renderer.print('No tienes eventos próximos en los siguientes 30 días.');
        return { exitCode: 0 };
      }
      renderEventList(renderer, [event]);
      return { exitCode: 0 };
    } catch (error) {
      logger.warn({ err: error?.message }, 'CLI calendar next failed');
      renderer.error(`Calendar next: ${error?.message ?? 'error desconocido'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Próximo evento del calendario (próximos 30 días)' });

  /**
   * @param {'today'|'tomorrow'|'week'} which
   * @param {import('./terminal-renderer.js').TerminalRenderer} renderer
   */
  async function runCalendar(which, renderer) {
    if (!calendarClient) {
      renderer.error('Calendar no configurado. Ejecuta `luis google login` primero.');
      return { exitCode: 1 };
    }
    try {
      const events = await calendarClient[which]();
      if (events.length === 0) {
        const labels = { today: 'hoy', tomorrow: 'mañana', week: 'esta semana' };
        renderer.print(`No tienes eventos ${labels[which]}.`);
        return { exitCode: 0 };
      }
      renderEventList(renderer, events);
      return { exitCode: 0 };
    } catch (error) {
      logger.warn({ err: error?.message, which }, `CLI calendar ${which} failed`);
      renderer.error(`Calendar ${which}: ${error?.message ?? 'error desconocido'}`);
      return { exitCode: 1 };
    }
  }

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

  router.register('youtube', async ({ args, flags, renderer }) => {
    const url = args[0];
    if (!url) {
      renderer.error('Usage: luis youtube <url> [--full] [--no-summary] [--lang=es]');
      return { exitCode: 1 };
    }
    if (!youtubeService) {
      renderer.error('YouTube transcription is not configured. Set WHISPER_BASE_URL and run with yt-dlp available.');
      return { exitCode: 1 };
    }
    const withSummary = flags['no-summary'] !== true && flags.summary !== 'false';
    const language = typeof flags.lang === 'string' ? flags.lang : undefined;
    try {
      const result = await youtubeService.processVideo(url, { withSummary, language });
      if (result.title) renderer.print(`# ${result.title}`);
      const sourceLabel = result.source === 'subtitles' ? 'subtítulos' : 'whisper';
      renderer.info(`Fuente: ${sourceLabel}${result.videoId ? ` · ${result.videoId}` : ''}`);
      renderer.print('');
      if (result.summary) {
        renderer.print('## Resumen');
        renderer.print(result.summary);
        renderer.print('');
      }
      if (flags.full || !result.summary) {
        renderer.print('## Transcripción');
        renderer.print(result.transcript);
      }
    } catch (error) {
      logger.warn({ err: error?.message, url }, 'CLI youtube failed');
      renderer.error(`YouTube failed: ${error?.message ?? 'unknown error'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Transcribe and summarize a YouTube video' });

  router.register('transcribe', async ({ args, flags, renderer }) => {
    const path = args[0];
    if (!path) {
      renderer.error('Usage: luis transcribe <path> [--full] [--no-summary] [--lang=es]');
      return { exitCode: 1 };
    }
    if (!mediaTranscriber) {
      renderer.error('Media transcription is not configured. Set WHISPER_BASE_URL and ensure ffmpeg is available.');
      return { exitCode: 1 };
    }
    const withSummary = flags['no-summary'] !== true && flags.summary !== 'false';
    const language = typeof flags.lang === 'string' ? flags.lang : undefined;
    try {
      const result = await mediaTranscriber.transcribe(path, { withSummary, language });
      const sizeMB = (result.sizeBytes / 1024 / 1024).toFixed(1);
      renderer.info(`Fuente: ${result.sourceKind} · ${sizeMB} MB${result.audioExtracted ? ' · audio extraído con ffmpeg' : ''}`);
      renderer.print('');
      if (result.summary) {
        renderer.print('## Resumen');
        renderer.print(result.summary);
        renderer.print('');
      }
      if (flags.full || !result.summary) {
        renderer.print('## Transcripción');
        renderer.print(result.transcript);
      }
    } catch (error) {
      logger.warn({ err: error?.message, path }, 'CLI transcribe failed');
      renderer.error(`Transcribe failed: ${error?.message ?? 'unknown error'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Transcribe and summarize a local audio or video file' });

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
    // Flag explícito gana sobre el parsing natural.
    const explicitTarget = typeof flags.en === 'string'
      ? flags.en
      : typeof flags.to === 'string'
        ? flags.to
        : typeof flags.target === 'string'
          ? flags.target
          : undefined;

    const rawText = args.join(' ').trim();
    const parsed = parseAnnounceInvocation(rawText);

    const target = explicitTarget ?? parsed.target;
    const message = explicitTarget ? rawText : parsed.message;

    if (!message) {
      const list = listTargetChoices().map((c) => c.alias).join(' | ');
      renderer.error(`Uso: luis anuncia <destino> "mensaje"   (destino: ${list})`);
      return { exitCode: 1 };
    }
    if (!alexaAnnouncer) {
      renderer.error('Anuncios Alexa no configurados. Necesita Home Assistant + integración alexa_media_player en ~/.config/luis/config.json.');
      return { exitCode: 1 };
    }
    if (!target) {
      // Por seguridad: si no se indica destino, NO emitimos broadcast por defecto.
      // El usuario debe escribir explícitamente "casa" si quiere todos.
      const list = listTargetChoices()
        .map((c) => `  ${c.emoji} ${c.alias} — ${c.label}`)
        .join('\n');
      renderer.error(
        `Falta el destino. Indica dónde quieres que suene:\n${list}\n\nEjemplos:\n  luis anuncia salon vamos a cenar\n  luis anuncia casa atención todos`,
      );
      return { exitCode: 1 };
    }

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

  router.register('google login', async ({ args, renderer }) => {
    if (!googleAuth) {
      renderer.error('Google auth no configurado. Añade google.credentialsPath y google.tokensPath en ~/.config/luis/config.json.');
      return { exitCode: 1 };
    }
    const code = args.join(' ').trim();
    if (!code) {
      try {
        const url = await googleAuth.generateAuthUrl();
        renderer.print('1. Abre esta URL en tu navegador y autoriza el acceso (solo lectura de Gmail y Calendar):');
        renderer.print('');
        renderer.print(`   ${url}`);
        renderer.print('');
        renderer.print('2. Copia el código que te dé Google y ejecuta:');
        renderer.print('');
        renderer.print('   luis google login <CODIGO>');
        return { exitCode: 0 };
      } catch (error) {
        logger.warn({ err: error?.message }, 'google login: generateAuthUrl failed');
        renderer.error(`No pude generar la URL: ${error?.message ?? 'error desconocido'}`);
        return { exitCode: 1 };
      }
    }
    try {
      await googleAuth.exchangeCode(code);
      renderer.print('✅ Autorización completada. Los tokens se han guardado para uso futuro.');
      return { exitCode: 0 };
    } catch (error) {
      logger.warn({ err: error?.message }, 'google login: exchangeCode failed');
      renderer.error(`Falló el intercambio del código: ${error?.message ?? 'error desconocido'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Autoriza el acceso de LUIS a Gmail y Google Calendar (solo lectura)' });

  router.register('google status', async ({ renderer }) => {
    if (!googleAuth) {
      renderer.warning('Google auth no configurado (falta google.credentialsPath / google.tokensPath en la config).');
      return { exitCode: 1 };
    }
    try {
      const configured = await googleAuth.isConfigured();
      if (configured) {
        renderer.print('✅ Google OAuth2 configurado (tokens presentes y válidos para refresh).');
        return { exitCode: 0 };
      }
      renderer.warning('Google OAuth2 sin autorizar. Ejecuta `luis google login` para empezar.');
      return { exitCode: 1 };
    } catch (error) {
      renderer.error(`No pude verificar el estado: ${error?.message ?? 'error desconocido'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Comprueba si Google OAuth2 está configurado' });
  router.register('cluster status', async ({ renderer }) => {
    if (!clusterStatus) {
      renderer.error('Monitorización del cluster no configurada.');
      return { exitCode: 1 };
    }
    try {
      const results = await clusterStatus.probe();
      for (const line of formatClusterStatus(results)) renderer.print(line);
      const anyDown = results.some((r) => !r.ok);
      return { exitCode: anyDown ? 1 : 0 };
    } catch (error) {
      logger.warn({ err: error?.message }, 'CLI cluster status failed');
      renderer.error(`Cluster status: ${error?.message ?? 'error desconocido'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Estado en vivo de los servicios del cluster (n2/n3/n4)' });

  router.register('cluster history', async ({ renderer }) => {
    if (!clusterStatus) {
      renderer.error('Monitorización del cluster no configurada.');
      return { exitCode: 1 };
    }
    try {
      const incidents = await clusterStatus.history();
      for (const line of formatClusterHistory(incidents)) renderer.print(line);
      return { exitCode: 0 };
    } catch (error) {
      logger.warn({ err: error?.message }, 'CLI cluster history failed');
      renderer.error(`Cluster history: ${error?.message ?? 'error desconocido'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Últimas 10 incidencias del cluster (caídas y recuperaciones)' });

  router.register('drive list', async ({ args, renderer }) => {
    if (!driveClient) {
      renderer.error('Drive no configurado. Hay que ejecutar `luis google login` primero.');
      return { exitCode: 1 };
    }
    const folderId = args[0] || 'root';
    try {
      const items = await driveClient.listFolder(folderId);
      if (items.length === 0) { renderer.print('(carpeta vacía)'); return { exitCode: 0 }; }
      for (const it of items) {
        const icon = it.isFolder ? '📁' : '📄';
        renderer.print(`${icon} ${it.name}    [${it.id}]`);
      }
      return { exitCode: 0 };
    } catch (error) {
      logger.warn({ err: error?.message }, 'drive list failed');
      renderer.error(`Drive list falló: ${error?.message ?? 'desconocido'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Lista los hijos de una carpeta de Drive (root por defecto)' });

  router.register('drive search', async ({ args, renderer }) => {
    if (!driveClient) {
      renderer.error('Drive no configurado. Hay que ejecutar `luis google login` primero.');
      return { exitCode: 1 };
    }
    const query = args.join(' ').trim();
    if (!query) {
      renderer.error('Uso: luis drive search <texto>');
      return { exitCode: 1 };
    }
    try {
      const items = await driveClient.searchByName(query);
      if (items.length === 0) { renderer.print(`(sin resultados para "${query}")`); return { exitCode: 0 }; }
      for (const it of items) {
        const icon = it.isFolder ? '📁' : '📄';
        renderer.print(`${icon} ${it.name}    [${it.id}]`);
      }
      return { exitCode: 0 };
    } catch (error) {
      logger.warn({ err: error?.message }, 'drive search failed');
      renderer.error(`Drive search falló: ${error?.message ?? 'desconocido'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Busca por nombre en todo Drive' });

  router.register('drive info', async ({ args, renderer }) => {
    if (!driveClient) {
      renderer.error('Drive no configurado. Hay que ejecutar `luis google login` primero.');
      return { exitCode: 1 };
    }
    const fileId = args[0];
    if (!fileId) {
      renderer.error('Uso: luis drive info <fileId>');
      return { exitCode: 1 };
    }
    try {
      const it = await driveClient.getMetadata(fileId);
      const icon = it.isFolder ? '📁' : '📄';
      renderer.print(`${icon} ${it.name}`);
      renderer.print(`   id: ${it.id}`);
      renderer.print(`   mime: ${it.mimeType}`);
      renderer.print(`   modificado: ${it.modifiedTime}`);
      if (it.size !== null) renderer.print(`   tamaño: ${it.size} bytes`);
      if (it.webViewLink) renderer.print(`   url: ${it.webViewLink}`);
      return { exitCode: 0 };
    } catch (error) {
      logger.warn({ err: error?.message }, 'drive info failed');
      renderer.error(`Drive info falló: ${error?.message ?? 'desconocido'}`);
      return { exitCode: 1 };
    }
  }, { description: 'Muestra metadata de un fichero por su ID' });

  router.register('help', async () => {
    router.printHelp();
  }, { description: 'Show this help' });
}

/**
 * Renders a list of calendar events in plain text.
 *
 * @param {import('./terminal-renderer.js').TerminalRenderer} renderer
 * @param {import('../../modules/calendar/google-calendar-client.js').CalendarEvent[]} events
 */
function renderEventList(renderer, events) {
  events.forEach((event, i) => {
    if (i > 0) renderer.print('');
    renderer.print(`${i + 1}. ${event.summary}`);
    renderer.print(`   Cuándo: ${formatEventTime(event)}`);
    if (event.location) renderer.print(`   Dónde:  ${event.location}`);
    if (event.attendees.length > 0) {
      renderer.print(`   Con:    ${event.attendees.slice(0, 5).join(', ')}${event.attendees.length > 5 ? ` (+${event.attendees.length - 5} más)` : ''}`);
    }
    if (event.description) {
      const short = event.description.length > 200 ? `${event.description.slice(0, 200)}…` : event.description;
      renderer.print(`   ${short}`);
    }
  });
}

/**
 * Formatea el momento de un evento en español: "todo el día", "hoy 10:00-11:30", etc.
 *
 * @param {import('../../modules/calendar/google-calendar-client.js').CalendarEvent} event
 * @returns {string}
 */
function formatEventTime(event) {
  if (event.allDay) {
    return `${event.start} (todo el día)`;
  }
  try {
    const start = new Date(event.start);
    const end = event.end ? new Date(event.end) : null;
    const dayFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: '2-digit', month: 'short' });
    const timeFmt = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
    const dayPart = dayFmt.format(start);
    const startTime = timeFmt.format(start);
    const endTime = end ? timeFmt.format(end) : '';
    return `${dayPart} ${startTime}${endTime ? `–${endTime}` : ''}`;
  } catch {
    return event.start;
  }
}

/**
 * Renders a list of email summaries in plain text. Used by both `luis mail today` and
 * `luis mail from`. One block per email separated by blank lines.
 *
 * @param {import('./terminal-renderer.js').TerminalRenderer} renderer
 * @param {import('../../modules/email/gmail-client.js').EmailSummary[]} emails
 */
function renderEmailList(renderer, emails) {
  emails.forEach((email, i) => {
    if (i > 0) renderer.print('');
    renderer.print(`${i + 1}. ${email.subject || '(sin asunto)'}`);
    renderer.print(`   De:    ${email.from || '(desconocido)'}`);
    if (email.date) renderer.print(`   Fecha: ${email.date}`);
    if (email.snippet) renderer.print(`   ${email.snippet}`);
  });
}

/**
 * @typedef {Object} CliApp
 * @property {(argv: string[]) => Promise<number>} runCommand
 * @property {() => Promise<number>} runInteractive
 * @property {import('./cli-command-router.js').CliCommandRouter} router
 * @property {import('./terminal-renderer.js').TerminalRenderer} renderer
 */
