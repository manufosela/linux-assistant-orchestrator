import { formatWatchtowerNotification } from '../../modules/watchtower/watchtower-formatter.js';
import { formatAptHealthNotification } from '../../modules/apt-health/apt-health-formatter.js';
import { parsePrometheusIntent } from '../../modules/prometheus/prometheus-intent.js';
import { formatDownReport } from '../../modules/prometheus/prometheus-formatter.js';

/**
 * In-memory dedup store for apt-health events. Key = `${host}:${event}:${day}`,
 * value = expiration timestamp (epoch ms). Lazy GC: stale entries removed on
 * each insert. Deliberately not persisted: if the container restarts the worst
 * case is a duplicate notification, which is acceptable for this volume.
 */
const aptHealthSeen = new Map();
const APT_HEALTH_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

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
 *   notificationService?: import('../../modules/notifications/notification-service.js').NotificationService,
 *   prometheusClient?: import('../../modules/prometheus/prometheus-client.js').PrometheusClient,
 *   watchtowerWebhookToken?: string,
 *   aptHealthWebhookToken?: string,
 *   logger: import('pino').Logger,
 *   now?: () => number,
 * }} deps
 */
export function registerWebRoutes({ registry, llmService, statusService, rulesRepository, urlFetcher, webSearch, homeAssistant, notificationService, prometheusClient, watchtowerWebhookToken, aptHealthWebhookToken, logger, now = Date.now }) {
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
    const prometheusReply = await maybeAnswerFromPrometheus(prompt, prometheusClient, logger);
    if (prometheusReply) return prometheusReply;
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

  registry.registerStream('POST', '/api/ask', async (req, res, body) => {
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      writeSseHead(res);
      writeSseError(res, 'Missing prompt');
      res.end();
      return;
    }
    // Prometheus shortcut también vale en streaming: lo emitimos como un único
    // delta y cerramos, así el cliente no nota diferencia con un stream real.
    const prometheusReply = await maybeAnswerFromPrometheus(prompt, prometheusClient, logger);
    if (prometheusReply) {
      writeSseHead(res);
      writeSseDelta(res, prometheusReply.body?.text ?? '');
      writeSseDone(res);
      res.end();
      return;
    }
    await streamAndEmit({
      res,
      messages: [{ role: 'user', content: prompt }],
      options: { module: 'web', operation: 'ask-stream', private: true },
      llmService,
      req,
      logger,
    });
  });

  registry.registerStream('POST', '/api/chat', async (req, res, body) => {
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages || messages.length === 0 || !messages.every(isValidMessage)) {
      writeSseHead(res);
      writeSseError(res, 'Invalid messages');
      res.end();
      return;
    }
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    const prometheusReply = await maybeAnswerFromPrometheus(lastUserMessage?.content, prometheusClient, logger);
    if (prometheusReply) {
      writeSseHead(res);
      writeSseDelta(res, prometheusReply.body?.text ?? '');
      writeSseDone(res);
      res.end();
      return;
    }
    await streamAndEmit({
      res,
      messages,
      options: {
        module: 'web',
        operation: 'chat-stream',
        private: true,
        model: typeof body?.model === 'string' && body.model ? body.model : undefined,
      },
      llmService,
      req,
      logger,
    });
  });

  registry.register('POST', '/api/chat', async (_req, body) => {
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages || messages.length === 0) {
      return { status: 400, body: { error: 'Missing messages' } };
    }
    if (!messages.every(isValidMessage)) {
      return { status: 400, body: { error: 'Invalid message format' } };
    }
    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const prometheusReply = await maybeAnswerFromPrometheus(lastUserMessage?.content, prometheusClient, logger);
    if (prometheusReply) return prometheusReply;
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

  // Dedicated, machine-readable endpoint for the Prometheus "is anything down?"
  // report — handy for dashboards or scripts that want the structured data.
  registry.register('GET', '/api/prometheus/status', async () => {
    if (!prometheusClient) {
      return { status: 503, body: { error: 'Prometheus integration is not configured' } };
    }
    try {
      const report = await prometheusClient.getDownReport();
      return { status: 200, body: report };
    } catch (error) {
      const message = error?.message ?? 'prometheus error';
      logger.warn({ err: message }, '/api/prometheus/status failed');
      return { status: 502, body: { error: 'Prometheus query failed', detail: message } };
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

  // Inbound webhook for Watchtower (or any updater): receives the report and
  // re-emits it through the shared notification service, formatted like
  // /cluster. Protected by a shared secret (?token= or X-Webhook-Token).
  registry.register('POST', '/api/hooks/watchtower', async (req, body) => {
    if (!watchtowerWebhookToken) {
      return { status: 503, body: { error: 'Watchtower webhook disabled (set WATCHTOWER_WEBHOOK_TOKEN)' } };
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? req.headers['x-webhook-token'];
    if (token !== watchtowerWebhookToken) {
      logger.warn('Watchtower webhook rejected: bad or missing token');
      return { status: 401, body: { error: 'unauthorized' } };
    }
    if (!notificationService) {
      return { status: 503, body: { error: 'Notifications not configured' } };
    }
    try {
      const { text, level } = formatWatchtowerNotification(body);
      await notificationService.sendNotification({ text, level });
      logger.info({ level }, 'Watchtower notification relayed');
      return { status: 200, body: { ok: true } };
    } catch (error) {
      const message = error?.message ?? 'watchtower webhook error';
      logger.warn({ err: message }, '/api/hooks/watchtower failed');
      return { status: 502, body: { error: 'Relay failed', detail: message } };
    }
  });

  // POST /api/hooks/apt-health — endpoint para que cada host de la red avise
  // cuando unattended-upgrade falla, hay pendientes acumulados o reboot
  // pendiente. Auth por Bearer token (también acepta ?token= por compatibilidad
  // con curl simple desde scripts). Dedup en memoria por (host+event+día)
  // para no repetir la misma alerta dentro de 24h.
  registry.register('POST', '/api/hooks/apt-health', async (req, body) => {
    if (!aptHealthWebhookToken) {
      return { status: 503, body: { error: 'apt-health webhook disabled (set APT_HEALTH_WEBHOOK_TOKEN)' } };
    }
    const token = extractBearerToken(req) ?? new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
    if (token !== aptHealthWebhookToken) {
      logger.warn('apt-health webhook rejected: bad or missing token');
      return { status: 401, body: { error: 'unauthorized' } };
    }
    if (!notificationService) {
      return { status: 503, body: { error: 'Notifications not configured' } };
    }
    const payload = body && typeof body === 'object' ? body : {};
    const host = typeof payload.host === 'string' && payload.host ? payload.host : 'desconocido';
    const event = typeof payload.event === 'string' && payload.event ? payload.event : 'unknown';
    const day = typeof payload.day === 'string' && payload.day ? payload.day : new Date(now()).toISOString().slice(0, 10);
    const dedupKey = `${host}:${event}:${day}`;
    gcAptHealthSeen(now());
    if (aptHealthSeen.has(dedupKey)) {
      logger.debug({ dedupKey }, 'apt-health notification deduplicated');
      return { status: 200, body: { ok: true, deduplicated: true } };
    }
    try {
      const { text, level } = formatAptHealthNotification(payload);
      await notificationService.sendNotification({ text, level });
      aptHealthSeen.set(dedupKey, now() + APT_HEALTH_DEDUP_TTL_MS);
      logger.info({ host, event, day }, 'apt-health notification relayed');
      return { status: 200, body: { ok: true } };
    } catch (error) {
      const message = error?.message ?? 'apt-health webhook error';
      logger.warn({ err: message }, '/api/hooks/apt-health failed');
      return { status: 502, body: { error: 'Relay failed', detail: message } };
    }
  });
}

/**
 * Extrae el token de un header `Authorization: Bearer <token>`.
 * Devuelve `null` si no hay header o no es Bearer.
 *
 * @param {{ headers?: Record<string, string|undefined> }} req
 * @returns {string|null}
 */
function extractBearerToken(req) {
  const auth = req.headers?.authorization ?? req.headers?.Authorization;
  if (typeof auth !== 'string') return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Borra entradas expiradas del Map de dedup. Llamado lazy desde el handler.
 *
 * @param {number} now
 */
function gcAptHealthSeen(now) {
  for (const [key, exp] of aptHealthSeen) {
    if (exp <= now) aptHealthSeen.delete(key);
  }
}

/**
 * TEST-ONLY: limpia el estado de dedup para que los tests partan de cero.
 * @internal
 */
export function _resetAptHealthDedup() {
  aptHealthSeen.clear();
}

/**
 * When the user's text is a natural-language "is anything down?" query, answers
 * it from Prometheus instead of the LLM. Returns a {@link RouteResponse} when it
 * handled the request, or `null` so the caller falls back to the LLM.
 *
 * Prometheus errors are returned as a normal `200 { text }` reply so the chat UI
 * shows them inline, exactly like a regular assistant answer.
 *
 * @param {unknown} text
 * @param {import('../../modules/prometheus/prometheus-client.js').PrometheusClient} [prometheusClient]
 * @param {import('pino').Logger} logger
 * @returns {Promise<RouteResponse | null>}
 */
async function maybeAnswerFromPrometheus(text, prometheusClient, logger) {
  if (!prometheusClient || typeof text !== 'string' || !parsePrometheusIntent(text)) {
    return null;
  }
  try {
    const report = await prometheusClient.getDownReport();
    return { status: 200, body: { text: formatDownReport(report).text } };
  } catch (error) {
    const message = error?.message ?? 'prometheus error';
    logger.warn({ err: message }, 'Prometheus intent query failed');
    return { status: 200, body: { text: `No pude consultar Prometheus: ${message}` } };
  }
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
 * Streams chunks from llmService.chatStream as SSE events to the open `res`.
 * Handles client aborts (req close) and propagation of stream errors. The
 * client will see one `event: error` followed by the connection closing.
 */
async function streamAndEmit({ res, messages, options, llmService, req, logger }) {
  writeSseHead(res);
  // Heartbeat: SSE proxies pueden cerrar sockets ociosos. Un comment cada
  // 15 s mantiene la conexión viva incluso si el modelo está pensando.
  const heartbeat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch { /* socket muerto */ }
  }, 15_000);

  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.on('close', onClose);

  try {
    for await (const chunk of llmService.chatStream(messages, { ...options, signal: ac.signal })) {
      if (ac.signal.aborted) break;
      writeSseDelta(res, chunk);
    }
    if (!ac.signal.aborted) writeSseDone(res);
  } catch (error) {
    logger?.warn({ err: error?.message }, 'LLM stream failed');
    writeSseError(res, error?.message ?? 'LLM stream error');
  } finally {
    clearInterval(heartbeat);
    req.off('close', onClose);
    try { res.end(); } catch { /* ignore */ }
  }
}

function writeSseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // disable nginx/proxy buffering
  });
}

function writeSseDelta(res, text) {
  res.write(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`);
}

function writeSseDone(res) {
  res.write('event: done\ndata: {}\n\n');
}

function writeSseError(res, message) {
  res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
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
 * @property {(method: string, path: string, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: any) => Promise<void>) => void} registerStream
 */
