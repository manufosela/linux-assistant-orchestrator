import { setGlobalDispatcher, Agent } from 'undici';
import { loadConfig } from './infrastructure/config/load-config.js';
import { createLogger } from './infrastructure/logger/create-logger.js';
import { createScheduler } from './infrastructure/scheduler/scheduler.js';
import { createDangerousCommandDetector } from './modules/security/dangerous-command-detector.js';
import { createApprovalService } from './modules/security/approval-service.js';
import { createAllowedChatPolicy } from './modules/security/allowed-chat-policy.js';
import { createLlmProvider } from './modules/llm/llm-provider-factory.js';
import { createLlmService } from './modules/llm/llm-service.js';
import { createDownloadRulesRepository } from './modules/downloads/download-rules-repository.js';
import { createFileClassifier } from './modules/downloads/file-classifier.js';
import { createLlmFileClassifier } from './modules/downloads/llm-file-classifier.js';
import { createDownloadClassifier } from './modules/downloads/download-classifier.js';
import { createFileMover } from './modules/downloads/file-mover.js';
import { createDownloadWatcher } from './modules/downloads/download-watcher.js';
import { createAssistantStatusService } from './modules/assistant/assistant-status-service.js';
import { createTelegramBot } from './apps/telegram-bot/create-telegram-bot.js';
import { createTelegramCommandRouter } from './apps/telegram-bot/telegram-command-router.js';
import { registerTelegramHandlers } from './apps/telegram-bot/telegram-message-handler.js';
import { createWebApp } from './apps/web/create-web-app.js';
import { createUrlFetcher } from './modules/web/url-fetcher.js';
import { createWebSearchService } from './modules/web/web-search.js';
import { createHomeAssistantClient } from './modules/home-assistant/ha-client.js';
import { createHomeAssistantStateCache } from './modules/home-assistant/ha-state-cache.js';
import { createSmartHomeAssistantClient } from './modules/home-assistant/ha-smart-client.js';
import { createAlexaAnnouncer } from './modules/home-assistant/ha-alexa-announcer.js';
import { createNotificationService } from './modules/notifications/notification-service.js';
import { createTelegramNotificationChannel } from './modules/notifications/telegram-notification-channel.js';
import { buildClusterTargets } from './modules/cluster/cluster-targets.js';
import { createClusterHealthChecker } from './modules/cluster/cluster-health-checker.js';
import { createClusterHistoryStore } from './modules/cluster/cluster-history-store.js';
import { createClusterStatusService } from './modules/cluster/cluster-status-service.js';
import { createClusterWatcher } from './modules/cluster/cluster-watcher.js';
import { createClusterStateStore } from './modules/cluster/cluster-state-store.js';
import { createTemperatureWatcher } from './modules/temperature/temperature-watcher.js';
import { createPrometheusClient } from './modules/prometheus/prometheus-client.js';
import { createGoogleAuth } from './modules/google/google-auth.js';
import { createGmailClient } from './modules/email/gmail-client.js';
import { createGmailLabels } from './modules/email/gmail-labels.js';
import { createGmailDigest, scheduleDaily as scheduleDailyGmailDigest } from './modules/email/gmail-digest.js';
import { createDigestConfigStore } from './modules/email/digest-config-store.js';
import { createDigestLastRunStore } from './modules/email/digest-last-run-store.js';
import { createDigestRunner } from './modules/email/digest-runner.js';
import { createSummaryStore } from './modules/email/summary-store.js';
import { createGoogleCalendarClient } from './modules/calendar/google-calendar-client.js';
import { createGoogleDriveClient } from './modules/drive/google-drive-client.js';
import { createWhisperClient } from './modules/whisper/whisper-client.js';
import { createMediaTranscriber } from './modules/media/media-transcriber.js';
import { createTranscriptSummariser } from './modules/summarisation/transcript-summariser.js';
import { createYoutubeSubtitleFetcher } from './modules/youtube/youtube-subtitle-fetcher.js';
import { createYoutubeAudioFetcher } from './modules/youtube/youtube-audio-fetcher.js';
import { createYoutubeService } from './modules/youtube/youtube-service.js';
import { createInboxStore } from './modules/inbox/inbox-store.js';
import { createInboxRouter } from './modules/inbox/inbox-router.js';
import { createInboxProcessor } from './modules/inbox/inbox-processor.js';
import { createMarkitdownClient } from './modules/inbox/markitdown-client.js';
import { createUrlCapture } from './modules/inbox/url-capture.js';
import { createInboxQuery } from './modules/inbox/inbox-query.js';
import { createInboxReader } from './modules/inbox/inbox-reader.js';

