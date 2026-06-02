import { google } from 'googleapis';

const MAX_RESULTS_DEFAULT = 25;
const MAX_RESULTS_HARD_CAP = 100;

/**
 * Cliente Gmail acotado a gestión de labels (LUI-TSK-0030). Diseñado bajo la
 * premisa "read + modify, sin delete":
 *
 *  - SÍ: listar labels, crearlas (a petición explícita) y aplicar/quitar
 *    labels en mensajes existentes (`messages.modify`).
 *  - NO: enviar correos, mover a Trash (`messages.trash`), eliminar de Trash,
 *    borrar definitivamente (`messages.delete`), eliminar labels del sistema
 *    (INBOX, UNREAD, SPAM…). Estos métodos no existen en el cliente — la
 *    propia ausencia es la garantía, no un check en runtime.
 *
 * El scope OAuth necesario es `gmail.modify` (configurado en google-auth.js).
 * `gmail.modify` permite a la API hacer trash/delete; el control "no borrado"
 * vive en el código de este módulo, que simplemente no llama a esos métodos.
 *
 * @param {{
 *   googleAuth: import('../google/google-auth.js').GoogleAuth,
 *   llmService?: import('../llm/llm-service.js').LlmService,
 *   logger?: import('pino').Logger,
 *   gmailFactory?: (auth: object) => GmailApi,
 * }} deps
 * @returns {GmailLabelsClient}
 */
