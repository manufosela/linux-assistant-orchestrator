import { createLocalLlmProvider } from './local-llm-provider.js';
import { createCloudLlmProvider } from './cloud-llm-provider.js';
import { createFailoverLlmProvider } from './failover-llm-provider.js';

/**
 * Creates an LLM provider based on configuration.
 *
 * Cloud providers are disabled by default.
 * If `allowCloudLlm` is false and a cloud provider is requested, throws an error.
 *
 * @param {import('../../../types/llm.js').LlmConfig} config
 * @param {import('pino').Logger} logger
 * @returns {import('../../../types/llm.js').LlmProvider}
 */
export function createLlmProvider(config, logger) {
  const { provider, allowCloudLlm, local, cloud } = config;

  if (provider === 'local') {
    const primary = createLocalLlmProvider(local, logger);
    if (local.backupUrl) {
      const backup = createLocalLlmProvider({ ...local, baseUrl: local.backupUrl }, logger);
      logger.info(
        { provider: 'local', baseUrl: local.baseUrl, backupUrl: local.backupUrl, model: local.model },
        'Using local LLM provider with failover backup',
      );
      return createFailoverLlmProvider({ primary, backup, logger });
    }
    logger.info({ provider: 'local', baseUrl: local.baseUrl, model: local.model }, 'Using local LLM provider');
    return primary;
  }

  if (provider === 'cloud') {
    if (!allowCloudLlm) {
      throw new CloudLlmDisabledError();
    }

    if (!cloud?.provider || !cloud?.apiKey) {
      throw new Error('Cloud LLM provider requires CLOUD_LLM_PROVIDER and CLOUD_LLM_API_KEY');
    }

    logger.info({ provider: cloud.provider }, 'Using cloud LLM provider');
    return createCloudLlmProvider(cloud, logger);
  }

  throw new Error(`Unknown LLM provider: ${provider}. Supported values: local, cloud`);
}

/**
 * Thrown when a cloud LLM is requested but ALLOW_CLOUD_LLM is false.
 */
export class CloudLlmDisabledError extends Error {
  constructor() {
    super('Cloud LLM is disabled. Set ALLOW_CLOUD_LLM=true to enable it.');
    this.name = 'CloudLlmDisabledError';
  }
}
