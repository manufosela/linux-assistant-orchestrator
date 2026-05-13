import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_NAME = 'luis';

/**
 * Loads a per-user configuration file and exports its values as environment variables.
 *
 * Resolves the config path in this order:
 *  1. The path given in `LUIS_CONFIG` (escape hatch).
 *  2. `$XDG_CONFIG_HOME/luis/config.json` if XDG_CONFIG_HOME is set.
 *  3. `~/.config/luis/config.json` otherwise.
 *
 * Values found in the config file are written to `process.env` only if the variable is not
 * already defined. This guarantees the precedence:
 *
 *     CLI flags > shell env > user config file > project .env > built-in defaults
 *
 * The config file format is a JSON object whose shape mirrors the runtime config (see below).
 * Unknown keys are ignored. Failures are silent so a bad config never kills the CLI; the user
 * still gets the standard "not configured" / "not reachable" feedback.
 *
 * @returns {{ loadedFrom: string | null }}
 */
export function loadUserConfig() {
  const configPath = resolveConfigPath();
  if (!configPath || !existsSync(configPath)) {
    return { loadedFrom: null };
  }

  try {
    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    applyToEnv(config);
    return { loadedFrom: configPath };
  } catch {
    return { loadedFrom: null };
  }
}

/**
 * Returns the absolute path where the user config file is expected to live.
 *
 * @returns {string}
 */
function resolveConfigPath() {
  if (process.env.LUIS_CONFIG) return process.env.LUIS_CONFIG;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg
    ? join(xdg, APP_NAME, 'config.json')
    : join(homedir(), '.config', APP_NAME, 'config.json');
}

/**
 * Maps known config keys to environment variables. Mirrors the schema consumed by
 * `loadConfig()` in the infrastructure layer. Adding a new key here is the only step
 * required to expose it through the user config file.
 */
const ENV_MAP = [
  ['llm.provider', 'LLM_PROVIDER'],
  ['llm.allowCloudLlm', 'ALLOW_CLOUD_LLM'],
  ['llm.local.baseUrl', 'LOCAL_LLM_BASE_URL'],
  ['llm.local.model', 'LOCAL_LLM_MODEL'],
  ['llm.local.apiKey', 'LOCAL_LLM_API_KEY'],
  ['llm.local.timeoutMs', 'LOCAL_LLM_TIMEOUT_MS'],
  ['llm.cloud.provider', 'CLOUD_LLM_PROVIDER'],
  ['llm.cloud.apiKey', 'CLOUD_LLM_API_KEY'],
  // assistantName is intentionally NOT mapped: the binary forces "luis" as its identity.
  ['logLevel', 'CLI_LOG_LEVEL'],
  ['codeAgents.enableRemoteCodeTasks', 'ENABLE_REMOTE_CODE_TASKS'],
  ['web.search.baseUrl', 'WEB_SEARCH_BASE_URL'],
  ['web.search.apiKey', 'WEB_SEARCH_API_KEY'],
  ['web.urlFetch.allowPrivateNetworks', 'URL_FETCH_ALLOW_PRIVATE'],
  ['web.urlFetch.privateAllowlist', 'URL_FETCH_ALLOWLIST'],
  ['homeAssistant.baseUrl', 'HA_BASE_URL'],
  ['homeAssistant.token', 'HA_TOKEN'],
  ['homeAssistant.language', 'HA_LANGUAGE'],
  ['homeAssistant.agentId', 'HA_AGENT_ID'],
  ['google.credentialsPath', 'GOOGLE_CREDENTIALS_PATH'],
  ['google.tokensPath', 'GOOGLE_TOKENS_PATH'],
];

/**
 * Walks the supplied config object and writes any known leaf values to `process.env`.
 * Existing env vars take precedence — they are never overwritten.
 *
 * @param {Record<string, unknown>} config
 */
function applyToEnv(config) {
  for (const [path, envKey] of ENV_MAP) {
    const value = readPath(config, path);
    if (value === undefined || value === null) continue;
    if (process.env[envKey] !== undefined) continue;
    process.env[envKey] = String(value);
  }
}

/**
 * Reads a nested value from an object using a dot-separated path.
 *
 * @param {Record<string, unknown> | undefined} obj
 * @param {string} path
 * @returns {unknown}
 */
function readPath(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) {
      return /** @type {Record<string, unknown>} */ (acc)[key];
    }
    return undefined;
  }, /** @type {unknown} */ (obj));
}
