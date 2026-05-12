import { createConversationManager } from '../cli/conversation-manager.js';
import { createThinkingIndicator } from './thinking-indicator.js';

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
 * @param {import('../../apps/telegram-bot/telegram-command-router.js').TelegramCommandRouter} deps.router
 * @param {import('pino').Logger} deps.logger
 * @returns {void}
 */
export function registerTelegramHandlers({ bot, statusService, rulesRepository, llmService, urlFetcher, webSearch, homeAssistant, alexaAnnouncer, router, logger }) {
  /** @type {Map<number|string, import('../cli/conversation-manager.js').ConversationManager>} */
  const conversationsByChat = new Map();
  /** @type {Map<number|string, string>} */
  const haConversationByChat = new Map();

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
    const parsed = parseAnnounceArgs(raw);

    if (!parsed.message) {
      await bot.sendMessage(
        chatId,
        'Uso: /anuncia [--en &lt;salon|dormitorio|cocina|show|pop|pueblo|casa|firetv&gt;] &lt;mensaje&gt;',
        { parse_mode: 'HTML' },
      );
      return;
    }
    if (!alexaAnnouncer) {
      await bot.sendMessage(chatId, 'Anuncios Alexa no configurados.');
      return;
    }

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
      '/ha &lt;texto&gt; — pedir algo a Home Assistant',
      '/anuncia [--en &lt;destino&gt;] &lt;texto&gt; — anuncio hablado en Alexa',
      '/reset — borrar la conversación',
      '/status — estado del asistente',
      '/llm_status — estado del LLM',
      '/downloads_rules — reglas de descarga',
      '/help — esta ayuda',
    ].join('\n');
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  });

  router.setFallback(async (message) => {
    const chatId = message.chat.id;
    const text = (message.text ?? '').trim();
    if (!text) return;

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
 * Parses the argument string of `/anuncia` into `{ target, message }`.
 *
 * Supported syntaxes:
 *   /anuncia mensaje completo aqui                  → broadcast a casa
 *   /anuncia --en salon mensaje                     → solo al salón
 *   /anuncia --to dormitorio mensaje                → alias en inglés
 *
 * The flag must come before the message text. Quotes around the message are not required.
 *
 * @param {string} raw - everything after the `/anuncia` token
 * @returns {{ target: string | undefined, message: string }}
 */
function parseAnnounceArgs(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { target: undefined, message: '' };
  const flagMatch = text.match(/^--(?:en|to|target)\s+(\S+)\s+([\s\S]+)$/);
  if (flagMatch) {
    return { target: flagMatch[1], message: flagMatch[2].trim() };
  }
  return { target: undefined, message: text };
}
