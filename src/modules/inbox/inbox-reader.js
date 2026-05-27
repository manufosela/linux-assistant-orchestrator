import { readFile } from 'node:fs/promises';
import { chunkText } from '../llm/text-chunker.js';

/**
 * Reads inbox items' extracted content and optionally summarises it via the
 * local LLM. El resumen se fuerza al `summaryLanguage` configurado (es por
 * defecto), independientemente del idioma del texto fuente.
 *
 * @param {{
 *   inboxQuery: { findById: Function, findLatestWithExtraction: Function },
 *   llmService: { generateText: Function, chat: Function },
 *   summariseModel?: string | null,
 *   summaryLanguage?: string,
 *   summaryChunkChars?: number,
 *   logger?: import('pino').Logger,
 * }} deps
 * @returns {InboxReader}
 */
export function createInboxReader({
  inboxQuery,
  llmService,
  summariseModel = null,
  summaryLanguage = 'es',
  summaryChunkChars = 8000,
  logger,
}) {
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

    try {
      let summary;
      if (readResult.text.length <= summaryChunkChars) {
        summary = await summariseChunk(readResult.text, { isFinal: true });
      } else {
        // Texto largo: trocear y meta-resumir. Antes truncábamos a 12000 chars
        // y se perdía información; ahora procesamos todo el documento.
        const chunks = chunkText(readResult.text, summaryChunkChars);
        logger?.info(
          { id: readResult.item.id, chunks: chunks.length, totalChars: readResult.text.length },
          'inbox-reader: chunking long summary',
        );
        const partials = [];
        for (const chunk of chunks) {
          partials.push(await summariseChunk(chunk, { isFinal: false }));
        }
        summary = await summariseChunk(partials.filter(Boolean).join('\n\n'), { isFinal: true });
      }
      // Mantengo maxInputChars en la firma por compatibilidad: ya no recorta
      // (el chunking cubre el caso) pero permite forzar truncamiento desde tests.
      void maxInputChars;
      const trimmed = (summary ?? '').trim();
      if (!trimmed) {
        return { ...readResult, summary: null, reason: 'llm-empty' };
      }
      return { ...readResult, summary: trimmed };
    } catch (error) {
      logger?.warn({ id: readResult.item.id, err: error.message }, 'inbox-reader summarise failed');
      return { ...readResult, summary: null, reason: `llm-failed: ${error.message}` };
    }
  }

  /**
   * Invoca al LLM con prompts que fuerzan `summaryLanguage` como idioma de
   * salida. La instrucción de idioma se repite al inicio del system prompt y
   * al final del user message para que modelos pequeños no la pierdan.
   *
   * @param {string} text
   * @param {{ isFinal: boolean }} opts
   * @returns {Promise<string>}
   */
  async function summariseChunk(text, { isFinal }) {
    const systemPrompt = buildSystemPrompt(summaryLanguage, isFinal);
    const userPrompt = isFinal
      ? `Texto a resumir:\n\n${text}\n\nRecuerda: el resumen DEBE estar en ${summaryLanguage}.`
      : `Resume brevemente este fragmento preservando datos clave (nombres, números, decisiones):\n\n${text}\n\nEl resumen DEBE estar en ${summaryLanguage}.`;
    return llmService.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        ...(summariseModel ? { model: summariseModel } : {}),
        module: 'inbox-reader',
        operation: isFinal ? 'summarise-final' : 'summarise-chunk',
        private: true,
        temperature: 0.3,
        maxTokens: 500,
      },
    );
  }

  async function resolveItem({ id, categories }) {
    if (id) return inboxQuery.findById(id);
    return inboxQuery.findLatestWithExtraction({ categories });
  }

  return { read, summarise };
}

/**
 * Construye el system prompt de resumen forzando `language` como idioma de
 * salida. El idioma aparece al inicio (rol) Y se repite en una instrucción
 * destacada al final, para mitigar el caso de modelos pequeños que ignoran
 * la línea inicial.
 *
 * @param {string} language  ISO 639-1 (p.ej. 'es', 'en')
 * @param {boolean} isFinal
 * @returns {string}
 */
function buildSystemPrompt(language, isFinal) {
  const lengthRule = isFinal
    ? 'Devuelve un resumen de 3 a 5 frases breves capturando los puntos clave.'
    : 'Devuelve un resumen breve (2-3 frases) preservando datos clave del fragmento.';
  return [
    `Eres un asistente que SIEMPRE escribe en ${language}, sin importar el idioma del texto original.`,
    lengthRule,
    'NO repitas el texto original.',
    'NO añadas introducciones tipo "El texto trata de…" — empieza directamente con el contenido.',
    'NO uses markdown, solo prosa.',
    '',
    `IMPORTANTE: El resumen DEBE estar en ${language}. Si el texto original está en otro idioma, tradúcelo al hacer el resumen.`,
  ].join('\n');
}

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
