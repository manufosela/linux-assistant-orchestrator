import { randomUUID } from 'node:crypto';

/**
 * High-level LLM service used by all modules.
 * Enforces privacy policies: private data must not reach cloud providers.
 * Attaches metadata to every request for observability.
 *
 * @param {import('../../../types/llm.js').LlmProvider} provider
 * @param {import('../../../types/llm.js').LlmConfig} config
 * @param {import('pino').Logger} logger
 * @returns {LlmService}
 */
export function createLlmService(provider, config, logger) {
  /**
   * Generates text using the configured provider.
   * Private flag prevents cloud providers from being used for sensitive data.
   *
   * @param {string} prompt
   * @param {{ systemPrompt?: string, module?: string, operation?: string, private?: boolean, maxTokens?: number, temperature?: number }} [options]
   * @returns {Promise<string>}
   */
  async function generateText(prompt, options = {}) {
    const {
      systemPrompt,
      module: moduleName = 'unknown',
      operation = 'generate',
      private: isPrivate = true,
      maxTokens,
      temperature,
    } = options;

    if (isPrivate && config.provider === 'cloud' && !config.allowCloudLlm) {
      throw new PrivateDataCloudError(moduleName, operation);
    }

    const correlationId = randomUUID();

    const response = await provider.generateText({
      prompt,
      systemPrompt,
      maxTokens,
      temperature,
      metadata: {
        module: moduleName,
        operation,
        correlationId,
        timestamp: new Date().toISOString(),
      },
    });

    return response.text;
  }

  /**
   * Checks the health of the configured LLM provider.
   *
   * @returns {Promise<import('../../../types/llm.js').LlmHealthStatus>}
   */
  async function checkHealth() {
    const healthy = await provider.checkHealth();

    const status = {
      healthy,
      provider: config.provider,
      model: config.local?.model ?? 'unknown',
      baseUrl: config.provider === 'local' ? config.local?.baseUrl : undefined,
    };

    if (healthy) {
      logger.info(status, 'LLM health check passed');
    } else {
      logger.warn(status, 'LLM health check failed');
    }

    return status;
  }

  return { generateText, checkHealth };
}

/**
 * Thrown when a private data request attempts to use a cloud LLM.
 */
export class PrivateDataCloudError extends Error {
  /**
   * @param {string} module
   * @param {string} operation
   */
  constructor(module, operation) {
    super(`Cannot send private data to cloud LLM. Module: ${module}, operation: ${operation}`);
    this.name = 'PrivateDataCloudError';
    this.module = module;
    this.operation = operation;
  }
}

/**
 * @typedef {Object} LlmService
 * @property {(prompt: string, options?: object) => Promise<string>} generateText
 * @property {() => Promise<import('../../../types/llm.js').LlmHealthStatus>} checkHealth
 */
