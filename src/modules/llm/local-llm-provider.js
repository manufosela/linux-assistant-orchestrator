import { createHttpClient } from '../../infrastructure/http/create-http-client.js';

/**
 * Creates a local LLM provider that communicates with an OpenAI-compatible HTTP API.
 * Designed to work with Ollama, llama.cpp server, vLLM, LM Studio, and similar runtimes.
 *
 * @param {import('../../../types/llm.js').LocalLlmConfig} config
 * @param {import('pino').Logger} logger
 * @returns {import('../../../types/llm.js').LlmProvider}
 */
export function createLocalLlmProvider(config, logger) {
  const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};

  const httpClient = createHttpClient({
    baseUrl: config.baseUrl,
    defaultTimeoutMs: config.timeoutMs,
    defaultHeaders: headers,
  });

  /**
   * Generates text using the local LLM endpoint.
   *
   * @param {import('../../../types/llm.js').LlmPromptRequest} request
   * @returns {Promise<import('../../../types/llm.js').LlmPromptResponse>}
   */
  async function generateText(request) {
    const { prompt, systemPrompt, maxTokens = 1024, temperature = 0.7, metadata } = request;

    logger.info(
      {
        module: metadata.module,
        operation: metadata.operation,
        provider: 'local',
        model: config.model,
        promptLength: prompt.length,
        correlationId: metadata.correlationId,
        timestamp: new Date().toISOString(),
      },
      'LLM request'
    );

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const requestBody = {
      model: config.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    };

    const response = /** @type {OpenAiCompatibleResponse} */ (
      await httpClient.post('/v1/chat/completions', requestBody)
    );

    const choice = response.choices?.[0];
    if (!choice) {
      throw new Error('LLM returned no choices in response');
    }

    const text = choice.message?.content ?? '';

    return {
      text,
      model: response.model ?? config.model,
      provider: 'local',
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  }

  /**
   * Checks whether the local LLM endpoint is reachable.
   *
   * @returns {Promise<boolean>}
   */
  async function checkHealth() {
    try {
      await httpClient.get('/v1/models', { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  return { generateText, checkHealth };
}

/**
 * @typedef {Object} OpenAiCompatibleResponse
 * @property {string} model
 * @property {Array<{ message: { content: string } }>} choices
 * @property {{ prompt_tokens: number, completion_tokens: number }} [usage]
 */
