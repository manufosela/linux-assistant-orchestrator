import { google } from 'googleapis';

const MAX_RESULTS_HARD_CAP = 50;
const UNREAD_LABEL_ID = 'UNREAD';
// Resumir más de 5-6 correos en un solo prompt agota maxTokens en el modelo
// local rápido (genera un texto largo y se corta a mitad). Procesamos en
// bloques pequeños y concatenamos: cada llamada es más rápida y el texto
// completo está garantizado.
const SUMMARY_CHUNK_SIZE = 5;

/**
 * Daily Gmail digest (LUI-TSK-0031). Dado un filtro Gmail, lista correos no
 * leídos, los resume con el LLM local y devuelve el texto listo para enviar
 * a Telegram. Opcionalmente, tras enviar, los marca como leídos quitando la
 * label UNREAD via gmail-labels (NO los borra ni los archiva fuera de Inbox).
 *
 * Diseño:
 *  - `build(opts)` ejecuta la parte pura (fetch + resumen). NO marca nada.
 *  - `dispatch(opts)` orquesta build → notify → markAsRead. Si notify falla,
 *    NO marca como leídos, para que el digest se reintente en la siguiente
 *    ejecución.
 *
 * @param {{
 *   googleAuth: import('../google/google-auth.js').GoogleAuth,
 *   llmService?: import('../llm/llm-service.js').LlmService,
 *   gmailLabels?: import('./gmail-labels.js').GmailLabelsClient,
 *   logger?: import('pino').Logger,
 *   gmailFactory?: (auth: object) => any,
 * }} deps
 * @returns {GmailDigestClient}
 */
export function createGmailDigest({ googleAuth, llmService, gmailLabels, logger, gmailFactory }) {
  const createApi = gmailFactory ?? ((auth) => google.gmail({ version: 'v1', auth }));

  async function gmail() {
    const auth = await googleAuth.getClient();
    return createApi(auth);
  }

  /**
   * Lee mensajes que matcheen `query`, los resume con el LLM y devuelve
   * el texto + ids. No modifica el estado de los mensajes.
   *
   * @param {{ query: string, maxResults?: number }} opts
   * @returns {Promise<{ ids: string[], emails: EmailRow[], summary: string, truncated: boolean }>}
   */
  async function build({ query, maxResults = 20 }) {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('Indica una query Gmail para el digest.');
    const cap = Math.min(Math.max(1, maxResults), MAX_RESULTS_HARD_CAP);

    const api = await gmail();
    const listRes = await api.users.messages.list({
      userId: 'me',
      q,
      maxResults: cap,
    });
    const items = listRes?.data?.messages ?? [];
    const truncated = items.length === cap;
    if (items.length === 0) {
      logger?.info({ query: q }, 'Gmail digest: 0 mensajes');
      return { ids: [], emails: [], summary: '', truncated: false };
    }

    const emails = await Promise.all(items.map((m) => fetchOne(api, m.id)));
    const valid = emails.filter(Boolean);
    const summary = await summarise(valid);
    logger?.info(
      { query: q, count: valid.length, truncated },
      'Gmail digest: built',
    );
    return {
      ids: valid.map((e) => e.id),
      emails: valid,
      summary,
      truncated,
    };
  }

  /**
   * Ejecuta build, llama a `notify(text)` con el digest. Si la notificación
   * va bien y `markAsRead=true`, quita la label UNREAD a los mensajes.
   *
   * @param {{ query: string, maxResults?: number, markAsRead?: boolean, notify: (text: string) => Promise<void> }} opts
   * @returns {Promise<{ count: number, notified: boolean, markedAsRead: number }>}
   */
  async function dispatch({ query, maxResults, markAsRead = true, notify }) {
    if (typeof notify !== 'function') {
      throw new Error('dispatch requires a notify(text) function.');
    }
    const result = await build({ query, maxResults });
    if (result.emails.length === 0) {
      logger?.debug('Gmail digest: nothing to send');
      return { count: 0, notified: false, markedAsRead: 0 };
    }

    const text = formatDigest(result);
    try {
      await notify(text);
    } catch (error) {
      logger?.warn({ err: error?.message }, 'Gmail digest: notify failed, skipping markAsRead');
      throw error;
    }

    let markedAsRead = 0;
    if (markAsRead && gmailLabels) {
      for (const id of result.ids) {
        try {
          await gmailLabels.removeLabels({ messageId: id, labelIds: [UNREAD_LABEL_ID] });
          markedAsRead += 1;
        } catch (error) {
          logger?.warn({ err: error?.message, id }, 'Gmail digest: mark-as-read failed for message');
        }
      }
    }

    logger?.info(
      { count: result.emails.length, markedAsRead, truncated: result.truncated },
      'Gmail digest: dispatched',
    );
    return { count: result.emails.length, notified: true, markedAsRead };
  }

  async function fetchOne(api, id) {
    try {
      const res = await api.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const headers = res?.data?.payload?.headers ?? [];
      const h = (name) =>
        headers.find((x) => String(x?.name ?? '').toLowerCase() === name.toLowerCase())?.value ?? '';
      return {
        id,
        from: h('From'),
        subject: h('Subject'),
        date: h('Date'),
        snippet: res?.data?.snippet ?? '',
      };
    } catch (error) {
      logger?.warn({ err: error?.message, id }, 'Gmail digest: fetch one failed');
      return null;
    }
  }

  /**
   * Resume los correos. Para no saturar el modelo local (que en CPU se
   * arrastra con prompts grandes y trunca el output al alcanzar maxTokens),
   * partimos los correos en bloques de SUMMARY_CHUNK_SIZE y resumimos cada
   * bloque por separado. Luego concatenamos los resúmenes parciales sin
   * volver a invocar al LLM — el formato ya viene normalizado.
   *
   * Subimos maxTokens explícitamente a 2048 para que el modelo termine
   * cada bloque (el default 1024 cortaba el texto a mitad del segundo
   * correo en bloques de 20).
   */
  async function summarise(emails) {
    if (!llmService) {
      return formatPlainList(emails);
    }
    const chunks = chunkArray(emails, SUMMARY_CHUNK_SIZE);
    try {
      const summaries = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const partial = await summariseChunk(chunks[i], i, chunks.length);
        summaries.push(partial);
      }
      const merged = summaries.join('\n').trim();
      return merged || formatPlainList(emails);
    } catch (error) {
      logger?.warn({ err: error?.message }, 'Gmail digest: LLM summary failed, falling back to list');
      return formatPlainList(emails);
    }
  }

  async function summariseChunk(emails, chunkIndex, chunkTotal) {
    const items = emails
      .map((e, i) => `${i + 1}. De: ${e.from}\n   Asunto: ${e.subject}\n   Fragmento: ${e.snippet}`)
      .join('\n\n');

    const isFirst = chunkIndex === 0;
    const headerHint = isFirst && chunkTotal === 1
      ? 'Empieza con un titular agregado de 1 línea resumiendo qué tipo de contenido predomina, y luego una línea por correo.'
      : 'Devuelve UNA SOLA LÍNEA por correo. No añadas titular ni cabecera, sólo las líneas.';

    const prompt =
      `Resume estos ${emails.length} correos en español, en estilo conciso y útil para una persona que ` +
      'recibe a diario contenido de estudio (cursos, newsletters, papers, etc.). Una línea por correo, ' +
      'con remitente y la idea clave (lo accionable o lo importante). Sin frases introductorias, sin ' +
      `inventar datos que no aparezcan en el fragmento. ${headerHint}\n\n${items}`;

    const text = await llmService.generateText(prompt, {
      module: 'gmail-digest',
      operation: 'summarize',
      private: true,
      maxTokens: 2048,
      temperature: 0.3,
    });
    return String(text ?? '').trim();
  }

  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
      out.push(arr.slice(i, i + size));
    }
    return out;
  }

  function formatPlainList(emails) {
    return emails
      .map((e, i) => `${i + 1}. ${e.subject || '(sin asunto)'} — ${e.from || '(?)'}`)
      .join('\n');
  }

  function formatDigest(result) {
    const heading = `📚 <b>Digest de estudio (${result.emails.length} correo${result.emails.length === 1 ? '' : 's'}):</b>`;
    const tail = result.truncated ? '\n\n<i>(truncado al máximo configurado)</i>' : '';
    // Si el resumen ya viene con HTML por escapado upstream sería problemático;
    // confiamos en que el LLM devuelve texto plano y lo enviamos tal cual.
    return `${heading}\n\n${escapeHtmlSafe(result.summary)}${tail}`;
  }

  return { build, dispatch };
}

