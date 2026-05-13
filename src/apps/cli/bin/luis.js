#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../../infrastructure/config/load-config.js';
import { createLogger } from '../../../infrastructure/logger/create-logger.js';
import { createApprovalService } from '../../../modules/security/approval-service.js';
import { createLlmProvider } from '../../../modules/llm/llm-provider-factory.js';
import { createLlmService } from '../../../modules/llm/llm-service.js';
import { createDownloadRulesRepository } from '../../../modules/downloads/download-rules-repository.js';
import { createAssistantStatusService } from '../../../modules/assistant/assistant-status-service.js';
import { createUrlFetcher } from '../../../modules/web/url-fetcher.js';
import { createWebSearchService } from '../../../modules/web/web-search.js';
import { createHomeAssistantClient } from '../../../modules/home-assistant/ha-client.js';
import { createHomeAssistantStateCache } from '../../../modules/home-assistant/ha-state-cache.js';
import { createSmartHomeAssistantClient } from '../../../modules/home-assistant/ha-smart-client.js';
import { createAlexaAnnouncer } from '../../../modules/home-assistant/ha-alexa-announcer.js';
import { createGoogleAuth } from '../../../modules/google/google-auth.js';
import { createGmailClient } from '../../../modules/email/gmail-client.js';
import { createCliApp } from '../create-cli-app.js';
import { loadUserConfig } from '../user-config-loader.js';

const APP_NAME = 'luis';
const startTime = new Date();
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = resolve(HERE, '../../../../package.json');

/**
 * Reads the package version from package.json. Falls back to '0.0.0' if it cannot be read.
 *
 * @returns {{ name: string, version: string }}
 */
function readPackageInfo() {
  try {
    const raw = readFileSync(PACKAGE_JSON_PATH, 'utf8');
    const pkg = JSON.parse(raw);
    return { name: pkg.name ?? 'assistant', version: pkg.version ?? '0.0.0' };
  } catch {
    return { name: 'assistant', version: '0.0.0' };
  }
}

/**
 * Builds the assistant module-status array used by `luis status`.
 *
 * @param {import('../../../infrastructure/config/load-config.js').AssistantConfig} config
 * @returns {import('../../../modules/assistant/assistant-status-service.js').AssistantModuleStatus[]}
 */
function buildModuleStatuses(config) {
  return [
    { name: 'cli', status: 'enabled' },
    { name: 'telegram', status: config.telegram.botToken ? 'enabled' : 'disabled', note: config.telegram.botToken ? undefined : 'No bot token' },
    { name: 'downloads', status: 'enabled' },
    { name: 'llm', status: 'enabled', note: `provider: ${config.llm.provider}` },
    { name: 'email', status: 'placeholder', note: `provider: ${config.email.provider}` },
    { name: 'calendar', status: 'placeholder', note: `provider: ${config.calendar.provider}` },
    { name: 'planning-game', status: config.planningGame.baseUrl ? 'enabled' : 'placeholder' },
    { name: 'code-agents', status: config.codeAgents.enableRemoteCodeTasks ? 'enabled' : 'disabled' },
    { name: 'web', status: config.web.enabled ? 'enabled' : 'disabled', note: config.web.enabled ? `${config.web.host}:${config.web.port}` : undefined },
  ];
}

async function main() {
  const argv = process.argv.slice(2);
  // Load the user-level config first so values propagate to env before loadConfig() runs.
  // External env vars and project .env still take precedence over the user config file.
  loadUserConfig();
  const config = loadConfig();
  const pkg = readPackageInfo();

  const logger = createLogger({
    level: process.env.CLI_LOG_LEVEL ?? 'silent',
    name: `${APP_NAME}-cli`,
    pretty: false,
  });

  let llmProvider;
  try {
    llmProvider = createLlmProvider(config.llm, logger);
  } catch (error) {
    process.stderr.write(`Failed to create LLM provider: ${error?.message ?? error}\n`);
    process.exit(1);
  }

  const llmService = createLlmService(llmProvider, config.llm, logger);
  const approvalService = createApprovalService(logger);
  const rulesRepository = createDownloadRulesRepository(config.downloads.rulesPath, logger);
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
  let alexaAnnouncer;
  if (config.homeAssistant.baseUrl && config.homeAssistant.token) {
    const baseClient = createHomeAssistantClient({
      baseUrl: config.homeAssistant.baseUrl,
      token: config.homeAssistant.token,
      language: config.homeAssistant.language,
      agentId: config.homeAssistant.agentId,
      logger,
    });
    const stateCache = createHomeAssistantStateCache({
      baseUrl: config.homeAssistant.baseUrl,
      token: config.homeAssistant.token,
      logger,
    });
    // Best-effort initial refresh: if HA is down at CLI start the fast path is just unavailable.
    await stateCache.refresh().catch(() => {});
    homeAssistant = createSmartHomeAssistantClient({
      haClient: baseClient,
      stateCache,
      logger,
    });
    alexaAnnouncer = createAlexaAnnouncer({ haClient: baseClient, logger });
  }
  const statusService = createAssistantStatusService({
    // Hard-coded — the CLI binary IS `luis`. Ignore ASSISTANT_NAME / config so this name
    // cannot be silently changed by an env var or by the user config file.
    assistantName: APP_NAME,
    startTime,
    modules: buildModuleStatuses(config),
  });

  let googleAuth;
  let gmailClient;
  if (config.google.credentialsPath && config.google.tokensPath) {
    googleAuth = createGoogleAuth({
      credentialsPath: config.google.credentialsPath,
      tokensPath: config.google.tokensPath,
      logger,
    });
    gmailClient = createGmailClient({ googleAuth, llmService, logger });
  }

  const app = createCliApp({
    llmService,
    statusService,
    rulesRepository,
    approvalService,
    urlFetcher,
    webSearch,
    homeAssistant,
    alexaAnnouncer,
    googleAuth,
    gmailClient,
    logger,
    appName: APP_NAME,
    appVersion: pkg.version,
    llmProvider: config.llm.provider,
    remoteCodeTasksEnabled: config.codeAgents.enableRemoteCodeTasks,
  });

  const exitCode = argv.length === 0 ? await app.runInteractive() : await app.runCommand(argv);
  process.exit(exitCode);
}

main().catch((error) => {
  process.stderr.write(`Fatal CLI error: ${error?.message ?? error}\n`);
  process.exit(1);
});
