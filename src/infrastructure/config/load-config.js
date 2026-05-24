import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Loads the .env file from the given path if it exists.
 * Skips silently if the file is missing (production may use real env vars).
 *
 * @param {string} [envPath='.env']
 */
function loadDotEnv(envPath = '.env') {
  const fullPath = resolve(process.cwd(), envPath);
  if (!existsSync(fullPath)) return;

  const content = readFileSync(fullPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    // Do not override values already set in the environment
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Parses a comma-separated list of IDs into an array.
 *
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function parseCsvList(raw) {
  if (!raw) return [];
  return raw.split(',').map((id) => id.trim()).filter(Boolean);
}

/**
 * Loads and validates all configuration from environment variables.
 * Must be called once at startup after dotenv is loaded.
 *
 * @param {string} [envPath='.env']
 * @returns {AssistantConfig}
 */
export function loadConfig(envPath = '.env') {
  loadDotEnv(envPath);

  const config = {
    env: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    assistantName: process.env.ASSISTANT_NAME ?? 'assistant',

    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
      allowedChatIds: parseCsvList(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
      // Chat that receives unsolicited notifications (cluster alerts, etc.).
      // Falls back to the first allowed chat when not set explicitly.
      notifyChatId: process.env.TELEGRAM_NOTIFY_CHAT_ID ?? '',
    },

    watchtower: {
      // Shared secret for the POST /api/hooks/watchtower webhook.
      // Empty disables the endpoint (503).
      webhookToken: process.env.WATCHTOWER_WEBHOOK_TOKEN ?? '',
    },

    cluster: {
      enabled: process.env.CLUSTER_ENABLED !== 'false',
      // No hardcoded LAN: the node IPs are deployment-specific and must be
      // provided when the watcher is enabled (validated below).
      n2Ip: process.env.CLUSTER_N2_IP ?? '',
      n3Ip: process.env.CLUSTER_N3_IP ?? '',
      n4Ip: process.env.CLUSTER_N4_IP ?? '',
      historyPath:
        process.env.CLUSTER_HISTORY_PATH ?? join(homedir(), '.config', 'luis', 'cluster-history.json'),
    },

    prometheus: {
      // On-demand "is anything down?" checks against the Prometheus HTTP API.
      // No watcher, no proactive alerts — only answered when the user asks.
      // Opt-in (like the cluster watcher): set PROMETHEUS_ENABLED=true.
      enabled: process.env.PROMETHEUS_ENABLED === 'true',
      // Deployment-specific: Prometheus is reached over the LAN (validated below).
      baseUrl: process.env.PROMETHEUS_BASE_URL ?? '',
      timeoutMs: Number(process.env.PROMETHEUS_TIMEOUT_MS ?? 8000),
    },

    downloads: {
      watchPath: process.env.DOWNLOADS_PATH ?? '/tmp/downloads',
      rulesPath: process.env.DOWNLOAD_RULES_PATH ?? './config/download-rules.json',
      enableLlmClassification: process.env.ENABLE_LLM_FILE_CLASSIFICATION === 'true',
    },

    inbox: {
      path: process.env.INBOX_PATH ?? '/data/inbox',
    },

    llm: {
      provider: process.env.LLM_PROVIDER ?? 'local',
      allowCloudLlm: process.env.ALLOW_CLOUD_LLM === 'true',
      local: {
        baseUrl: process.env.LOCAL_LLM_BASE_URL ?? 'http://localhost:11434',
        model: process.env.LOCAL_LLM_MODEL ?? '',
        apiKey: process.env.LOCAL_LLM_API_KEY ?? '',
        timeoutMs: Number(process.env.LOCAL_LLM_TIMEOUT_MS ?? 120000),
      },
      cloud: {
        provider: process.env.CLOUD_LLM_PROVIDER ?? '',
        apiKey: process.env.CLOUD_LLM_API_KEY ?? '',
      },
    },

    email: {
      provider: process.env.EMAIL_PROVIDER ?? 'disabled',
      readOnly: process.env.EMAIL_READ_ONLY !== 'false',
    },

    calendar: {
      provider: process.env.CALENDAR_PROVIDER ?? 'disabled',
      readOnly: process.env.CALENDAR_READ_ONLY !== 'false',
    },

    google: {
      credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH ?? '',
      tokensPath: process.env.GOOGLE_TOKENS_PATH ?? '',
    },

    planningGame: {
      baseUrl: process.env.PLANNING_GAME_BASE_URL ?? '',
      apiKey: process.env.PLANNING_GAME_API_KEY ?? '',
    },

    codeAgents: {
      workspacesPath: process.env.CODE_WORKSPACES_PATH ?? '/tmp/ai-workspaces',
      enableRemoteCodeTasks: process.env.ENABLE_REMOTE_CODE_TASKS === 'true',
      requireApproval: process.env.REQUIRE_APPROVAL_FOR_CODE_TASKS !== 'false',
    },

    web: {
      enabled: process.env.WEB_ENABLED === 'true',
      host: process.env.WEB_HOST ?? '0.0.0.0',
      port: Number(process.env.WEB_PORT ?? 3000),
    },

    webTools: {
      search: {
        baseUrl: process.env.WEB_SEARCH_BASE_URL ?? '',
        apiKey: process.env.WEB_SEARCH_API_KEY ?? '',
      },
      urlFetch: {
        allowPrivateNetworks: process.env.URL_FETCH_ALLOW_PRIVATE === 'true',
        privateAllowlist: (process.env.URL_FETCH_ALLOWLIST ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
      },
    },

    homeAssistant: {
      baseUrl: process.env.HA_BASE_URL ?? '',
      token: process.env.HA_TOKEN ?? '',
      language: process.env.HA_LANGUAGE ?? 'es',
      agentId: process.env.HA_AGENT_ID ?? '',
    },
  };

  validateConfig(config);
  return config;
}

/**
 * Fails fast on configuration that would otherwise break or silently misbehave
 * at runtime. Keep messages actionable (tell the user exactly what to set).
 *
 * @param {AssistantConfig} config
 */
function validateConfig(config) {
  if (config.cluster.enabled) {
    const missing = ['n2Ip', 'n3Ip', 'n4Ip']
      .filter((key) => !config.cluster[key])
      .map((key) => `CLUSTER_${key.replace('Ip', '').toUpperCase()}_IP`);
    if (missing.length > 0) {
      throw new Error(
        `Cluster watcher is enabled but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
          'Set them in your .env (see DEPLOYMENT.md) or set CLUSTER_ENABLED=false to disable the watcher.',
      );
    }
  }

  if (config.prometheus.enabled && !config.prometheus.baseUrl) {
    throw new Error(
      'Prometheus integration is enabled but PROMETHEUS_BASE_URL is not set. ' +
        'Set it (e.g. http://192.168.1.7:9090) or set PROMETHEUS_ENABLED=false to disable it.',
    );
  }
}

/**
 * @typedef {Object} AssistantConfig
 * @property {string} env
 * @property {string} logLevel
 * @property {string} assistantName
 * @property {{ botToken: string, allowedChatIds: string[], notifyChatId: string }} telegram
 * @property {{ webhookToken: string }} watchtower
 * @property {{ enabled: boolean, n2Ip: string, n3Ip: string, n4Ip: string, historyPath: string }} cluster
 * @property {{ enabled: boolean, baseUrl: string, timeoutMs: number }} prometheus
 * @property {{ watchPath: string, rulesPath: string, enableLlmClassification: boolean }} downloads
 * @property {{ path: string }} inbox
 * @property {import('../../types/llm.js').LlmConfig} llm
 * @property {{ provider: string, readOnly: boolean }} email
 * @property {{ provider: string, readOnly: boolean }} calendar
 * @property {{ baseUrl: string, apiKey: string }} planningGame
 * @property {{ workspacesPath: string, enableRemoteCodeTasks: boolean, requireApproval: boolean }} codeAgents
 * @property {{ enabled: boolean, host: string, port: number }} web
 * @property {{ search: { baseUrl: string, apiKey: string }, urlFetch: { allowPrivateNetworks: boolean, privateAllowlist: string[] } }} webTools
 * @property {{ baseUrl: string, token: string, language: string, agentId: string }} homeAssistant
 * @property {{ credentialsPath: string, tokensPath: string }} google
 */
