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
   * Chat-style call with a full messages array (multi-turn conversations and slash commands).
   * Same privacy policies as generateText: private requests are blocked from cloud providers
   * unless the operator explicitly enabled them.
   *
   * @param {Array<{ role: 'system'|'user'|'assistant', content: string }>} messages
   * @param {{ module?: string, operation?: string, private?: boolean, maxTokens?: number, temperature?: number, model?: string }} [options]
   * @returns {Promise<string>}
   */
  async function chat(messages, options = {}) {
    const {
      module: moduleName = 'unknown',
      operation = 'chat',
      private: isPrivate = true,
      maxTokens,
      temperature,
      model,
    } = options;

    if (isPrivate && config.provider === 'cloud' && !config.allowCloudLlm) {
      throw new PrivateDataCloudError(moduleName, operation);
    }

    if (typeof provider.chat !== 'function') {
      throw new Error('Configured LLM provider does not support multi-turn chat');
    }

    const correlationId = randomUUID();

    const response = await provider.chat({
      messages,
      maxTokens,
      temperature,
      model,
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

  /**
   * Streaming versión de `chat`. Devuelve un async generator que yield chunks
   * de texto a medida que el modelo los emite. Si el provider no soporta
   * streaming (no implementa `chatStream`), hace fallback: ejecuta `chat()`
   * y emite el texto completo en un único yield al final — el caller tiene
   * un contrato consistente.
   *
   * @param {Array<{ role: 'system'|'user'|'assistant', content: string }>} messages
   * @param {{ module?: string, operation?: string, private?: boolean, maxTokens?: number, temperature?: number, model?: string, signal?: AbortSignal }} [options]
   * @returns {AsyncGenerator<string, void, void>}
   */
  async function* chatStream(messages, options = {}) {
    const {
      module: moduleName = 'unknown',
      operation = 'chat-stream',
      private: isPrivate = true,
      maxTokens,
      temperature,
      model,
      signal,
    } = options;

    if (isPrivate && config.provider === 'cloud' && !config.allowCloudLlm) {
      throw new PrivateDataCloudError(moduleName, operation);
    }

    const correlationId = randomUUID();
    const metadata = {
      module: moduleName,
      operation,
      correlationId,
      timestamp: new Date().toISOString(),
    };

    if (typeof provider.chatStream === 'function') {
      yield* provider.chatStream({ messages, maxTokens, temperature, model, metadata, signal });
      return;
    }

    // Fallback: si el provider no streama, llama a chat() y devuelve todo de golpe.
    if (typeof provider.chat !== 'function') {
      throw new Error('Configured LLM provider supports neither chat nor chatStream');
    }
    const response = await provider.chat({ messages, maxTokens, temperature, model, metadata });
    if (response?.text) yield response.text;
  }

  return { generateText, chat, chatStream, checkHealth };
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
 * @property {(messages: Array<{ role: string, content: string }>, options?: object) => Promise<string>} chat
 * @property {(messages: Array<{ role: string, content: string }>, options?: object) => AsyncGenerator<string, void, void>} chatStream
 * @property {() => Promise<import('../../../types/llm.js').LlmHealthStatus>} checkHealth
 */
