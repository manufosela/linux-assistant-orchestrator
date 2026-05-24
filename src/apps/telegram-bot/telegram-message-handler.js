import { createConversationManager } from '../cli/conversation-manager.js';
import { createThinkingIndicator } from './thinking-indicator.js';
import { parseAnnounceInvocation, listTargetChoices } from '../../modules/home-assistant/ha-alexa-announcer.js';
import { parseClusterIntent } from '../../modules/cluster/cluster-intent.js';
import { formatClusterStatus, formatClusterHistory } from '../../modules/cluster/cluster-status-service.js';
import { parsePrometheusIntent } from '../../modules/prometheus/prometheus-intent.js';
import { formatDownReport } from '../../modules/prometheus/prometheus-formatter.js';
import { parseEmailIntent } from '../../modules/email/email-intent.js';
import { parseCalendarIntent } from '../../modules/calendar/calendar-intent.js';
import { parseDriveIntent } from '../../modules/drive/drive-intent.js';

const ANNOUNCE_PENDING_TTL_MS = 5 * 60 * 1000;
const ANNOUNCE_CALLBACK_PREFIX = 'anuncia:';
const ANNOUNCE_CANCEL_CHOICE = '_cancel';

const SYSTEM_PROMPT =
  'Eres luis, un asistente local privado en Telegram. Responde con precisión y brevedad. ' +
  'El usuario puede darte contexto vía /fetch (URLs descargadas) y /search (resultados de búsqueda); ' +
  'razona sobre ese contexto cuando contestes. Si no sabes algo, dilo.';

/**
 * Creates the Telegram message handler that builds and registers all command handlers
 * plus the natural-language fallback. Each Telegram chat gets its own conversation history,
 * so different family members do not see each other's messages.
 *
 * @param {object} deps
 * @param {object} deps.bot - node-telegram-bot-api instance
 * @param {import('../../modules/assistant/assistant-status-service.js').AssistantStatusService} deps.statusService
 * @param {import('../../modules/downloads/download-rules-repository.js').DownloadRulesRepository} deps.rulesRepository
 * @param {import('../../modules/llm/llm-service.js').LlmService} deps.llmService
 * @param {import('../../modules/web/url-fetcher.js').UrlFetcher} [deps.urlFetcher]
 * @param {import('../../modules/web/web-search.js').WebSearchService} [deps.webSearch]
 * @param {import('../../modules/home-assistant/ha-client.js').HomeAssistantClient} [deps.homeAssistant]
 * @param {import('../../modules/cluster/cluster-status-service.js').ClusterStatusService} [deps.clusterStatus]
 * @param {import('../../modules/prometheus/prometheus-client.js').PrometheusClient} [deps.prometheusClient]
 * @param {import('../../apps/telegram-bot/telegram-command-router.js').TelegramCommandRouter} deps.router
 * @param {import('pino').Logger} deps.logger
 * @returns {void}
 */
