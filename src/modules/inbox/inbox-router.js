/**
 * Inbox router — classifies items captured in the inbox into one of a closed
 * set of categories using the local LLM (with deterministic hard rules first).
 *
 * The router does NOT execute actions. Acting on the category is the job of
 * the inbox actions module (TSK-0044). Keeping classification and action
 * separate lets us swap models without touching the side-effecting code, and
 * lets us re-classify items later if needed.
 *
 * Hard rules:
 *   - voice / audio → 'voz' (always; they need transcription, never anything else)
 *   - photo without caption → 'foto' (the LLM cannot see the image; metadata only)
 *
 * Anything else goes to the LLM, which returns one of the categories below
 * plus a confidence in [0, 1]. If confidence is below the threshold, or the
 * response is unparseable / has an unknown category, we return 'revisar'
 * instead — the item stays as pending and the user is asked to decide.
 *
 * Categories (Spanish, matching the project domain):
 *   - idea       — observación o pensamiento sin acción concreta
 *   - tarea      — acción a ejecutar (verbo en imperativo o forma similar)
 *   - documento  — fichero formal a conservar (factura, contrato, etc.)
 *   - estudio    — material de lectura/aprendizaje (artículo, capítulo, paper)
 *   - foto       — imagen sin contexto destacable
 *   - voz        — nota de voz que debe transcribirse
 *   - descartar  — duplicado, test, contenido sin valor
 *
 * Fallback:
 *   - revisar    — el clasificador no está seguro; el item queda pendiente
 *                  de decisión humana
 */

const CATEGORIES = Object.freeze([
  'idea',
  'tarea',
  'documento',
  'estudio',
  'foto',
  'voz',
  'descartar',
]);

const NEEDS_REVIEW = 'revisar';

const SYSTEM_PROMPT = [
  'Eres un clasificador de items capturados en el inbox personal de un usuario.',
  'Tu única tarea es elegir UNA categoría entre las siguientes y devolverla como JSON.',
  '',
  'Categorías:',
  '- idea: pensamiento suelto, observación, recordatorio sin acción clara',
  '- tarea: acción concreta que el usuario quiere hacer (comprar, llamar, arreglar, revisar...)',
  '- documento: fichero formal a conservar (factura, informe, contrato, libro PDF)',
  '- estudio: material de lectura o aprendizaje (artículo, capítulo, paper)',
  '- foto: imagen sin texto relevante asociado',
  '- voz: nota de voz que debe transcribirse',
  '- descartar: duplicado, test, contenido sin valor',
  '',
  'Reglas:',
  '- Si el texto suena a acción ("comprar X", "llamar a Y"), elige tarea.',
  '- Si es una observación o idea libre, elige idea.',
  '- Un PDF adjunto va a documento o estudio según el contenido.',
  '- Foto sin caption → foto. Foto con caption descriptiva → clasifica por la caption.',
  '- Audio o nota de voz → voz SIEMPRE.',
  '- Si dudas, baja la confidence.',
  '',
  'Devuelve SOLO un objeto JSON, sin texto adicional ni comentarios:',
  '{"category":"<categoria>","confidence":<0.0-1.0>,"reasoning":"<breve>"}',
].join('\n');

/**
 * Creates an inbox router. The router classifies items using a mix of hard
 * rules and the local LLM.
 *
 * @param {{
 *   llmService: { generateText: (prompt: string, options?: object) => Promise<string> },
 *   logger?: import('pino').Logger,
 *   confidenceThreshold?: number,
 * }} deps
 * @returns {InboxRouter}
 */
export function createInboxRouter({ llmService, logger, confidenceThreshold = 0.6 }) {
  if (!llmService) throw new Error('createInboxRouter requires llmService');

  /**
   * Classifies a single inbox item. Never throws — on LLM error or unparseable
   * response, returns category 'revisar' with reasoning.
   *
   * @param {InboxItemInput} item
   * @returns {Promise<InboxClassification>}
   */
  async function classify(item) {
    const hard = hardClassify(item);
    if (hard) {
      return { category: hard, confidence: 1, reasoning: 'hard-rule' };
    }
    return llmClassify(item);
  }

  async function llmClassify(item) {
    const userPrompt = buildUserPrompt(item);
    let raw;
    try {
      raw = await llmService.generateText(userPrompt, {
        systemPrompt: SYSTEM_PROMPT,
        module: 'inbox-router',
        operation: 'classify',
        private: true,
        temperature: 0,
        maxTokens: 200,
      });
    } catch (error) {
      logger?.warn({ err: error.message }, 'inbox-router LLM error');
      return { category: NEEDS_REVIEW, confidence: 0, reasoning: `LLM error: ${error.message}` };
    }

    const parsed = parseLlmResponse(raw);
    if (!parsed) {
      logger?.warn({ raw }, 'inbox-router could not parse LLM response');
      return { category: NEEDS_REVIEW, confidence: 0, reasoning: 'unparseable LLM response' };
    }
    if (!CATEGORIES.includes(parsed.category)) {
      logger?.warn({ parsed }, 'inbox-router LLM returned unknown category');
      return { category: NEEDS_REVIEW, confidence: 0, reasoning: `unknown category: ${parsed.category}` };
    }
    if (parsed.confidence < confidenceThreshold) {
      return { ...parsed, category: NEEDS_REVIEW };
    }
    return parsed;
  }

  return { classify };
}

function hardClassify(item) {
  const kind = item?.origin?.kind;
  if (kind === 'voice' || kind === 'audio') return 'voz';
  if (kind === 'photo' && !item?.textCaption?.trim()) return 'foto';
  return null;
}

function buildUserPrompt(item) {
  const lines = ['Clasifica este item del inbox:'];
  lines.push(`- kind: ${item?.origin?.kind ?? 'unknown'}`);
  lines.push(`- mimeType: ${item?.mimeType ?? 'unknown'}`);
  lines.push(`- fileName: ${item?.fileName ?? '(sin fichero)'}`);
  lines.push(`- textCaption: ${item?.textCaption ?? '(sin texto)'}`);
  return lines.join('\n');
}

function parseLlmResponse(raw) {
  if (typeof raw !== 'string') return null;
  // Local LLMs sometimes wrap JSON in prose or code fences. Extract the first
  // balanced {...} block we find.
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (typeof obj.category !== 'string') return null;
    const confidence = typeof obj.confidence === 'number' ? obj.confidence : 0;
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
    return { category: obj.category.toLowerCase().trim(), confidence, reasoning };
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} InboxItemInput
 * @property {{ kind?: string }} [origin]
 * @property {string} [mimeType]
 * @property {string} [fileName]
 * @property {string} [textCaption]
 */

/**
 * @typedef {Object} InboxClassification
 * @property {string} category
 * @property {number} confidence
 * @property {string} reasoning
 */

/**
 * @typedef {Object} InboxRouter
 * @property {(item: InboxItemInput) => Promise<InboxClassification>} classify
 */
