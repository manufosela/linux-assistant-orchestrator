import { tryFastPath } from './ha-fast-path.js';

/**
 * Decorates a {@link import('./ha-client.js').HomeAssistantClient} with a fast path that
 * answers common questions from a local cache instead of calling the LLM agent. Falls back
 * to the underlying client for anything the fast path cannot handle.
 *
 * Exposes the same interface as `ha-client.js` so callers (CLI, web, Telegram) do not need
 * to know about the fast path at all.
 *
 * @param {{
 *   haClient: import('./ha-client.js').HomeAssistantClient,
 *   stateCache?: import('./ha-state-cache.js').HomeAssistantStateCache,
 *   logger?: import('pino').Logger,
 *   houseAverageFilter?: (sensor: object) => boolean,
 * }} deps
 * @returns {import('./ha-client.js').HomeAssistantClient}
 */
export function createSmartHomeAssistantClient({ haClient, stateCache, logger, houseAverageFilter }) {
  /**
   * @param {string} text
   * @param {{ conversationId?: string, agentId?: string }} [options]
   * @returns {Promise<import('./ha-client.js').HomeAssistantConversationResult>}
   */
  async function processConversation(text, options = {}) {
    if (stateCache && stateCache.areaCount > 0) {
      logger?.info({ text: text.slice(0, 80) }, 'HA smart-client: trying fast path');
      try {
        const fast = await tryFastPath({ text, stateCache, haClient, logger, houseAverageFilter });
        if (fast?.handled) {
          logger?.info({ text: text.slice(0, 80) }, 'HA fast path handled query');
          return {
            speech: fast.speech,
            responseType: 'query_answer',
            errorCode: null,
            conversationId: null,
            raw: { fastPath: true },
          };
        }
      } catch (error) {
        logger?.warn({ err: error?.message }, 'HA fast path failed — falling back to LLM');
      }
    } else {
      logger?.info({ areaCount: stateCache?.areaCount ?? 0 }, 'HA smart-client: skipping fast path (cache empty)');
    }
    logger?.info({ text: text.slice(0, 80) }, 'HA smart-client: falling back to HA conversation agent');
    return haClient.processConversation(text, options);
  }

  /**
   * @returns {Promise<boolean>}
   */
  async function checkHealth() {
    return haClient.checkHealth();
  }

  return { processConversation, checkHealth };
}
