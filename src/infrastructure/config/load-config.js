import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

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

  return {
    env: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    assistantName: process.env.ASSISTANT_NAME ?? 'assistant',

    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
      allowedChatIds: parseCsvList(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    },

    downloads: {
      watchPath: process.env.DOWNLOADS_PATH ?? '/tmp/downloads',
      rulesPath: process.env.DOWNLOAD_RULES_PATH ?? './config/download-rules.json',
      enableLlmClassification: process.env.ENABLE_LLM_FILE_CLASSIFICATION === 'true',
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
}

/**
 * @typedef {Object} AssistantConfig
 * @property {string} env
 * @property {string} logLevel
 * @property {string} assistantName
 * @property {{ botToken: string, allowedChatIds: string[] }} telegram
 * @property {{ watchPath: string, rulesPath: string, enableLlmClassification: boolean }} downloads
 * @property {import('../../types/llm.js').LlmConfig} llm
 * @property {{ provider: string, readOnly: boolean }} email
 * @property {{ provider: string, readOnly: boolean }} calendar
 * @property {{ baseUrl: string, apiKey: string }} planningGame
 * @property {{ workspacesPath: string, enableRemoteCodeTasks: boolean, requireApproval: boolean }} codeAgents
 * @property {{ enabled: boolean, host: string, port: number }} web
 * @property {{ search: { baseUrl: string, apiKey: string }, urlFetch: { allowPrivateNetworks: boolean, privateAllowlist: string[] } }} webTools
 * @property {{ baseUrl: string, token: string, language: string, agentId: string }} homeAssistant
 */
