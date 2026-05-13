import { google } from 'googleapis';

const MAX_RESULTS_DEFAULT = 10;
const MAX_RESULTS_HARD_CAP = 50;

/**
 * Read-only Gmail client used by LUIS.
 *
 * Capabilities:
 *  - `unreadToday()` — emails no leídos en las últimas 24h
 *  - `fromSender({ sender })` — emails de un remitente concreto (cualquier estado)
 *  - `byKeyword({ keyword })` — emails que matchean una palabra clave en cualquier parte
 *  - `summarize(emails)` — resumen agregado en español vía el LLM local (opcional)
 *
 * El módulo **NUNCA** llama a métodos de escritura (send, modify, trash, delete). Si los
 * scopes OAuth2 son solo `gmail.readonly` (lo que LUIS pide), la API rechaza esos métodos
 * en cualquier caso.
 *
 * @param {{
 *   googleAuth: import('../google/google-auth.js').GoogleAuth,
 *   llmService?: import('../llm/llm-service.js').LlmService,
 *   logger?: import('pino').Logger,
 *   gmailFactory?: (auth: object) => GmailApi,
 * }} deps
 * @returns {GmailClient}
 */
export function createGmailClient({ googleAuth, llmService, logger, gmailFactory }) {
  const createApi = gmailFactory ?? ((auth) => google.gmail({ version: 'v1', auth }));

  /**
   * Resolves an authenticated Gmail API client. Cached per call — se podría memoizar pero al
   * abrir Gmail una vez por comando CLI no merece la pena.
   *
   * @returns {Promise<GmailApi>}
   */
  async function gmail() {
    const auth = await googleAuth.getClient();
    return createApi(auth);
  }

  /**
   * Lists message metadata matching a Gmail search query. Devuelve un array de objetos con
   * `{ id, from, subject, date, snippet }`. Si la búsqueda no devuelve nada, devuelve `[]`.
   *
   * @param {{ query: string, maxResults?: number }} input
   * @returns {Promise<EmailSummary[]>}
   */
  async function listMessages({ query, maxResults = MAX_RESULTS_DEFAULT }) {
    const cappedMax = Math.min(Math.max(1, maxResults), MAX_RESULTS_HARD_CAP);
    const api = await gmail();
    logger?.info({ query, maxResults: cappedMax }, 'Gmail listMessages: requesting');

    const listRes = await api.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: cappedMax,
    });
    const ids = (listRes?.data?.messages ?? []).map((m) => m.id).filter(Boolean);

    if (ids.length === 0) {
      logger?.info({ query }, 'Gmail listMessages: no results');
      return [];
    }

    const details = await Promise.all(ids.map((id) => fetchMessage(api, id)));
    const filtered = details.filter(Boolean);
    logger?.info({ query, count: filtered.length }, 'Gmail listMessages: fetched');
    return filtered;
  }

  /**
   * Fetches a single message in metadata format. Returns null on any per-message failure so
   * a single broken message does not kill the whole listing.
   *
   * @param {GmailApi} api
   * @param {string} id
   * @returns {Promise<EmailSummary | null>}
   */
  async function fetchMessage(api, id) {
    try {
      const res = await api.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const headers = res?.data?.payload?.headers ?? [];
      const header = (name) =>
        headers.find((h) => String(h?.name ?? '').toLowerCase() === name.toLowerCase())?.value ?? '';
      return {
        id,
        from: header('From'),
        subject: header('Subject'),
        date: header('Date'),
        snippet: res?.data?.snippet ?? '',
      };
    } catch (error) {
      logger?.warn({ err: error?.message, id }, 'Gmail fetchMessage failed for individual message');
      return null;
    }
  }

  /**
   * Emails no leídos en las últimas 24h. Devuelve `EmailSummary[]`.
   *
   * @param {{ maxResults?: number }} [options]
   * @returns {Promise<EmailSummary[]>}
   */
  async function unreadToday(options = {}) {
    return listMessages({
      query: 'is:unread newer_than:1d',
      maxResults: options.maxResults ?? MAX_RESULTS_DEFAULT,
    });
  }

  /**
   * Emails de un remitente concreto (busca por la parte que pongas — nombre, alias, dominio).
   *
   * @param {{ sender: string, maxResults?: number }} options
   * @returns {Promise<EmailSummary[]>}
   */
  async function fromSender(options) {
    const sender = String(options?.sender ?? '').trim();
    if (!sender) throw new Error('Indica un remitente (nombre, email o dominio).');
    return listMessages({
      query: `from:${sender}`,
      maxResults: options.maxResults ?? MAX_RESULTS_DEFAULT,
    });
  }

  /**
   * Emails que matchean una palabra clave en cualquier campo (Gmail full-text).
   *
   * @param {{ keyword: string, maxResults?: number }} options
   * @returns {Promise<EmailSummary[]>}
   */
  async function byKeyword(options) {
    const keyword = String(options?.keyword ?? '').trim();
    if (!keyword) throw new Error('Indica una palabra clave.');
    return listMessages({
      query: keyword,
      maxResults: options.maxResults ?? MAX_RESULTS_DEFAULT,
    });
  }

  /**
   * Asks the local LLM for an aggregated summary of the provided email list. Returns a single
   * paragraph in Spanish. Returns `null` if llmService is not configured.
   *
   * @param {EmailSummary[]} emails
   * @returns {Promise<string | null>}
   */
  async function summarize(emails) {
    if (!Array.isArray(emails) || emails.length === 0) return 'No hay correos que resumir.';
    if (!llmService) return null;

    const items = emails.map((e, i) =>
      `${i + 1}. De: ${e.from}\n   Asunto: ${e.subject}\n   Resumen breve: ${e.snippet}`,
    ).join('\n\n');

    const prompt =
      `Te paso ${emails.length} correos electrónicos con remitente, asunto y un fragmento del cuerpo. ` +
      `Resume cada uno en una sola línea (máximo 25 palabras), en español, indicando remitente y la idea principal. ` +
      `No inventes información que no aparezca en el contenido. Si el remitente no es claro, dilo. ` +
      `Empieza directamente con el listado numerado, sin frases introductorias.\n\n${items}`;

    return llmService.generateText(prompt, {
      module: 'gmail',
      operation: 'summarize',
      private: true,
    });
  }

  return { unreadToday, fromSender, byKeyword, summarize };
}

/**
 * @typedef {Object} EmailSummary
 * @property {string} id
 * @property {string} from
 * @property {string} subject
 * @property {string} date
 * @property {string} snippet
 */

/**
 * Minimal shape of the Gmail API client we depend on. Restricted to what the module uses so
 * test stubs only need to implement these two methods.
 *
 * @typedef {Object} GmailApi
 * @property {{ messages: { list: (params: object) => Promise<any>, get: (params: object) => Promise<any> } }} users
 */

/**
 * @typedef {Object} GmailClient
 * @property {(options?: { maxResults?: number }) => Promise<EmailSummary[]>} unreadToday
 * @property {(options: { sender: string, maxResults?: number }) => Promise<EmailSummary[]>} fromSender
 * @property {(options: { keyword: string, maxResults?: number }) => Promise<EmailSummary[]>} byKeyword
 * @property {(emails: EmailSummary[]) => Promise<string | null>} summarize
 */