/**
 * Programa una ejecución diaria a la hora local indicada. La primera
 * invocación se programa con `delay()`, y al firing se re-programa el
 * siguiente día. La función inyectable `nowFn` permite tests deterministas.
 *
 * @param {{
 *   scheduler: import('../../infrastructure/scheduler/scheduler.js').Scheduler,
 *   hour: number,
 *   minute: number,
 *   run: () => Promise<void> | void,
 *   nowFn?: () => Date,
 *   logger?: import('pino').Logger,
 *   name?: string,
 * }} opts
 */
export function scheduleDaily({ scheduler, hour, minute, run, nowFn, logger, name = 'gmail-digest' }) {
  const getNow = nowFn ?? (() => new Date());

  function msUntilNext() {
    const now = getNow();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
  }

  function fire() {
    Promise.resolve(run())
      .catch((error) => logger?.warn({ err: error?.message, name }, 'scheduleDaily: run threw'))
      .finally(() => {
        // Re-arm for the next day, regardless of success.
        const delayMs = msUntilNext();
        scheduler.delay(fire, delayMs);
        logger?.debug({ name, delayMs }, 'scheduleDaily: rearmed for next day');
      });
  }

  const initialDelay = msUntilNext();
  scheduler.delay(fire, initialDelay);
  logger?.info({ name, hour, minute, initialDelayMs: initialDelay }, 'scheduleDaily: armed');
}

function escapeHtmlSafe(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @typedef {Object} EmailRow
 * @property {string} id
 * @property {string} from
 * @property {string} subject
 * @property {string} date
 * @property {string} snippet
 */

/**
 * @typedef {Object} GmailDigestClient
 * @property {(opts: { query: string, maxResults?: number }) => Promise<{ ids: string[], emails: EmailRow[], summary: string, truncated: boolean }>} build
 * @property {(opts: { query: string, maxResults?: number, markAsRead?: boolean, notify: (text: string) => Promise<void> }) => Promise<{ count: number, notified: boolean, markedAsRead: number }>} dispatch
 */
