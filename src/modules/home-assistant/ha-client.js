/**
 * Creates a Home Assistant client backed by HA's REST + Conversation APIs.
 *
 * Authenticates with a long-lived access token. Pure forwarder: the natural-language input
 * is sent verbatim to HA's `conversation/process` endpoint and the spoken reply is returned.
 * HA itself decides which entities to act on based on what is exposed to its Assist agent.
 *
 * @param {{
 *   baseUrl: string,
 *   token: string,
 *   logger: import('pino').Logger,
 *   timeoutMs?: number,
 *   language?: string,
 *   agentId?: string,
 * }} deps
 * @returns {HomeAssistantClient}
 */
export function createHomeAssistantClient({ baseUrl, token, logger, timeoutMs = 60_000, language = 'es', agentId = '' }) {
  const normalisedBase = String(baseUrl ?? '').replace(/\/+$/, '');
  const defaultAgentId = String(agentId ?? '').trim();

  /**
   * Sends a natural-language sentence to HA's conversation agent.
   * Returns the human-readable reply that HA wants spoken back to the user, plus the raw
   * intent/error code so callers can react when HA was unable to act.
   *
   * @param {string} text
   * @param {{ conversationId?: string, agentId?: string }} [options]
   * @returns {Promise<HomeAssistantConversationResult>}
   */
  async function processConversation(text, options = {}) {
    if (!normalisedBase) throw new Error('Home Assistant base URL is not configured.');
    if (!token) throw new Error('Home Assistant token is not configured.');
    const trimmed = String(text ?? '').trim();
    if (!trimmed) throw new Error('Conversation text is empty.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const body = { text: trimmed, language };
      if (options.conversationId) body.conversation_id = options.conversationId;
      const chosenAgent = options.agentId ?? defaultAgentId;
      if (chosenAgent) body.agent_id = chosenAgent;

      logger?.info(
        { agentId: chosenAgent || '(default)', length: trimmed.length, timeoutMs },
        'HA conversation request: sending',
      );
      const startedAt = Date.now();

      const response = await fetch(`${normalisedBase}/api/conversation/process`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      logger?.info(
        { status: response.status, ms: Date.now() - startedAt },
        'HA conversation request: response headers received',
      );

      if (!response.ok) {
        throw new Error(`Home Assistant returned HTTP ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const speech = data?.response?.speech?.plain?.speech ?? '';
      const responseType = data?.response?.response_type ?? 'unknown';
      const errorCode = data?.response?.data?.code ?? null;
      const conversationId = data?.conversation_id ?? null;

      logger?.info(
        { length: trimmed.length, responseType, errorCode, ms: Date.now() - startedAt },
        'HA conversation processed',
      );

      return { speech, responseType, errorCode, conversationId, raw: data };
    } catch (error) {
      throw wrapNetworkError(error, normalisedBase, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Calls a Home Assistant service (e.g. light.turn_on, switch.turn_off).
   *
   * Used by the fast path to act on devices without going through the LLM-backed conversation
   * agent. Returns the raw HA response (an array of state changes) so callers can confirm.
   *
   * @param {string} domain - service domain, e.g. 'light', 'switch', 'media_player'
   * @param {string} service - service name, e.g. 'turn_on', 'turn_off'
   * @param {object} data - service data, must include entity_id
   * @returns {Promise<unknown>}
   */
  async function callService(domain, service, data) {
    if (!normalisedBase) throw new Error('Home Assistant base URL is not configured.');
    if (!token) throw new Error('Home Assistant token is not configured.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${normalisedBase}/api/services/${domain}/${service}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(data ?? {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Home Assistant returned HTTP ${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      throw wrapNetworkError(error, normalisedBase, 10_000);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Health-checks the HA API root.
   *
   * @returns {Promise<boolean>}
   */
  async function checkHealth() {
    if (!normalisedBase || !token) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`${normalisedBase}/api/`, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        return response.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  return { processConversation, callService, checkHealth };
}

/**
 * Translates low-level fetch / network errors into user-friendly messages so the CLI, web
 * and Telegram frontends can show "Home Assistant no responde" instead of "fetch failed".
 * Already-friendly errors (HTTP 4xx/5xx with a message we built ourselves) pass through.
 *
 * @param {unknown} error
 * @param {string} baseUrl
 * @param {number} timeoutMs
 * @returns {Error}
 */
function wrapNetworkError(error, baseUrl, timeoutMs) {
  if (!(error instanceof Error)) {
    return new Error(`Home Assistant: error desconocido (${String(error)})`);
  }
  if (error.name === 'AbortError') {
    return new Error(
      `Home Assistant no respondió en ${timeoutMs}ms. Causas habituales: agent de conversación colgado (revisa agentId en config), HA cargando, o un automation bloqueante. Ejecuta con CLI_LOG_LEVEL=info para ver el detalle.`,
    );
  }
  // Already a wrapped HTTP / domain error — pass through.
  if (error.message.startsWith('Home Assistant ')) return error;

  const code = /** @type {{ cause?: { code?: string } }} */ (error)?.cause?.code ?? '';
  const host = (() => {
    try { return new URL(baseUrl).host; } catch { return baseUrl; }
  })();

  const friendly = {
    ECONNREFUSED: `Home Assistant no responde en ${host}. Probablemente esté apagado, reiniciándose o el puerto 8123 cerrado.`,
    ENOTFOUND: `No se pudo resolver el host "${host}". Comprueba la URL en la configuración.`,
    EHOSTUNREACH: `${host} no es alcanzable desde aquí (¿LAN caída? ¿VPN?).`,
    ETIMEDOUT: `Home Assistant en ${host} no responde a tiempo.`,
    ECONNRESET: `Home Assistant cerró la conexión a media respuesta.`,
  }[code];

  if (friendly) return new Error(friendly);
  // fetch() en Node tira "fetch failed" cuando hay cualquier problema de red opaco
  if (error.message === 'fetch failed') {
    return new Error(`Home Assistant en ${host} no es alcanzable.`);
  }
  return error;
}

/**
 * @typedef {Object} HomeAssistantConversationResult
 * @property {string} speech - human-readable reply HA wants spoken back
 * @property {string} responseType - 'action_done' | 'query_answer' | 'error' | 'unknown'
 * @property {string | null} errorCode - HA error code when responseType is 'error', else null
 * @property {string | null} conversationId - HA conversation id (use to keep multi-turn context)
 * @property {object} raw - full HA response payload
 */

/**
 * @typedef {Object} HomeAssistantClient
 * @property {(text: string, options?: { conversationId?: string, agentId?: string }) => Promise<HomeAssistantConversationResult>} processConversation
 * @property {(domain: string, service: string, data: object) => Promise<unknown>} callService
 * @property {() => Promise<boolean>} checkHealth
 */
