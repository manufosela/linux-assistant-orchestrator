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

  // Accept both forms of baseUrl:
  //   "http://host:port"        — server root, paths below use /v1/...
  //   "http://host:port/v1"     — already includes the OpenAI prefix; strip it
  // OpenAI's own convention is the second form; users coming from there expect /v1 in the URL.
  // Internally we always speak server-root + /v1/... so the http client is consistent.
  const baseUrl = String(config.baseUrl ?? '').replace(/\/+v1\/?$/, '').replace(/\/$/, '');

  const httpClient = createHttpClient({
    baseUrl,
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
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });
    return chat({ messages, maxTokens, temperature, metadata, model: config.model });
  }

  /**
   * Chat-style call: takes a full messages array (system + user/assistant turns) and returns
   * the model's next reply. Used for multi-turn conversations and slash commands.
   *
   * @param {{
   *   messages: Array<{ role: 'system'|'user'|'assistant', content: string }>,
   *   maxTokens?: number,
   *   temperature?: number,
   *   model?: string,
   *   metadata: import('../../../types/llm.js').LlmRequestMetadata,
   * }} request
   * @returns {Promise<import('../../../types/llm.js').LlmPromptResponse>}
   */
  async function chat(request) {
    const { messages, maxTokens = 1024, temperature = 0.7, metadata } = request;
    const model = request.model ?? config.model;

    const promptLength = messages.reduce((acc, m) => acc + (m?.content?.length ?? 0), 0);
    logger.info(
      {
        module: metadata.module,
        operation: metadata.operation,
        provider: 'local',
        model,
        turns: messages.length,
        promptLength,
        correlationId: metadata.correlationId,
        timestamp: new Date().toISOString(),
      },
      'LLM chat request'
    );

    const requestBody = {
      model,
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
      model: response.model ?? model,
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

  /**
   * Streaming variante de `chat`. Async generator que emite chunks de texto
   * (deltas) tal cual los devuelve el endpoint OpenAI-compatible con
   * `stream: true`. NO aplica privacy guards: el caller (llm-service) ya las
   * comprueba antes de invocarnos.
   *
   * @param {{
   *   messages: Array<{ role: 'system'|'user'|'assistant', content: string }>,
   *   maxTokens?: number,
   *   temperature?: number,
   *   model?: string,
   *   metadata: import('../../../types/llm.js').LlmRequestMetadata,
   *   signal?: AbortSignal,
   * }} request
   * @returns {AsyncGenerator<string, void, void>}
   */
  async function* chatStream(request) {
    const { messages, maxTokens = 1024, temperature = 0.7, metadata, signal } = request;
    const model = request.model ?? config.model;

    logger.info(
      {
        module: metadata.module,
        operation: metadata.operation,
        provider: 'local',
        model,
        turns: messages.length,
        streaming: true,
      },
      'LLM chat stream request',
    );

    const requestBody = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    };

    const url = `${baseUrl}/v1/chat/completions`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok || !response.body) {
      const detail = await safeReadText(response);
      throw new Error(`LLM stream HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIndex;
        while ((nlIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nlIndex).trim();
          buffer = buffer.slice(nlIndex + 1);
          if (!line || !line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              yield delta;
            }
          } catch (error) {
            logger.debug({ err: error?.message, payload: payload.slice(0, 80) }, 'stream chunk parse failed');
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  }

  return { generateText, chat, chatStream, checkHealth };
}

/**
 * @param {Response} response
 */
async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * @typedef {Object} OpenAiCompatibleResponse
 * @property {string} model
 * @property {Array<{ message: { content: string } }>} choices
 * @property {{ prompt_tokens: number, completion_tokens: number }} [usage]
 */