export function registerTelegramHandlers({ bot, statusService, rulesRepository, llmService, urlFetcher, webSearch, homeAssistant, alexaAnnouncer, clusterStatus, prometheusClient, gmailClient, calendarClient, driveClient, router, logger }) {
  /** @type {Map<number|string, import('../cli/conversation-manager.js').ConversationManager>} */
  const conversationsByChat = new Map();
  /** @type {Map<number|string, string>} */
  const haConversationByChat = new Map();
  /** @type {Map<number|string, { message: string, expiresAt: number }>} */
  const pendingAnnouncements = new Map();

  /**
   * Returns the per-chat conversation manager, creating it on first use.
   *
   * @param {number|string} chatId
   * @returns {import('../cli/conversation-manager.js').ConversationManager}
   */
  function getConversation(chatId) {
    let conversation = conversationsByChat.get(chatId);
    if (!conversation) {
      conversation = createConversationManager({ systemPrompt: SYSTEM_PROMPT });
      conversationsByChat.set(chatId, conversation);
    }
    return conversation;
  }

  /**
   * Strips the leading `/command` (and optional `@botname`) from the message text and
   * returns the argument string.
   *
   * @param {string} text
   * @returns {string}
   */
  function extractArgs(text) {
    const trimmed = (text ?? '').trim();
    if (!trimmed.startsWith('/')) return trimmed;
    const space = trimmed.search(/\s/);
    return space === -1 ? '' : trimmed.slice(space + 1).trim();
  }

  router.register('/start', async (message) => {
    const chatId = message.chat.id;
    await bot.sendMessage(
      chatId,
      'Hola, soy luis. Escribe lo que quieras y te respondo. Si quieres ver los comandos disponibles, /help.',
    );
  });

  router.register('/status', async (message) => {
    const chatId = message.chat.id;
    const status = statusService.getStatus();

    const moduleLines = status.modules
      .map((m) => `  • <b>${m.name}</b>: ${m.status}${m.note ? ` (${m.note})` : ''}`)
      .join('\n');

    const text = [
      `🤖 <b>${status.name}</b>`,
      ``,
      `Uptime: ${status.uptimeFormatted}`,
      `Environment: ${status.environment}`,
      ``,
      `<b>Modules:</b>`,
      moduleLines,
    ].join('\n');

    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  });

  router.register('/downloads_rules', async (message) => {
    const chatId = message.chat.id;
    try {
      const rules = await rulesRepository.loadRules();
      if (rules.length === 0) {
        await bot.sendMessage(chatId, 'Sin reglas configuradas.');
        return;
      }
      const lines = rules.map((rule, i) => {
        const exts = rule.extensions.join(', ');
        return `${i + 1}. <b>${rule.name}</b>\n   Extensiones: ${exts}\n   Destino: <code>${rule.targetPath}</code>`;
      });
      await bot.sendMessage(chatId, `<b>Reglas (${rules.length}):</b>\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error({ chatId, err: error.message }, '/downloads_rules failed');
      await bot.sendMessage(chatId, 'No pude cargar las reglas. Mira los logs.');
    }
  });

  router.register('/llm_status', async (message) => {
    const chatId = message.chat.id;
    const indicator = await createThinkingIndicator(bot, chatId, {
      text: '⏳ Comprobando el LLM…',
      logger,
    });
    try {
      const healthStatus = await llmService.checkHealth();
      const icon = healthStatus.healthy ? '✅' : '❌';
      const lines = [
        `${icon} <b>LLM ${healthStatus.provider}</b>`,
        `Modelo: ${healthStatus.model || '(sin configurar)'}`,
      ];
      if (healthStatus.baseUrl) lines.push(`Endpoint: <code>${healthStatus.baseUrl}</code>`);
      if (!healthStatus.healthy) lines.push(`\n⚠️ El proveedor no responde.`);
      await indicator.finish(lines.join('\n'), { parse_mode: 'HTML' });
    } catch (error) {
      logger.error({ chatId, err: error.message }, '/llm_status failed');
      await indicator.finish(`Falló: ${error.message}`);
    }
  });

  router.register('/fetch', async (message) => {
    const chatId = message.chat.id;
    const url = extractArgs(message.text ?? '');
    if (!url) {
      await bot.sendMessage(chatId, 'Uso: /fetch &lt;url&gt;', { parse_mode: 'HTML' });
      return;
    }
    if (!urlFetcher) {
      await bot.sendMessage(chatId, 'URL fetcher no configurado.');
      return;
    }
    const indicator = await createThinkingIndicator(bot, chatId, {
      text: `⏳ Descargando ${url} …`,
      logger,
    });
    try {
      const result = await urlFetcher.fetchUrl(url);
      const conversation = getConversation(chatId);
      conversation.appendContext(`Fetched ${result.url}`, `# ${result.title || '(sin título)'}\n\n${result.text}`);
      const label = result.title ? `${result.title} — ${result.url}` : result.url;
      await indicator.finish(`✅ Añadidos ${result.bytes} bytes de ${label} al contexto.`);
    } catch (error) {
      logger.warn({ chatId, url, err: error.message }, '/fetch failed');
      await indicator.finish(`❌ No pude descargar: ${error.message}`);
    }
  });

  router.register('/search', async (message) => {
    const chatId = message.chat.id;
    const query = extractArgs(message.text ?? '');
    if (!query) {
      await bot.sendMessage(chatId, 'Uso: /search &lt;query&gt;', { parse_mode: 'HTML' });
      return;
    }
    if (!webSearch) {
      await bot.sendMessage(chatId, 'Búsqueda no configurada.');
      return;
    }
    const indicator = await createThinkingIndicator(bot, chatId, {
      text: `🔎 Buscando "${query}" …`,
      logger,
    });
    try {
      const results = await webSearch.search(query);
      if (results.length === 0) {
        await indicator.finish('Sin resultados.');
        return;
      }
      const formatted = results
        .map((r, i) => `${i + 1}. <b>${escapeHtml(r.title)}</b>\n   ${escapeHtml(r.url)}\n   ${escapeHtml(r.snippet)}`)
        .join('\n\n');
      await indicator.finish(formatted, { parse_mode: 'HTML', disable_web_page_preview: true });
      const conversation = getConversation(chatId);
      conversation.appendContext(
        `Search "${query}"`,
        results.map((r) => `- ${r.title}\n  ${r.url}\n  ${r.snippet}`).join('\n'),
      );
    } catch (error) {
      logger.warn({ chatId, query, err: error.message }, '/search failed');
      await indicator.finish(`❌ Búsqueda fallida: ${error.message}`);
    }
  });

  router.register('/reset', async (message) => {
    const chatId = message.chat.id;
    const conversation = getConversation(chatId);
    conversation.reset();
    haConversationByChat.delete(chatId);
    await bot.sendMessage(chatId, 'Conversación borrada.');
  });

  router.register('/ha', async (message) => {
    const chatId = message.chat.id;
    const text = extractArgs(message.text ?? '');
    if (!text) {
      await bot.sendMessage(chatId, 'Uso: /ha &lt;texto&gt; — ej: /ha enciende el termostato', { parse_mode: 'HTML' });
      return;
    }
    if (!homeAssistant) {
      await bot.sendMessage(chatId, 'Home Assistant no configurado.');
      return;
    }
    const indicator = await createThinkingIndicator(bot, chatId, {
      text: '⏳ Hablando con Home Assistant…',
      logger,
    });
    try {
      const previousConversationId = haConversationByChat.get(chatId);
      const result = await homeAssistant.processConversation(text, {
        conversationId: previousConversationId,
      });
      if (result.conversationId) haConversationByChat.set(chatId, result.conversationId);

      const icon = result.responseType === 'error' ? '⚠️' : '🏠';
      const reply = result.speech || '(sin respuesta)';
      await indicator.finish(`${icon} ${reply}`);
    } catch (error) {
      logger.warn({ chatId, err: error.message }, '/ha failed');
      await indicator.finish(`❌ Home Assistant: ${error.message}`);
    }
  });

  router.register('/anuncia', async (message) => {
    const chatId = message.chat.id;
    const raw = extractArgs(message.text ?? '');
    const parsed = parseAnnounceInvocation(raw);

    if (!parsed.message) {
      await bot.sendMessage(
        chatId,
        'Uso: /anuncia &lt;destino&gt; &lt;mensaje&gt;   o   /anuncia &lt;mensaje&gt;\n\nSi no indicas destino, te muestro los Echos disponibles para elegir.\n\nEjemplos:\n  /anuncia dormitorio el agua está lista\n  /anuncia casa atención a todos\n  /anuncia hola (te preguntará dónde)',
        { parse_mode: 'HTML' },
      );
      return;
    }
    if (!alexaAnnouncer) {
      await bot.sendMessage(chatId, 'Anuncios Alexa no configurados.');
      return;
    }

    // Sin destino: guardar y mostrar keyboard. NUNCA hacemos broadcast por defecto.
    if (!parsed.target) {
      pendingAnnouncements.set(chatId, {
        message: parsed.message,
        expiresAt: Date.now() + ANNOUNCE_PENDING_TTL_MS,
      });
      await bot.sendMessage(
        chatId,
        `¿Dónde quieres anunciarlo?\n\n<i>${escapeHtml(parsed.message)}</i>`,
        { parse_mode: 'HTML', reply_markup: buildAnnounceKeyboard() },
      );
      return;
    }

    // Destino explícito: ejecutar inmediato con indicador.
    const indicator = await createThinkingIndicator(bot, chatId, {
      text: '📣 Enviando anuncio…',
      logger,
    });
    try {
      const result = await alexaAnnouncer.announce(parsed.message, { target: parsed.target });
      await indicator.finish(`📣 Anunciado en ${result.target} (${result.service}).`);
    } catch (error) {
      logger.warn({ chatId, err: error.message, target: parsed.target }, '/anuncia failed');
      await indicator.finish(`❌ No pude anunciar: ${error.message}`);
    }
  });

  // Handler de los botones inline del /anuncia. Telegram emite callback_query cuando el usuario
  // pulsa un botón; solo nos interesan los que llevan el prefijo "anuncia:".
  bot.on('callback_query', async (callbackQuery) => {
    try {
      const data = callbackQuery.data ?? '';
      if (!data.startsWith(ANNOUNCE_CALLBACK_PREFIX)) return;

      const chatId = callbackQuery.message?.chat?.id;
      const messageId = callbackQuery.message?.message_id;
      if (!chatId || !messageId) {
        await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
        return;
      }

      const choice = data.slice(ANNOUNCE_CALLBACK_PREFIX.length);
      const pending = pendingAnnouncements.get(chatId);

      if (!pending || pending.expiresAt < Date.now()) {
        pendingAnnouncements.delete(chatId);
        await bot.editMessageText('⌛ El anuncio expiró. Vuelve a escribir /anuncia.', {
          chat_id: chatId,
          message_id: messageId,
        }).catch(() => {});
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Expirado' }).catch(() => {});
        return;
      }

      if (choice === ANNOUNCE_CANCEL_CHOICE) {
        pendingAnnouncements.delete(chatId);
        await bot.editMessageText('❌ Anuncio cancelado.', {
          chat_id: chatId,
          message_id: messageId,
        }).catch(() => {});
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelado' }).catch(() => {});
        return;
      }

      pendingAnnouncements.delete(chatId);

      // Acuse de recibo del click (Telegram quita el "loading" en el botón).
      await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      await bot.editMessageText(`📣 Enviando anuncio a ${choice}…`, {
        chat_id: chatId,
        message_id: messageId,
      }).catch(() => {});

      try {
        const result = await alexaAnnouncer.announce(pending.message, { target: choice });
        await bot.editMessageText(
          `📣 Anunciado en ${result.target} (${result.service}).\n\n<i>${escapeHtml(pending.message)}</i>`,
          { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' },
        ).catch(() => {});
      } catch (error) {
        logger.warn({ chatId, err: error.message, target: choice }, '/anuncia callback failed');
        await bot.editMessageText(`❌ No pude anunciar: ${error.message}`, {
          chat_id: chatId,
          message_id: messageId,
        }).catch(() => {});
      }
    } catch (error) {
      logger.error({ err: error?.message }, 'callback_query handler crashed');
    }
  });

  /**
   * Runs a cluster query and returns an HTML-ready reply.
   *
   * @param {'status'|'history'} kind
   * @returns {Promise<string>}
   */
  async function buildClusterReply(kind) {
    if (kind === 'history') {
      const incidents = await clusterStatus.history();
      const body = formatClusterHistory(incidents).map(escapeHtml).join('\n');
      return `🖥️ <b>Cluster — últimas incidencias</b>\n<pre>${body}</pre>`;
    }
    const results = await clusterStatus.probe();
    const body = formatClusterStatus(results).map(escapeHtml).join('\n');
    const anyDown = results.some((r) => !r.ok);
    const header = anyDown ? '⚠️ <b>Cluster — hay servicios caídos</b>' : '✅ <b>Cluster — todo OK</b>';
    return `${header}\n<pre>${body}</pre>`;
  }

  router.register('/cluster', async (message) => {
    const chatId = message.chat.id;
    if (!clusterStatus) {
      await bot.sendMessage(chatId, '⚠️ Monitorización del cluster no configurada.');
      return;
    }
    const arg = extractArgs(message.text).toLowerCase();
    const kind = /^(history|historial|incidencias)/.test(arg) ? 'history' : 'status';
    const indicator = await createThinkingIndicator(bot, chatId, { text: '🖥️ Consultando el cluster…', logger });
    try {
      const reply = await buildClusterReply(kind);
      await indicator.finish(reply, { parse_mode: 'HTML' });
    } catch (error) {
      logger.warn({ chatId, err: error.message }, '/cluster failed');
      await indicator.finish(`❌ No pude consultar el cluster: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
    }
  });

  /**
   * Queries Prometheus and returns the HTML answer for the "is anything down?"
   * question. Shared by the `/caidos` command and the natural-language intent.
   *
   * @returns {Promise<string>}
   */
  async function buildPrometheusReply() {
    const report = await prometheusClient.getDownReport();
    return formatDownReport(report).html;
  }

  router.register('/caidos', async (message) => {
    const chatId = message.chat.id;
    if (!prometheusClient) {
      await bot.sendMessage(chatId, '⚠️ Integración con Prometheus no configurada.');
      return;
    }
    const indicator = await createThinkingIndicator(bot, chatId, { text: '📊 Consultando Prometheus…', logger });
    try {
      await indicator.finish(await buildPrometheusReply(), { parse_mode: 'HTML' });
    } catch (error) {
      logger.warn({ chatId, err: error.message }, '/caidos failed');
      await indicator.finish(`❌ No pude consultar Prometheus: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
    }
  });

  router.register('/correo', async (message) => {
    const chatId = message.chat.id;
    if (!gmailClient) {
      await bot.sendMessage(chatId, 'Gmail no configurado. Hay que ejecutar `luis google login` y configurar los paths.');
      return;
    }
    const args = extractArgs(message.text ?? '').trim();
    const indicator = await createThinkingIndicator(bot, chatId, { text: '📬 Consultando Gmail…', logger });
    try {
      const result = await dispatchEmailRequest(args, gmailClient);
      await indicator.finish(formatEmailReply(result), { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (error) {
      logger.warn({ chatId, err: error.message }, '/correo failed');
      await indicator.finish(`❌ No pude consultar el correo: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
    }
  });

  router.register('/agenda', async (message) => {
    const chatId = message.chat.id;
    if (!calendarClient) {
      await bot.sendMessage(chatId, 'Calendar no configurado. Hay que ejecutar `luis google login` primero.');
      return;
    }
    const args = extractArgs(message.text ?? '').trim().toLowerCase();
    const which = pickCalendarSlot(args);
    const indicator = await createThinkingIndicator(bot, chatId, { text: '🗓️ Consultando agenda…', logger });
    try {
      const reply = await runCalendarQuery(which, calendarClient);
      await indicator.finish(reply, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (error) {
      logger.warn({ chatId, err: error.message }, '/agenda failed');
      await indicator.finish(`❌ No pude consultar la agenda: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
    }
  });

  router.register('/drive', async (message) => {
    const chatId = message.chat.id;
    if (!driveClient) {
      await bot.sendMessage(chatId, 'Drive no configurado. Hay que ejecutar `luis google login` primero.');
      return;
    }
    const args = extractArgs(message.text ?? '').trim();
    const indicator = await createThinkingIndicator(bot, chatId, { text: '🗂️ Consultando Drive…', logger });
    try {
      const reply = await runDriveCommand(args, driveClient);
      await indicator.finish(reply, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (error) {
      logger.warn({ chatId, err: error.message }, '/drive failed');
      await indicator.finish(`❌ No pude consultar Drive: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
    }
  });

  router.register('/help', async (message) => {
    const chatId = message.chat.id;
    const text = [
      '<b>luis — Telegram</b>',
      '',
      'Escribe cualquier cosa y te respondo (mantengo el hilo de la conversación).',
      '',
      '<b>Comandos:</b>',
      '/fetch &lt;url&gt; — descargar URL al contexto',
      '/search &lt;query&gt; — buscar en la web',
      '/cluster [historial] — estado del cluster (n2/n3/n4) o sus incidencias',
      '/caidos — ¿hay algún servicio caído? (vía Prometheus)',
      '/ha &lt;texto&gt; — pedir algo a Home Assistant',
      '/anuncia &lt;destino&gt; &lt;texto&gt; — anuncio en Alexa (o sin destino para elegir)',
      '/correo [hoy|de &lt;persona&gt;] — correos no leídos de hoy o de un remitente',
      '/agenda [hoy|mañana|semana|próximo] — eventos del calendario',
      '/drive [buscar &lt;texto&gt;] — listar raíz o buscar en Drive (solo lectura)',
      '/reset — borrar la conversación',
      '/status — estado del asistente',
      '/llm_status — estado del LLM',
      '/downloads_rules — reglas de descarga',
      '/help — esta ayuda',
      '',
      '<i>También entiendo en lenguaje natural: "correos de hoy", "correos de banco", "agenda de hoy", "próxima reunión", etc.</i>',
    ].join('\n');
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  });

  router.setFallback(async (message) => {
    const chatId = message.chat.id;
    const text = (message.text ?? '').trim();
    if (!text) return;

    // Natural-language cluster queries ("estado del cluster", "status cluster")
    // are answered directly, without going through the LLM.
    if (clusterStatus) {
      const clusterIntent = parseClusterIntent(text);
      if (clusterIntent) {
        const indicator = await createThinkingIndicator(bot, chatId, { text: '🖥️ Consultando el cluster…', logger });
        try {
          const reply = await buildClusterReply(clusterIntent.kind);
          await indicator.finish(reply, { parse_mode: 'HTML' });
        } catch (error) {
          logger.warn({ chatId, err: error.message }, 'NL cluster query failed');
          await indicator.finish(`❌ No pude consultar el cluster: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
        }
        return;
      }
    }

    // Natural-language email queries ("correos de hoy", "correos de Banco")
    // are answered from Gmail without going through the LLM.
    if (gmailClient) {
      const emailIntent = parseEmailIntent(text);
      if (emailIntent) {
        const indicator = await createThinkingIndicator(bot, chatId, { text: '📬 Consultando Gmail…', logger });
        try {
          const result = await dispatchEmailIntent(emailIntent, gmailClient);
          await indicator.finish(formatEmailReply(result), { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (error) {
          logger.warn({ chatId, err: error.message }, 'email intent fallback failed');
          await indicator.finish(`❌ No pude consultar el correo: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
        }
        return;
      }
    }

    // Natural-language "is anything down?" queries are answered from Prometheus,
    // also without going through the LLM.
    if (prometheusClient) {
      const prometheusIntent = parsePrometheusIntent(text);
      if (prometheusIntent) {
        const indicator = await createThinkingIndicator(bot, chatId, { text: '📊 Consultando Prometheus…', logger });
        try {
          await indicator.finish(await buildPrometheusReply(), { parse_mode: 'HTML' });
        } catch (error) {
          logger.warn({ chatId, err: error.message }, 'NL prometheus query failed');
          await indicator.finish(`❌ No pude consultar Prometheus: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
        }
        return;
      }
    }

    // Natural-language calendar queries ("agenda de hoy", "qué tengo mañana")
    // are answered from Google Calendar without going through the LLM.
    if (calendarClient) {
      const calIntent = parseCalendarIntent(text);
      if (calIntent) {
        const indicator = await createThinkingIndicator(bot, chatId, { text: '🗓️ Consultando agenda…', logger });
        try {
          const reply = await runCalendarQuery(calIntent.intent, calendarClient);
          await indicator.finish(reply, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (error) {
          logger.warn({ chatId, err: error.message }, 'calendar intent fallback failed');
          await indicator.finish(`❌ No pude consultar la agenda: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
        }
        return;
      }
    }

    // Natural-language Drive queries ("busca facturas en drive", "qué hay en mi drive")
    // are answered from Google Drive without going through the LLM.
    if (driveClient) {
      const driveIntent = parseDriveIntent(text);
      if (driveIntent) {
        const indicator = await createThinkingIndicator(bot, chatId, { text: '🗂️ Consultando Drive…', logger });
        try {
          const args = driveIntent.kind === 'search' ? `buscar ${driveIntent.query}` : '';
          const reply = await runDriveCommand(args, driveClient);
          await indicator.finish(reply, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (error) {
          logger.warn({ chatId, err: error.message }, 'drive intent fallback failed');
          await indicator.finish(`❌ No pude consultar Drive: ${escapeHtml(error.message)}`, { parse_mode: 'HTML' });
        }
        return;
      }
    }

    const conversation = getConversation(chatId);
    conversation.appendUser(text);

    const indicator = await createThinkingIndicator(bot, chatId, { logger });

    try {
      await bot.sendChatAction(chatId, 'typing');
      const reply = await llmService.chat(conversation.snapshot(), {
        module: 'telegram',
        operation: 'chat',
        private: true,
      });
      conversation.appendAssistant(reply);
      await indicator.finish(reply || '(sin respuesta)');
    } catch (error) {
      logger.warn({ chatId, err: error.message }, 'Telegram chat turn failed');
      await indicator.finish('❌ El LLM no respondió. Inténtalo de nuevo en un momento.');
    }
  });
}

/**
 * Escapes a string for safe inclusion inside Telegram's HTML parse mode.
 *
 * @param {string} input
 * @returns {string}
 */
function escapeHtml(input) {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Routes the argument string of `/correo` to the right Gmail call.
 *
 *   ""                  → unread today
 *   "hoy" / "today"     → unread today
 *   "de <persona>"      → from sender
 *   "from <persona>"    → from sender
 *   "<persona>"         → from sender (resto del texto como remitente)
 *
 * @param {string} args
 * @param {import('../../modules/email/gmail-client.js').GmailClient} client
 * @returns {Promise<{ kind: 'today' | 'from', sender?: string, emails: import('../../modules/email/gmail-client.js').EmailSummary[] }>}
 */
async function dispatchEmailRequest(args, client) {
  const trimmed = args.trim();
  if (!trimmed || /^(?:hoy|today|pendientes?)$/i.test(trimmed)) {
    return { kind: 'today', emails: await client.unreadToday() };
  }
  const fromMatch = trimmed.match(/^(?:de|from)\s+(.+)$/i);
  const sender = fromMatch ? fromMatch[1].trim() : trimmed;
  return { kind: 'from', sender, emails: await client.fromSender({ sender }) };
}

/**
 * Variant of dispatchEmailRequest that accepts the typed intent from parseEmailIntent.
 *
 * @param {import('../../modules/email/email-intent.js').EmailIntent} intent
 * @param {import('../../modules/email/gmail-client.js').GmailClient} client
 */
async function dispatchEmailIntent(intent, client) {
  if (intent.intent === 'today') {
    return { kind: 'today', emails: await client.unreadToday() };
  }
  return { kind: 'from', sender: intent.sender, emails: await client.fromSender({ sender: intent.sender }) };
}

/**
 * Renders the result of dispatchEmailRequest as Telegram-friendly HTML.
 *
 * @param {{ kind: 'today' | 'from', sender?: string, emails: import('../../modules/email/gmail-client.js').EmailSummary[] }} result
 * @returns {string}
 */
function formatEmailReply(result) {
  if (result.emails.length === 0) {
    return result.kind === 'today'
      ? '📭 No tienes correos no leídos de hoy.'
      : `📭 No encuentro correos de "${escapeHtml(result.sender ?? '')}".`;
  }
  const heading = result.kind === 'today'
    ? `📬 <b>${result.emails.length} correo${result.emails.length === 1 ? '' : 's'} no leído${result.emails.length === 1 ? '' : 's'}:</b>`
    : `📬 <b>${result.emails.length} correo${result.emails.length === 1 ? '' : 's'} de "${escapeHtml(result.sender ?? '')}":</b>`;
  const lines = result.emails.map((email, i) => {
    const subject = escapeHtml(email.subject || '(sin asunto)');
    const from = escapeHtml(email.from || '(desconocido)');
    const snippet = escapeHtml(email.snippet || '');
    return `${i + 1}. <b>${subject}</b>\n   <i>${from}</i>${snippet ? `\n   ${snippet}` : ''}`;
  });
  return `${heading}\n\n${lines.join('\n\n')}`;
}

/**
 * Maps the textual argument of `/agenda` (e.g. "hoy", "mañana") to a `CalendarIntent['intent']`.
 *
 * @param {string} args
 * @returns {'today' | 'tomorrow' | 'week' | 'next'}
 */
function pickCalendarSlot(args) {
  if (!args || /^(?:hoy|today)$/.test(args)) return 'today';
  if (/^(?:manana|mañana|tomorrow)$/.test(args)) return 'tomorrow';
  if (/(?:semana|week)/.test(args)) return 'week';
  if (/(?:proxim[oa]|siguiente|next)/.test(args)) return 'next';
  return 'today';
}

/**
 * Renders the calendar reply in Telegram HTML for the chosen slot.
 *
 * @param {'today' | 'tomorrow' | 'week' | 'next'} which
 * @param {import('../../modules/calendar/google-calendar-client.js').GoogleCalendarClient} client
 * @returns {Promise<string>}
 */
async function runCalendarQuery(which, client) {
  if (which === 'next') {
    const event = await client.next();
    if (!event) return '🗓️ No tienes eventos próximos en los siguientes 30 días.';
    return `🗓️ <b>Próximo evento:</b>\n\n${formatEventTelegram(event)}`;
  }
  const events = await client[which]();
  const labels = { today: 'hoy', tomorrow: 'mañana', week: 'esta semana' };
  if (events.length === 0) return `🗓️ No tienes eventos ${labels[which]}.`;
  const heading = `🗓️ <b>${events.length} evento${events.length === 1 ? '' : 's'} ${labels[which]}:</b>`;
  const items = events.map((e, i) => `${i + 1}. ${formatEventTelegram(e)}`).join('\n\n');
  return `${heading}\n\n${items}`;
}

/**
 * Formatea un evento como HTML compacto para Telegram.
 *
 * @param {import('../../modules/calendar/google-calendar-client.js').CalendarEvent} event
 * @returns {string}
 */
function formatEventTelegram(event) {
  const title = `<b>${escapeHtml(event.summary)}</b>`;
  const when = `🕐 ${escapeHtml(formatEventTimeShort(event))}`;
  const lines = [title, when];
  if (event.location) lines.push(`📍 ${escapeHtml(event.location)}`);
  if (event.attendees.length > 0) {
    const sample = event.attendees.slice(0, 3).join(', ');
    const more = event.attendees.length > 3 ? ` (+${event.attendees.length - 3})` : '';
    lines.push(`👥 ${escapeHtml(sample)}${more}`);
  }
  return lines.join('\n');
}

/**
 * @param {import('../../modules/calendar/google-calendar-client.js').CalendarEvent} event
 * @returns {string}
 */
function formatEventTimeShort(event) {
  if (event.allDay) return `${event.start} (todo el día)`;
  try {
    const start = new Date(event.start);
    const end = event.end ? new Date(event.end) : null;
    const dayFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: '2-digit', month: 'short' });
    const timeFmt = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
    const dayPart = dayFmt.format(start);
    const startTime = timeFmt.format(start);
    const endTime = end ? timeFmt.format(end) : '';
    return `${dayPart} ${startTime}${endTime ? `–${endTime}` : ''}`;
  } catch {
    return event.start;
  }
}

/**
 * Routes the argument string of `/drive` to the right Drive call.
 * Supports: empty/no args → list root; "buscar X" → search by name.
 *
 * @param {string} args
 * @param {import('../../modules/drive/google-drive-client.js').GoogleDriveClient} client
 * @returns {Promise<string>}
 */
async function runDriveCommand(args, client) {
  const trimmed = (args ?? '').trim();
  const searchMatch = trimmed.match(/^(?:buscar|search)\s+(.+)$/i);
  let items;
  let heading;
  if (searchMatch) {
    const query = searchMatch[1].trim();
    items = await client.searchByName(query);
    if (items.length === 0) return `🗂️ Sin resultados en Drive para "<i>${escapeHtml(query)}</i>".`;
    heading = `🗂️ <b>${items.length} resultado${items.length === 1 ? '' : 's'} para "${escapeHtml(query)}":</b>`;
  } else if (!trimmed || /^(?:listar|list|raiz|root)$/i.test(trimmed)) {
    items = await client.listFolder();
    if (items.length === 0) return '🗂️ Tu Drive raíz está vacío.';
    heading = `🗂️ <b>${items.length} elemento${items.length === 1 ? '' : 's'} en la raíz de tu Drive:</b>`;
  } else {
    // Fallback: tratarlo como folder ID literal
    items = await client.listFolder(trimmed);
    if (items.length === 0) return `🗂️ (carpeta <code>${escapeHtml(trimmed)}</code> vacía)`;
    heading = `🗂️ <b>${items.length} elemento${items.length === 1 ? '' : 's'} en la carpeta:</b>`;
  }
  const lines = items.slice(0, 20).map((it) => {
    const icon = it.isFolder ? '📁' : '📄';
    const name = escapeHtml(it.name);
    return it.webViewLink
      ? `${icon} <a href="${it.webViewLink}">${name}</a>`
      : `${icon} ${name}`;
  });
  const more = items.length > 20 ? `\n\n<i>(…+${items.length - 20} más, refina la búsqueda)</i>` : '';
  return `${heading}\n\n${lines.join('\n')}${more}`;
}

/**
 * Builds the inline keyboard shown by /anuncia when no destination was specified.
 * Layout: 2 columns × 4 rows of destinations + a Cancel row at the bottom.
 *
 * @returns {{ inline_keyboard: Array<Array<{ text: string, callback_data: string }>> }}
 */
function buildAnnounceKeyboard() {
  const choices = listTargetChoices();
  const rows = [];
  for (let i = 0; i < choices.length; i += 2) {
    const left = choices[i];
    const right = choices[i + 1];
    const row = [{ text: `${left.emoji} ${left.label}`, callback_data: `${ANNOUNCE_CALLBACK_PREFIX}${left.alias}` }];
    if (right) row.push({ text: `${right.emoji} ${right.label}`, callback_data: `${ANNOUNCE_CALLBACK_PREFIX}${right.alias}` });
    rows.push(row);
  }
  rows.push([{ text: '❌ Cancelar', callback_data: `${ANNOUNCE_CALLBACK_PREFIX}${ANNOUNCE_CANCEL_CHOICE}` }]);
  return { inline_keyboard: rows };
}

