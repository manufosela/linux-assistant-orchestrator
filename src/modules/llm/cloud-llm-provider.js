/**
 * Cloud LLM provider placeholder.
 *
 * Cloud providers are disabled by default to prevent private data leaving the local network.
 * This file exists so the factory can return a typed provider even when cloud is configured.
 *
 * A real implementation would call OpenAI, Anthropic, or Google APIs.
 *
 * @param {import('../../../types/llm.js').CloudLlmConfig} config
 * @param {import('pino').Logger} logger
 * @returns {import('../../../types/llm.js').LlmProvider}
 */
export function createCloudLlmProvider(config, logger) {
  /**
   * @param {import('../../../types/llm.js').LlmPromptRequest} request
   * @returns {Promise<import('../../../types/llm.js').LlmPromptResponse>}
   */
  async function generateText(request) {
    logger.warn(
      {
        module: request.metadata.module,
        operation: request.metadata.operation,
        provider: config.provider,
        correlationId: request.metadata.correlationId,
      },
      'Cloud LLM provider is a placeholder — not implemented'
    );

    throw new CloudLlmNotImplementedError(config.provider);
  }

  /**
   * @returns {Promise<boolean>}
   */
  async function checkHealth() {
    return false;
  }

  return { generateText, checkHealth };
}

/**
 * Thrown when cloud LLM is called but not implemented.
 */
export class CloudLlmNotImplementedError extends Error {
  /**
   * @param {string} provider
   */
  constructor(provider) {
    super(`Cloud LLM provider "${provider}" is not implemented in this version`);
    this.name = 'CloudLlmNotImplementedError';
    this.provider = provider;
  }
}
