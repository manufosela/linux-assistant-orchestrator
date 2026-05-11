/**
 * Registers HTTP route handlers on the supplied registry.
 *
 * Handlers are pure: they receive parsed dependencies plus the parsed request body and return a
 * {@link RouteResponse}. The web app composition root is responsible for serialisation, status
 * codes and authentication. This separation keeps handlers easy to unit-test in isolation.
 *
 * @param {{
 *   registry: WebRouteRegistry,
 *   llmService: import('../../modules/llm/llm-service.js').LlmService,
 *   statusService: import('../../modules/assistant/assistant-status-service.js').AssistantStatusService,
 *   rulesRepository: import('../../modules/downloads/download-rules-repository.js').DownloadRulesRepository,
 *   urlFetcher?: import('../../modules/web/url-fetcher.js').UrlFetcher,
 *   webSearch?: import('../../modules/web/web-search.js').WebSearchService,
 *   homeAssistant?: import('../../modules/home-assistant/ha-client.js').HomeAssistantClient,
 *   logger: import('pino').Logger,
 * }} deps
 */
export function registerWebRoutes({ registry, llmService, statusService, rulesRepository, urlFetcher, webSearch, homeAssistant, logger }) {
  registry.register('GET', '/api/status', async () => {
    const status = statusService.getStatus();
    return { status: 200, body: status };
  });

  registry.register('GET', '/api/llm/status', async () => {
    const health = await llmService.checkHealth();
    return { status: health.healthy ? 200 : 503, body: health };
  });

  registry.register('POST', '/api/ask', async (_req, body) => {
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return { status: 400, body: { error: 'Missing prompt' } };
    }
    try {
      const text = await llmService.generateText(prompt, {
        module: 'web',
        operation: 'ask',
        private: true,
      });
      return { status: 200, body: { text } };
    } catch (error) {
      const message = error?.message ?? 'LLM error';
      logger.warn({ err: message }, '/api/ask failed');
      return { status: 502, body: { error: 'LLM provider error', detail: message } };
    }
  });

  registry.register('POST', '/api/chat', async (_req, body) => {
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages || messages.length === 0) {
      return { status: 400, body: { error: 'Missing messages' } };
    }
    if (!messages.every(isValidMessage)) {
      return { status: 400, body: { error: 'Invalid message format' } };
    }
    try {
      const text = await llmService.chat(messages, {
        module: 'web',
        operation: 'chat',
        private: true,
        model: typeof body?.model === 'string' && body.model ? body.model : undefined,
      });
      return { status: 200, body: { text } };
    } catch (error) {
      const message = error?.message ?? 'LLM error';
      logger.warn({ err: message }, '/api/chat failed');
      return { status: 502, body: { error: 'LLM provider error', detail: message } };
    }
  });

  registry.register('POST', '/api/fetch', async (_req, body) => {
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!url) {
      return { status: 400, body: { error: 'Missing url' } };
    }
    if (!urlFetcher) {
      return { status: 503, body: { error: 'URL fetcher is not configured' } };
    }
    try {
      const result = await urlFetcher.fetchUrl(url);
      return { status: 200, body: result };
    } catch (error) {
      const message = error?.message ?? 'fetch error';
      logger.warn({ err: message, url }, '/api/fetch failed');
      return { status: 502, body: { error: 'Fetch failed', detail: message } };
    }
  });

  registry.register('POST', '/api/search', async (_req, body) => {
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    if (!query) {
      return { status: 400, body: { error: 'Missing query' } };
    }
    if (!webSearch) {
      return { status: 503, body: { error: 'Web search is not configured' } };
    }
    try {
      const maxResults = Number.isFinite(body?.maxResults) ? Number(body.maxResults) : undefined;
      const results = await webSearch.search(query, maxResults ? { maxResults } : undefined);
      return { status: 200, body: { results } };
    } catch (error) {
      const message = error?.message ?? 'search error';
      logger.warn({ err: message, query }, '/api/search failed');
      return { status: 502, body: { error: 'Search failed', detail: message } };
    }
  });

  registry.register('POST', '/api/ha', async (_req, body) => {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      return { status: 400, body: { error: 'Missing text' } };
    }
    if (!homeAssistant) {
      return { status: 503, body: { error: 'Home Assistant is not configured' } };
    }
    try {
      const conversationId = typeof body?.conversationId === 'string' && body.conversationId
        ? body.conversationId
        : undefined;
      const result = await homeAssistant.processConversation(text, { conversationId });
      return {
        status: 200,
        body: {
          speech: result.speech,
          responseType: result.responseType,
          errorCode: result.errorCode,
          conversationId: result.conversationId,
        },
      };
    } catch (error) {
      const message = error?.message ?? 'home assistant error';
      logger.warn({ err: message, text }, '/api/ha failed');
      return { status: 502, body: { error: 'Home Assistant error', detail: message } };
    }
  });

  registry.register('GET', '/api/downloads/rules', async () => {
    const rules = await rulesRepository.loadRules();
    return { status: 200, body: { rules } };
  });

  registry.register('POST', '/api/downloads/organize', async () => {
    logger.info({ command: 'downloads.organize' }, 'Downloads organize requested via web');
    return {
      status: 200,
      body: {
        ok: false,
        placeholder: true,
        message: 'Downloads organizer service is not wired to the web API yet.',
      },
    };
  });
}

/**
 * Validates that a message has the expected chat-message shape.
 *
 * @param {unknown} msg
 * @returns {boolean}
 */
function isValidMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const role = /** @type {{role?: unknown}} */ (msg).role;
  const content = /** @type {{content?: unknown}} */ (msg).content;
  return (
    (role === 'system' || role === 'user' || role === 'assistant') &&
    typeof content === 'string'
  );
}

/**
 * @typedef {Object} RouteResponse
 * @property {number} status
 * @property {object | string} body
 */

/**
 * @callback WebRouteHandler
 * @param {import('node:http').IncomingMessage} req
 * @param {any} body - parsed JSON body, undefined for GET requests
 * @returns {Promise<RouteResponse>}
 */

/**
 * @typedef {Object} WebRouteRegistry
 * @property {(method: string, path: string, handler: WebRouteHandler) => void} register
 */
