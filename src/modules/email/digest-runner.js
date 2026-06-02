/**
 * Orquestador del digest diario por etiqueta (LUI-TSK-0064).
 *
 * Para cada etiqueta del canal LISTA:
 *  1. Lee last-run de esa etiqueta. Si hay ids previos, los marca como
 *     leídos (quita UNREAD via gmailLabels.removeLabels). Esto cumple
 *     "los correos del digest de ayer deben aparecer como leídos hoy".
 *  2. Fetch de no-leídos con `label:<X>` (límite maxResults).
 *  3. Si hay correos, llama a `notify(text)` con el listado numerado.
 *  4. Guarda los ids actuales en last-run para la próxima ejecución.
 *  5. Si NO hay correos, no envía nada (silencio).
 *
 * El canal RESUMEN se procesa en una fase posterior (LUI-TSK-0065).
 *
 * @param {{
 *   gmailDigest: import('./gmail-digest.js').GmailDigestClient,
 *   gmailLabels: import('./gmail-labels.js').GmailLabelsClient,
 *   lastRunStore: import('./digest-last-run-store.js').DigestLastRunStore,
 *   logger?: import('pino').Logger,
 *   nowFn?: () => Date,
 * }} deps
 * @returns {DigestRunner}
 */
export function createDigestRunner({ gmailDigest, gmailLabels, lastRunStore, summaryStore, llmService, logger, nowFn }) {
  if (!gmailDigest) throw new Error('createDigestRunner requires gmailDigest');
  if (!gmailLabels) throw new Error('createDigestRunner requires gmailLabels');
  if (!lastRunStore) throw new Error('createDigestRunner requires lastRunStore');
  const now = nowFn ?? (() => new Date());

  /**
   * Procesa una sola etiqueta del canal LISTA. Marca los ids previos como
   * leídos, hace fetch de los actuales, llama a notify y guarda el nuevo
   * last-run. Devuelve un resumen del ciclo para logging y testing.
   *
   * @param {{ labelName: string, notify: (text: string) => Promise<void>, maxResults?: number }} opts
   */
  async function runListLabel({ labelName, notify, maxResults = 20 }) {
    if (!labelName) throw new Error('labelName is required');
    if (typeof notify !== 'function') throw new Error('notify(text) is required');

    // 1) Marcar como leídos los del envío anterior (si los había).
    const previous = await lastRunStore.read(labelName);
    let markedAsRead = 0;
    for (const id of previous.ids) {
      try {
        await gmailLabels.removeLabels({ messageId: id, labelIds: ['UNREAD'] });
        markedAsRead += 1;
      } catch (error) {
        // Si el mensaje fue movido/borrado fuera de Gmail, el modify falla.
        // No es crítico: seguimos con los demás.
        logger?.warn(
          { err: error?.message, id, labelName },
          'digest-runner: failed to mark previous as read',
        );
      }
    }

    // 2) Fetch de no-leídos actuales con esa label.
    const query = `is:unread label:${gmailQueryLabel(labelName)}`;
    const list = await gmailDigest.fetchList({ query, maxResults });

    if (list.emails.length === 0) {
      // Silencio. Limpiamos el last-run porque ya marcamos como leídos lo
      // de ayer; no queremos volver a intentarlo mañana sobre los mismos.
      await lastRunStore.clearFor(labelName);
      logger?.info({ labelName, previousIds: previous.ids.length, markedAsRead }, 'digest-runner: nothing to send');
      return {
        labelName,
        sent: false,
        count: 0,
        markedAsRead,
        ids: [],
      };
    }

    // 3) Enviar listado numerado.
    const text = formatListMessage(labelName, list);
    try {
      await notify(text);
    } catch (error) {
      // Si la notificación falla, NO guardamos last-run nuevo — así
      // mañana se intentará otra vez y el usuario no perderá esos correos.
      logger?.warn({ err: error?.message, labelName }, 'digest-runner: notify failed, last-run not updated');
      throw error;
    }

    // 4) Persistir last-run.
    await lastRunStore.write(labelName, list.ids, now().toISOString());

    logger?.info(
      { labelName, count: list.emails.length, markedAsRead, truncated: list.truncated },
      'digest-runner: list label processed',
    );
    return {
      labelName,
      sent: true,
      count: list.emails.length,
      markedAsRead,
      ids: list.ids,
    };
  }

  /**
   * Procesa todas las etiquetas del canal LISTA. Si una falla, sigue con
   * la siguiente (no aborta el batch). Devuelve un array con el resultado
   * de cada etiqueta.
   *
   * @param {{ listLabels: string[], notify: (text: string) => Promise<void>, maxResults?: number }} opts
   */
  async function runListChannel({ listLabels, notify, maxResults }) {
    const results = [];
    for (const labelName of listLabels ?? []) {
      try {
        const r = await runListLabel({ labelName, notify, maxResults });
        results.push(r);
      } catch (error) {
        logger?.warn({ err: error?.message, labelName }, 'digest-runner: label failed, continuing');
        results.push({ labelName, sent: false, count: 0, markedAsRead: 0, ids: [], error: error?.message });
      }
    }
    return results;
  }

  /**
   * Canal RESUMEN: para cada etiqueta resume cada correo con el LLM,
   * persiste el resumen en summaryStore con un shortId, y envía un
   * mensaje-índice "1. Asunto — /resumen <shortId>". El último envío
   * queda en last-run para que el día siguiente esos correos se marquen
   * como leídos.
   *
   * @param {{ labelName: string, notify: (text: string) => Promise<void>, maxResults?: number }} opts
   */
  async function runSummaryLabel({ labelName, notify, maxResults = 20 }) {
    if (!summaryStore) throw new Error('runSummaryLabel requires summaryStore');
    if (!llmService) throw new Error('runSummaryLabel requires llmService');
    if (!labelName) throw new Error('labelName is required');
    if (typeof notify !== 'function') throw new Error('notify(text) is required');

    // 1) Mark-as-read del envío anterior.
    const previous = await lastRunStore.read(labelName);
    let markedAsRead = 0;
    for (const id of previous.ids) {
      try {
        await gmailLabels.removeLabels({ messageId: id, labelIds: ['UNREAD'] });
        markedAsRead += 1;
      } catch (error) {
        logger?.warn({ err: error?.message, id, labelName }, 'digest-runner summary: mark-as-read failed');
      }
    }

    // 2) Fetch de no-leídos.
    const query = `is:unread label:${gmailQueryLabel(labelName)}`;
    const list = await gmailDigest.fetchList({ query, maxResults });
    if (list.emails.length === 0) {
      await lastRunStore.clearFor(labelName);
      logger?.info({ labelName, previousIds: previous.ids.length, markedAsRead }, 'digest-runner summary: nothing to send');
      return { labelName, sent: false, count: 0, markedAsRead, ids: [], summaries: [] };
    }

    // 3) Resumir cada correo con el LLM. Procesamos en serie para no saturar
    //    el modelo local (ya está justo de CPU). Si uno falla, registramos
    //    un resumen de fallback con el snippet y seguimos con el siguiente.
    const summaries = [];
    for (const email of list.emails) {
      const summary = await summariseOne(email, labelName, llmService, logger);
      const shortId = await summaryStore.save({
        messageId: email.id,
        labelName,
        from: email.from,
        subject: email.subject,
        date: email.date,
        summary,
      });
      summaries.push({ email, shortId, summary });
    }

    // 4) Notificar el índice. Si falla, NO actualizamos last-run.
    const text = formatSummaryIndex(labelName, summaries, list.truncated);
    try {
      await notify(text);
    } catch (error) {
      logger?.warn({ err: error?.message, labelName }, 'digest-runner summary: notify failed');
      throw error;
    }

    await lastRunStore.write(labelName, list.ids, now().toISOString());
    logger?.info(
      { labelName, count: list.emails.length, markedAsRead, truncated: list.truncated },
      'digest-runner summary: processed',
    );
    return {
      labelName,
      sent: true,
      count: list.emails.length,
      markedAsRead,
      ids: list.ids,
      summaries,
    };
  }

  /**
   * Procesa todas las etiquetas del canal RESUMEN en serie.
   */
  async function runSummaryChannel({ summaryLabels, notify, maxResults }) {
    const results = [];
    for (const labelName of summaryLabels ?? []) {
      try {
        const r = await runSummaryLabel({ labelName, notify, maxResults });
        results.push(r);
      } catch (error) {
        logger?.warn({ err: error?.message, labelName }, 'digest-runner summary: label failed');
        results.push({ labelName, sent: false, count: 0, markedAsRead: 0, ids: [], summaries: [], error: error?.message });
      }
    }
    return results;
  }

  return { runListLabel, runListChannel, runSummaryLabel, runSummaryChannel };
}

