import { readFile } from 'node:fs/promises';

/**
 * Reads inbox items' extracted content and optionally summarises it via the
 * local LLM.
 *
 * @param {{
 *   inboxQuery: { findById: Function, findLatestWithExtraction: Function },
 *   llmService: { generateText: Function },
 *   logger?: import('pino').Logger,
 * }} deps
 * @returns {InboxReader}
 */
export function createInboxReader({ inboxQuery, llmService, logger }) {
  if (!inboxQuery) throw new Error('createInboxReader requires inboxQuery');
  if (!llmService) throw new Error('createInboxReader requires llmService');

  /**
   * Reads the extracted.md of an item. Resolves the item by id or category
   * (most recent with extraction).
   *
   * @param {{ id?: string | null, categories?: string[] | null }} [options]
   * @returns {Promise<ReadResult>}
   */
  async function read({ id = null, categories = null } = {}) {
    const item = await resolveItem({ id, categories });
    if (!item) return { item: null, text: null, reason: 'no-item' };
    const extractedPath = item.meta.extraction?.path;
    if (!extractedPath) return { item, text: null, reason: 'no-extraction' };
    try {
      const text = await readFile(extractedPath, 'utf8');
      return { item, text, reason: null };
    } catch (error) {
      logger?.warn({ id: item.id, err: error.message }, 'inbox-reader read failed');
      return { item, text: null, reason: `read-failed: ${error.message}` };
    }
  }

  /**
   * Summarises an item via the local LLM. Same resolution rules as read().
   *
   * @param {{ id?: string | null, categories?: string[] | null, maxInputChars?: number }} [options]
   * @returns {Promise<SummariseResult>}
   */
  async function summarise({ id = null, categories = null, maxInputChars = 12000 } = {}) {
    const readResult = await read({ id, categories });
    if (!readResult.text) return { ...readResult, summary: null };

    // Trim input to fit the local LLM's context. Local "fast" model has ~8k
    // tokens; ~12000 chars ≈ ~3000 tokens — leaves room for the prompt + reply.
    const input = readResult.text.slice(0, maxInputChars);
    try {
      const summary = await llmService.generateText(
        `Texto a resumir:\n\n${input}`,
        {
          systemPrompt: SUMMARISE_SYSTEM_PROMPT,
          module: 'inbox-reader',
          operation: 'summarise',
          private: true,
          temperature: 0.3,
          maxTokens: 500,
        },
      );
      return { ...readResult, summary: summary.trim() };
    } catch (error) {
      logger?.warn({ id: readResult.item.id, err: error.message }, 'inbox-reader summarise failed');
      return { ...readResult, summary: null, reason: `llm-failed: ${error.message}` };
    }
  }

  async function resolveItem({ id, categories }) {
    if (id) return inboxQuery.findById(id);
    return inboxQuery.findLatestWithExtraction({ categories });
  }

  return { read, summarise };
}

const SUMMARISE_SYSTEM_PROMPT = [
  'Eres un asistente que resume textos en español.',
  'Devuelve un resumen de 3 a 5 frases breves capturando los puntos clave.',
  'NO repitas el texto original.',
  'NO añadas introducciones tipo "El texto trata de…" — empieza directamente con el contenido.',
  'NO uses markdown, solo prosa.',
].join('\n');

/**
 * @typedef {Object} ReadResult
 * @property {{ id: string, dir: string, meta: object } | null} item
 * @property {string | null} text
 * @property {string | null} reason   'no-item' | 'no-extraction' | error message
 */

/**
 * @typedef {Object} SummariseResult
 * @property {{ id: string, dir: string, meta: object } | null} item
 * @property {string | null} text
 * @property {string | null} summary
 * @property {string | null} reason
 */

/**
 * @typedef {Object} InboxReader
 * @property {(options?: object) => Promise<ReadResult>} read
 * @property {(options?: object) => Promise<SummariseResult>} summarise
 */
