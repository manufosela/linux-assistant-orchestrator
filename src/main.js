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
    clusterWatcher = createClusterWatcher({
      logger,
      scheduler,
      notificationService,
      healthChecker: clusterHealthChecker,
      targets: clusterTargets,
      historyStore: clusterHistoryStore,
    });
    clusterWatcher.start();
  } else {
    logger.info('Cluster watcher disabled (set CLUSTER_ENABLED=true to enable)');
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
        watchtowerWebhookToken: config.watchtower.webhookToken,
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