const startTime = new Date();

async function main() {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    name: config.assistantName,
    pretty: config.env === 'development',
  });

  logger.info({ name: config.assistantName, env: config.env }, 'Assistant starting');

  // Infrastructure
  const scheduler = createScheduler();

  // Security
  const dangerousCommandDetector = createDangerousCommandDetector();
  const approvalService = createApprovalService(logger);
  const allowedChatPolicy = createAllowedChatPolicy(config.telegram.allowedChatIds, logger);

  // LLM
  let llmProvider;
  try {
    llmProvider = createLlmProvider(config.llm, logger);
  } catch (error) {
    logger.error({ err: error.message }, 'Failed to create LLM provider');
    process.exit(1);
  }
  const llmService = createLlmService(llmProvider, config.llm, logger);

  // Downloads
  const rulesRepository = createDownloadRulesRepository(config.downloads.rulesPath, logger);
  const fileClassifier = createFileClassifier(rulesRepository);
  const llmFileClassifier = createLlmFileClassifier(llmService, rulesRepository, logger);
  const fileMover = createFileMover(logger);
  const downloadWatcher = createDownloadWatcher(config.downloads.watchPath, logger);

  // LUI-TSK-0066: clasificador semántico de descargas (heurística + LLM)
  // para el endpoint POST /api/classify-download que usa el script
  // move-tg-to-nas.sh del portátil.
  const downloadClassifier = createDownloadClassifier({ llmService, logger });

  // Wire download pipeline: new file → classify → move
  downloadWatcher.onNewFile(async (filePath) => {
    let classification = await fileClassifier.classify(filePath);

    if (!classification.matched && config.downloads.enableLlmClassification) {
      logger.debug({ filePath }, 'Rule-based classification failed — trying LLM');
      classification = await llmFileClassifier.classify(filePath);
    }

    if (classification.matched && classification.rule) {
      const result = await fileMover.moveToDirectory(filePath, classification.rule.targetPath);
      if (result.success) {
        logger.info(
          { filePath, targetPath: result.targetPath, method: classification.method, rule: classification.rule.name },
          'File organised'
        );
      } else if (result.skipped) {
        logger.warn({ filePath, reason: result.skipReason }, 'File move skipped');
      } else {
        logger.error({ filePath, err: result.error }, 'File move failed');
      }
    } else {
      logger.info({ filePath }, 'No matching rule — file left in place');
    }
  });

  // Assistant status
  const moduleStatuses = [
    { name: 'telegram', status: config.telegram.botToken ? 'enabled' : 'disabled', note: config.telegram.botToken ? undefined : 'No bot token' },
    { name: 'downloads', status: 'enabled' },
    { name: 'llm', status: 'enabled', note: `provider: ${config.llm.provider}` },
    { name: 'email', status: 'placeholder', note: `provider: ${config.email.provider}` },
    { name: 'calendar', status: 'placeholder', note: `provider: ${config.calendar.provider}` },
    { name: 'planning-game', status: config.planningGame.baseUrl ? 'enabled' : 'placeholder' },
    { name: 'code-agents', status: config.codeAgents.enableRemoteCodeTasks ? 'enabled' : 'disabled' },
    { name: 'web', status: config.web.enabled ? 'enabled' : 'disabled', note: config.web.enabled ? `${config.web.host}:${config.web.port}` : undefined },
    { name: 'cluster', status: config.cluster.enabled ? 'enabled' : 'disabled' },
    { name: 'prometheus', status: config.prometheus.enabled ? 'enabled' : 'disabled' },
    { name: 'temperature', status: config.temperature.enabled ? 'enabled' : 'disabled' },
  ];

  const statusService = createAssistantStatusService({
    assistantName: config.assistantName,
    startTime,
    modules: moduleStatuses,
  });

  // Cluster monitoring infrastructure (shared by the watcher and the Telegram command)
  const clusterTargets = buildClusterTargets(config.cluster);
  const clusterHealthChecker = createClusterHealthChecker({ logger });
  const clusterHistoryStore = createClusterHistoryStore({
    filePath: config.cluster.historyPath,
    logger,
  });
  const clusterStatusService = createClusterStatusService({
    healthChecker: clusterHealthChecker,
    targets: clusterTargets,
    historyStore: clusterHistoryStore,
  });

  // Prometheus — on-demand "is anything down?" checks. No watcher, no alerts:
  // it is only queried when the user explicitly asks (Telegram or web).
  const prometheusClient = config.prometheus.enabled
    ? createPrometheusClient({
        baseUrl: config.prometheus.baseUrl,
        timeoutMs: config.prometheus.timeoutMs,
        logger,
      })
    : null;
  if (!prometheusClient) {
    logger.info('Prometheus integration disabled (set PROMETHEUS_ENABLED=true to enable)');
  }

  // Web tools (URL fetch + search) — shared with the web app, CLI and Telegram
  const urlFetcher = createUrlFetcher({
    logger,
    allowPrivateNetworks: config.webTools.urlFetch.allowPrivateNetworks,
    privateAllowlist: config.webTools.urlFetch.privateAllowlist,
  });
  const webSearch = config.webTools.search.baseUrl
    ? createWebSearchService({
        baseUrl: config.webTools.search.baseUrl,
        apiKey: config.webTools.search.apiKey,
        logger,
      })
    : undefined;

  let homeAssistant;
  let homeAssistantStateCache;
  let alexaAnnouncer;
  if (config.homeAssistant.baseUrl && config.homeAssistant.token) {
    const baseClient = createHomeAssistantClient({
      baseUrl: config.homeAssistant.baseUrl,
      token: config.homeAssistant.token,
      language: config.homeAssistant.language,
      agentId: config.homeAssistant.agentId,
      logger,
    });
    homeAssistantStateCache = createHomeAssistantStateCache({
      baseUrl: config.homeAssistant.baseUrl,
      token: config.homeAssistant.token,
      logger,
    });
    homeAssistantStateCache.start().catch((error) =>
      logger.warn({ err: error?.message }, 'HA state cache initial load failed (will retry)'),
    );
    homeAssistant = createSmartHomeAssistantClient({
      haClient: baseClient,
      stateCache: homeAssistantStateCache,
      logger,
    });
    alexaAnnouncer = createAlexaAnnouncer({ haClient: baseClient, logger });
  }

  // Google: OAuth2 + Gmail + Calendar (read-only)
  let googleAuth;
  let gmailClient;
  let gmailLabels;
  let gmailDigest;
  let calendarClient;
  let driveClient;
  if (config.google.credentialsPath && config.google.tokensPath) {
    googleAuth = createGoogleAuth({
      credentialsPath: config.google.credentialsPath,
      tokensPath: config.google.tokensPath,
      logger,
    });
    gmailClient = createGmailClient({ googleAuth, llmService, logger });
    gmailLabels = createGmailLabels({ googleAuth, llmService, logger });
    gmailDigest = createGmailDigest({ googleAuth, llmService, gmailLabels, logger });
    calendarClient = createGoogleCalendarClient({ googleAuth, logger });
    driveClient = createGoogleDriveClient({ googleAuth, logger });
  }

  // LUI-BUG-0004: subir headersTimeout/bodyTimeout del fetch global a 30 min
  // para que Whisper pueda procesar audios largos sin que undici aborte a
  // los 5 min por defecto. Hay que hacerlo ANTES de crear ningún cliente.
  // Sólo aplicamos esto si hay endpoint Whisper configurado, para no afectar
  // a deploys que no lo usan.
  if (config.whisper.baseUrl) {
    setGlobalDispatcher(new Agent({
      headersTimeout: config.whisper.timeoutMs,
      bodyTimeout: config.whisper.timeoutMs,
    }));
    logger.info({ timeoutMs: config.whisper.timeoutMs }, 'undici global dispatcher set for long Whisper requests');
  }

  // Whisper + summariser compartidos entre /youtube y /transcribe.
  // Sin baseUrl no hay ni transcripción ni resumen-de-audio: ambos comandos
  // responderán "no configurado" y el resto del bot seguirá funcionando.
  const sharedWhisperClient = config.whisper.baseUrl
    ? createWhisperClient({
        baseUrl: config.whisper.baseUrl,
        model: config.whisper.model,
        apiKey: config.whisper.apiKey,
        timeoutMs: config.whisper.timeoutMs,
        logger,
      })
    : undefined;

  const sharedSummariser = sharedWhisperClient
    ? createTranscriptSummariser({
        llmService,
        chunkChars: config.youtube.summaryChunkChars,
        logger,
        module: 'media',
      })
    : undefined;

  // YouTube transcription pipeline (subs → audio → whisper → llm summary).
  const youtubeService = sharedWhisperClient
    ? createYoutubeService({
        subtitleFetcher: createYoutubeSubtitleFetcher({
          ytdlpBin: config.youtube.ytdlpBin,
          timeoutMs: config.youtube.subtitleTimeoutMs,
          logger,
        }),
        audioFetcher: createYoutubeAudioFetcher({
          ytdlpBin: config.youtube.ytdlpBin,
          timeoutMs: config.youtube.audioTimeoutMs,
          logger,
        }),
        whisperClient: sharedWhisperClient,
        llmService,
        defaultLanguage: config.youtube.defaultLanguage,
        summaryChunkChars: config.youtube.summaryChunkChars,
        logger,
      })
    : undefined;

  // Local media transcriber: ficheros video/audio subidos por Telegram o
  // pasados por la CLI. Comparte whisperClient y summariser con youtube.
  const mediaTranscriber = sharedWhisperClient
    ? createMediaTranscriber({
        whisperClient: sharedWhisperClient,
        summariser: sharedSummariser,
        ffmpegBin: 'ffmpeg',
        maxBytes: config.media.maxBytes,
        maxDurationSec: config.media.maxDurationSec,
        defaultLanguage: config.youtube.defaultLanguage,
        logger,
      })
    : undefined;

  // Inbox: storage + classifier + dispatcher. Telegram inbound items
  // (documents, photos, voice, audio, video) land in the store, get classified
  // by the LLM-backed router, and dispatched to the matching action
  // (note → notes/, descartar → marked discarded, foto/doc/voz → pending
  // downstream cards).
  // Digest config store (LUI-TSK-0063): persistencia de qué etiquetas se
  // envían a diario en modo LISTA vs RESUMEN. Anula los defaults de .env
  // si el fichero existe.
  const digestConfigStore = createDigestConfigStore({
    statePath: `${config.gmailDigest.cachePath}/state.json`,
    defaults: {
      listLabels: config.gmailDigest.listLabels,
      summaryLabels: config.gmailDigest.summaryLabels,
    },
    logger,
  });

  // LUI-TSK-0064: last-run por etiqueta (qué ids enviamos ayer, para
  // marcarlos como leídos hoy) + runner que orquesta el cron por etiqueta.
  const digestLastRunStore = createDigestLastRunStore({
    dir: `${config.gmailDigest.cachePath}/last-run`,
    logger,
  });
  const summaryStore = createSummaryStore({
    dir: `${config.gmailDigest.cachePath}/summaries`,
    logger,
  });
  const digestRunner = gmailDigest && gmailLabels
    ? createDigestRunner({
        gmailDigest,
        gmailLabels,
        lastRunStore: digestLastRunStore,
        summaryStore,
        llmService,
        logger,
      })
    : null;

  const inboxStore = createInboxStore({ inboxPath: config.inbox.path, logger });
  const inboxRouter = createInboxRouter({
    llmService,
    classifyModel: config.inbox.classifyModel || null,
    logger,
  });
  const markitdownClient = config.inbox.markitdownUrl
    ? createMarkitdownClient({
        baseUrl: config.inbox.markitdownUrl,
        timeoutMs: config.inbox.markitdownTimeoutMs,
        logger,
      })
    : null;
  if (!markitdownClient) {
    logger.info('Markitdown extraction disabled (set MARKITDOWN_URL to enable)');
  }
  const inboxProcessor = createInboxProcessor({
    router: inboxRouter,
    inboxStore,
    notesPath: config.inbox.notesPath,
    markitdownClient,
    driveClient: config.inbox.driveFolderId ? driveClient : null,
    driveInboxFolderId: config.inbox.driveFolderId || null,
    mediaTranscriber,
    logger,
  });
  if (!config.inbox.driveFolderId) {
    logger.info('Drive upload disabled (set DRIVE_INBOX_FOLDER_ID to enable)');
  }
  // URL capture has its own flow: urlFetcher already extracts text + title,
  // so we skip the router/markitdown and store the result directly.
  const urlCapture = createUrlCapture({ urlFetcher, inboxStore, logger });
  const inboxQuery = createInboxQuery({ inboxStore, logger });
  const inboxReader = createInboxReader({
    inboxQuery,
    llmService,
    summariseModel: config.inbox.summariseModel || null,
    summaryLanguage: config.inbox.summaryLanguage,
    summaryChunkChars: config.inbox.summaryChunkChars,
    logger,
  });

  // Telegram bot
  let bot = null;
  let telegramStop = async () => {};
  /** @type {import('./modules/notifications/notification-service.js').NotificationChannel | null} */
  let telegramNotificationChannel = null;

  if (config.telegram.botToken) {
    const { bot: telegramBot, start, stop } = createTelegramBot(config.telegram.botToken, logger);
    bot = telegramBot;
    telegramStop = stop;

    const notifyChatId = config.telegram.notifyChatId || config.telegram.allowedChatIds[0] || '';
    telegramNotificationChannel = createTelegramNotificationChannel(bot, notifyChatId, logger);

    const router = createTelegramCommandRouter(allowedChatPolicy, logger);

    registerTelegramHandlers({
      bot,
      statusService,
      rulesRepository,
      llmService,
      urlFetcher,
      webSearch,
      homeAssistant,
      alexaAnnouncer,
      clusterStatus: clusterStatusService,
      prometheusClient,
      gmailClient,
      gmailLabels,
      gmailDigest,
      gmailDigestConfig: config.gmailDigest,
      digestConfigStore,
      summaryStore,
      calendarClient,
      driveClient,
      inboxStore,
      inboxProcessor,
      urlCapture,
      inboxQuery,
      inboxReader,
      youtubeService,
      mediaTranscriber,
      router,
      logger,
    });

    bot.on('message', (message) => {
      router.route(message).catch((error) => {
        logger.error({ err: error.message }, 'Unhandled error in message routing');
      });
    });

    bot.on('error', (error) => {
      logger.error({ err: error.message }, 'Telegram bot error');
    });

    start();
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram bot is disabled');
  }

  // Notifications: Telegram channel when the bot is up, otherwise a no-op sink.
  const notificationService = createNotificationService(
    telegramNotificationChannel ? [telegramNotificationChannel] : [],
    logger,
  );

  // Cluster watcher — monitors the 3 nodes and alerts on Telegram on failure/recovery.
  let clusterWatcher = null;
  if (config.cluster.enabled) {
    const clusterStateStore = createClusterStateStore({
      filePath: config.cluster.historyPath.replace(/history\.json$/, 'state.json'),
      logger,
    });
    clusterWatcher = createClusterWatcher({
      logger,
      scheduler,
      notificationService,
      healthChecker: clusterHealthChecker,
      targets: clusterTargets,
      historyStore: clusterHistoryStore,
      stateStore: clusterStateStore,
      quietWindowStart: config.cluster.quietWindowStart,
      quietWindowEnd: config.cluster.quietWindowEnd,
    });
    clusterWatcher.start();
  } else {
    logger.info('Cluster watcher disabled (set CLUSTER_ENABLED=true to enable)');
  }

  // Temperature watcher (LUI-TSK-0071) — vigila la temperatura de Home Assistant
  // y avisa por Telegram según temporada (verano: calor; invierno: frío).
  let temperatureWatcher = null;
  if (config.temperature.enabled && homeAssistantStateCache) {
    temperatureWatcher = createTemperatureWatcher({
      logger,
      scheduler,
      notificationService,
      stateCache: homeAssistantStateCache,
      checkIntervalMs: config.temperature.checkIntervalMs,
      summerMonths: config.temperature.summerMonths,
      winterMonths: config.temperature.winterMonths,
      summerMeanThreshold: config.temperature.summerMeanThreshold,
      summerRoomThreshold: config.temperature.summerRoomThreshold,
      winterMeanThreshold: config.temperature.winterMeanThreshold,
      winterRoomThreshold: config.temperature.winterRoomThreshold,
      reAlertMs: config.temperature.reAlertMs,
      excludePattern: config.temperature.excludePattern,
      requireArea: config.temperature.requireArea,
      quietWindowStart: config.temperature.quietWindowStart,
      quietWindowEnd: config.temperature.quietWindowEnd,
    });
    temperatureWatcher.start();
  } else if (config.temperature.enabled) {
    logger.warn('Temperature watcher enabled but Home Assistant is not available — skipped');
  } else {
    logger.info('Temperature watcher disabled (set TEMP_WATCHER_ENABLED=true to enable)');
  }

  // Gmail digest diario (LUI-TSK-0031 / LUI-TSK-0064). Off por defecto:
  // requiere gmailDigest, notificación y GMAIL_DIGEST_ENABLED=true.
  //
  // Modo nuevo (preferido): si en el digestConfigStore hay listLabels y/o
  // summaryLabels, el runner procesa cada etiqueta como canal LISTA y/o
  // canal RESUMEN (este último implementado en LUI-TSK-0065).
  //
  // Modo legacy: si NO hay etiquetas configuradas, cae al dispatch único
  // con GMAIL_DIGEST_QUERY (comportamiento previo).
  if (config.gmailDigest.enabled && gmailDigest && telegramNotificationChannel) {
    scheduleDailyGmailDigest({
      scheduler,
      hour: config.gmailDigest.hour,
      minute: config.gmailDigest.minute,
      logger,
      run: async () => {
        try {
          const cfg = await digestConfigStore.get();
          const hasListLabels = cfg.listLabels.length > 0;
          const hasSummaryLabels = cfg.summaryLabels.length > 0;

          if (digestRunner && hasListLabels) {
            await digestRunner.runListChannel({
              listLabels: cfg.listLabels,
              maxResults: config.gmailDigest.maxResults,
              notify: (text) => notificationService.sendNotification({ text, level: 'info' }),
            });
          }
          if (digestRunner && hasSummaryLabels) {
            await digestRunner.runSummaryChannel({
              summaryLabels: cfg.summaryLabels,
              maxResults: config.gmailDigest.maxResults,
              notify: (text) => notificationService.sendNotification({ text, level: 'info' }),
            });
          }

          // Fallback legacy si no hay etiquetas configuradas.
          if (!hasListLabels && !hasSummaryLabels) {
            await gmailDigest.dispatch({
              query: config.gmailDigest.query,
              maxResults: config.gmailDigest.maxResults,
              markAsRead: config.gmailDigest.markAsRead,
              notify: (text) => notificationService.sendNotification({ text, level: 'info' }),
            });
          }
        } catch (error) {
          logger.warn({ err: error?.message }, 'Gmail digest scheduled run failed');
        }
      },
    });
    logger.info(
      {
        hour: config.gmailDigest.hour,
        minute: config.gmailDigest.minute,
      },
      'Gmail digest scheduled',
    );
  } else if (config.gmailDigest.enabled) {
    logger.warn(
      'Gmail digest enabled but Gmail or Telegram notification channel is not configured — skipped',
    );
  }

  // Start download watcher
  downloadWatcher.start();

  // Web app (optional, off by default — bind to LAN, no auth)
  let webStop = async () => {};
  if (config.web.enabled) {
    try {
      const webApp = createWebApp({
        llmService,
        statusService,
        rulesRepository,
        urlFetcher,
        webSearch,
        homeAssistant,
        notificationService,
        prometheusClient,
        downloadClassifier,
        watchtowerWebhookToken: config.watchtower.webhookToken,
        aptHealthWebhookToken: config.aptHealth.webhookToken,
        logger,
        host: config.web.host,
        port: config.web.port,
      });
      const { address } = await webApp.start();
      webStop = webApp.stop;
      logger.info({ address }, 'Web app started');
    } catch (error) {
      logger.error({ err: error?.message }, 'Failed to start web app');
    }
  } else {
    logger.info('Web app disabled (set WEB_ENABLED=true to enable)');
  }

  logger.info({ name: config.assistantName }, 'Assistant ready');

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutdown signal received');
    scheduler.stopAll();
    clusterWatcher?.stop();
    temperatureWatcher?.stop();
    await downloadWatcher.stop();
    await telegramStop();
    await webStop();
    homeAssistantStateCache?.stop();
    logger.info('Assistant stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  process.on('uncaughtException', (error) => {
    logger.error({ err: error.message, stack: error.stack }, 'Uncaught exception');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'Unhandled promise rejection');
  });
}

main().catch((error) => {
  // Logger may not be ready yet — use console here only
  // eslint-disable-next-line no-console
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