export function createGmailLabels({ googleAuth, llmService, logger, gmailFactory }) {
  const createApi = gmailFactory ?? ((auth) => google.gmail({ version: 'v1', auth }));

  async function gmail() {
    const auth = await googleAuth.getClient();
    return createApi(auth);
  }

  /**
   * Lista todas las labels del usuario (sistema + custom).
   *
   * @returns {Promise<Label[]>}
   */
  async function listLabels() {
    const api = await gmail();
    const res = await api.users.labels.list({ userId: 'me' });
    const items = res?.data?.labels ?? [];
    logger?.info({ count: items.length }, 'Gmail listLabels');
    return items.map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type ?? 'user',
    }));
  }

  /**
   * Busca una label por nombre exacto, case-insensitive. Útil para resolver
   * el labelId antes de aplicarla.
   *
   * @param {string} name
   * @returns {Promise<Label | null>}
   */
  async function findLabelByName(name) {
    const target = String(name ?? '').trim().toLowerCase();
    if (!target) return null;
    const labels = await listLabels();
    return labels.find((l) => l.name.toLowerCase() === target) ?? null;
  }

  /**
   * Crea una nueva label. Falla si ya existe. Por defecto la label es
   * visible en la barra lateral y en cada mensaje.
   *
   * @param {{ name: string }} input
   * @returns {Promise<Label>}
   */
  async function createLabel({ name }) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) throw new Error('Indica un nombre de label.');
    const api = await gmail();
    const res = await api.users.labels.create({
      userId: 'me',
      requestBody: {
        name: trimmed,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });
    logger?.info({ name: trimmed, id: res?.data?.id }, 'Gmail createLabel');
    return {
      id: res.data.id,
      name: res.data.name,
      type: res.data.type ?? 'user',
    };
  }

  /**
   * find-or-create: devuelve la label existente o la crea. Idempotente.
   *
   * @param {string} name
   * @returns {Promise<Label>}
   */
  async function ensureLabel(name) {
    const existing = await findLabelByName(name);
    if (existing) return existing;
    return createLabel({ name });
  }

  /**
   * Añade una o varias labels a un mensaje concreto.
   *
   * @param {{ messageId: string, labelIds: string[] }} input
   * @returns {Promise<void>}
   */
  async function addLabels({ messageId, labelIds }) {
    const id = String(messageId ?? '').trim();
    if (!id) throw new Error('Indica el id del mensaje.');
    const ids = (labelIds ?? []).map((x) => String(x).trim()).filter(Boolean);
    if (ids.length === 0) throw new Error('Indica al menos un labelId.');
    const api = await gmail();
    await api.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { addLabelIds: ids },
    });
    logger?.info({ messageId: id, labelIds: ids }, 'Gmail addLabels');
  }

  /**
   * Quita una o varias labels de un mensaje concreto. NO mueve a Trash —
   * sólo desetiqueta. Para "archivar" se quita INBOX explícitamente.
   *
   * @param {{ messageId: string, labelIds: string[] }} input
   * @returns {Promise<void>}
   */
  async function removeLabels({ messageId, labelIds }) {
    const id = String(messageId ?? '').trim();
    if (!id) throw new Error('Indica el id del mensaje.');
    const ids = (labelIds ?? []).map((x) => String(x).trim()).filter(Boolean);
    if (ids.length === 0) throw new Error('Indica al menos un labelId.');
    const api = await gmail();
    await api.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { removeLabelIds: ids },
    });
    logger?.info({ messageId: id, labelIds: ids }, 'Gmail removeLabels');
  }

  /**
   * Aplica una label (creándola si no existe) a todos los mensajes que
   * matcheen la query Gmail. Devuelve el conteo de mensajes etiquetados,
   * el labelId resuelto y, si la label era nueva, una flag created.
   *
   * @param {{ query: string, labelName: string, maxResults?: number }} input
   * @returns {Promise<{ labelId: string, labelName: string, created: boolean, matched: number, labeled: number, errors: number }>}
   */
  async function applyToQuery({ query, labelName, maxResults = MAX_RESULTS_DEFAULT }) {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('Indica una query Gmail (ej: "from:foo").');
    const lname = String(labelName ?? '').trim();
    if (!lname) throw new Error('Indica un nombre de label.');

    const cap = Math.min(Math.max(1, maxResults), MAX_RESULTS_HARD_CAP);
    const existing = await findLabelByName(lname);
    const label = existing ?? (await createLabel({ name: lname }));
    const created = !existing;

    const api = await gmail();
    const listRes = await api.users.messages.list({ userId: 'me', q, maxResults: cap });
    const ids = (listRes?.data?.messages ?? []).map((m) => m.id).filter(Boolean);

    let labeled = 0;
    let errors = 0;
    for (const id of ids) {
      try {
        await api.users.messages.modify({
          userId: 'me',
          id,
          requestBody: { addLabelIds: [label.id] },
        });
        labeled += 1;
      } catch (error) {
        errors += 1;
        logger?.warn({ err: error?.message, id }, 'Gmail applyToQuery: modify failed');
      }
    }

    logger?.info(
      { query: q, labelName: label.name, created, matched: ids.length, labeled, errors },
      'Gmail applyToQuery done',
    );

    return {
      labelId: label.id,
      labelName: label.name,
      created,
      matched: ids.length,
      labeled,
      errors,
    };
  }

  /**
   * Sugiere un nombre de label en español a partir de la temática del
   * correo. Útil para flujos donde el LLM clasifica antes de etiquetar.
   * Devuelve null si no hay llmService o si la respuesta es inválida.
   *
   * @param {{ from: string, subject: string, snippet: string }} email
   * @returns {Promise<string | null>}
   */
  async function suggestLabel(email) {
    if (!llmService) return null;
    const prompt =
      'Dame UN SOLO nombre de etiqueta para clasificar este correo. ' +
      'Debe ser corto (1-3 palabras), en español, sin acentos raros ni emojis, sin barras ni dos puntos. ' +
      'Responde SOLO con la etiqueta, sin comillas ni explicación.\n\n' +
      `De: ${email?.from ?? ''}\nAsunto: ${email?.subject ?? ''}\nFragmento: ${email?.snippet ?? ''}`;
    const raw = await llmService.generateText(prompt, {
      module: 'gmail-labels',
      operation: 'suggest',
      private: true,
    });
    const cleaned = String(raw ?? '')
      .trim()
      .split('\n')[0]
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();
    if (!cleaned || cleaned.length > 40) return null;
    return cleaned;
  }

  return {
    listLabels,
    findLabelByName,
    createLabel,
    ensureLabel,
    addLabels,
    removeLabels,
    applyToQuery,
    suggestLabel,
  };
}

/**
 * @typedef {Object} Label
 * @property {string} id
 * @property {string} name
 * @property {'user' | 'system' | string} type
 */

/**
 * @typedef {Object} GmailApi
 * @property {{
 *   labels: {
 *     list: (params: object) => Promise<any>,
 *     create: (params: object) => Promise<any>,
 *   },
 *   messages: {
 *     list: (params: object) => Promise<any>,
 *     modify: (params: object) => Promise<any>,
 *   }
 * }} users
 */

/**
 * @typedef {Object} GmailLabelsClient
 * @property {() => Promise<Label[]>} listLabels
 * @property {(name: string) => Promise<Label | null>} findLabelByName
 * @property {(input: { name: string }) => Promise<Label>} createLabel
 * @property {(name: string) => Promise<Label>} ensureLabel
 * @property {(input: { messageId: string, labelIds: string[] }) => Promise<void>} addLabels
 * @property {(input: { messageId: string, labelIds: string[] }) => Promise<void>} removeLabels
 * @property {(input: { query: string, labelName: string, maxResults?: number }) => Promise<{ labelId: string, labelName: string, created: boolean, matched: number, labeled: number, errors: number }>} applyToQuery
 * @property {(email: { from: string, subject: string, snippet: string }) => Promise<string | null>} suggestLabel
 */