/**
 * Resume un único correo con el LLM en una línea concisa. Si el LLM
 * falla, devuelve un fallback con el snippet (mejor algo que nada).
 */
async function summariseOne(email, labelName, llmService, logger) {
  try {
    const prompt =
      'Resume este correo en español en estilo conciso para una persona ' +
      `que recibe a diario contenido del tipo "${labelName}". 2-4 frases ` +
      'máximo, sin frases introductorias, sin inventar datos. Si hay una ' +
      'acción concreta (deadline, link relevante, decisión), destácala al ' +
      `final como "Acción: ...".\n\n` +
      `De: ${email.from}\n` +
      `Asunto: ${email.subject}\n` +
      `Fragmento: ${email.snippet}`;
    const text = await llmService.generateText(prompt, {
      module: 'gmail-digest-summary',
      operation: 'summarize-one',
      private: true,
      maxTokens: 512,
      temperature: 0.3,
    });
    const clean = String(text ?? '').trim();
    return clean || fallbackSummary(email);
  } catch (error) {
    logger?.warn({ err: error?.message, messageId: email.id }, 'digest-runner: LLM summarise one failed, using fallback');
    return fallbackSummary(email);
  }
}

function fallbackSummary(email) {
  const parts = [
    `De: ${email.from || '(desconocido)'}`,
    `Asunto: ${email.subject || '(sin asunto)'}`,
    email.snippet ? `Fragmento: ${email.snippet}` : null,
  ].filter(Boolean);
  return parts.join('\n');
}

function formatSummaryIndex(labelName, summaries, truncated) {
  const heading = `📚 <b>${escapeHtml(labelName)}</b> — ${summaries.length} resumen${summaries.length === 1 ? '' : 'es'} listo${summaries.length === 1 ? '' : 's'}:`;
  const lines = summaries.map(({ email, shortId }, i) => {
    const subj = escapeHtml(email.subject || '(sin asunto)');
    const from = escapeHtml(stripFromName(email.from));
    return `${i + 1}. <b>${subj}</b>\n   <i>${from}</i>\n   /resumen ${shortId}`;
  });
  const tail = truncated ? '\n\n<i>(truncado al máximo configurado)</i>' : '';
  return `${heading}\n\n${lines.join('\n\n')}${tail}`;
}

/**
 * Si la label contiene espacios u operadores, Gmail necesita entrecomillado.
 * Para nombres anidados (Estudio/Curso), conviene también.
 *
 * @param {string} name
 */
function gmailQueryLabel(name) {
  if (/[\s/]/.test(name)) return `"${name}"`;
  return name;
}

function formatListMessage(labelName, list) {
  const heading = `📋 <b>${escapeHtml(labelName)}</b> — ${list.emails.length} correo${list.emails.length === 1 ? '' : 's'} sin leer:`;
  const lines = list.emails.map((e, i) => {
    const subj = escapeHtml(e.subject || '(sin asunto)');
    const from = escapeHtml(stripFromName(e.from));
    return `${i + 1}. <b>${subj}</b>\n   <i>${from}</i>`;
  });
  const tail = list.truncated ? '\n\n<i>(truncado al máximo configurado)</i>' : '';
  return `${heading}\n\n${lines.join('\n\n')}${tail}`;
}

function stripFromName(raw) {
  if (!raw) return '(desconocido)';
  const m = raw.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  if (m) return m[1].trim();
  return raw.trim();
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @typedef {Object} DigestRunner
 * @property {(opts: { labelName: string, notify: (text: string) => Promise<void>, maxResults?: number }) => Promise<RunResult>} runListLabel
 * @property {(opts: { listLabels: string[], notify: (text: string) => Promise<void>, maxResults?: number }) => Promise<RunResult[]>} runListChannel
 * @property {(opts: { labelName: string, notify: (text: string) => Promise<void>, maxResults?: number }) => Promise<RunResult>} runSummaryLabel
 * @property {(opts: { summaryLabels: string[], notify: (text: string) => Promise<void>, maxResults?: number }) => Promise<RunResult[]>} runSummaryChannel
 */

/**
 * @typedef {Object} RunResult
 * @property {string} labelName
 * @property {boolean} sent
 * @property {number} count
 * @property {number} markedAsRead
 * @property {string[]} ids
 * @property {string} [error]
 */
