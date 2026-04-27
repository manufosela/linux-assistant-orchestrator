/**
 * Creates the Telegram message handler that builds and registers all command handlers.
 *
 * @param {object} deps
 * @param {object} deps.bot - node-telegram-bot-api instance
 * @param {import('../../modules/assistant/assistant-status-service.js').AssistantStatusService} deps.statusService
 * @param {import('../../modules/downloads/download-rules-repository.js').DownloadRulesRepository} deps.rulesRepository
 * @param {import('../../modules/llm/llm-service.js').LlmService} deps.llmService
 * @param {import('../../apps/telegram-bot/telegram-command-router.js').TelegramCommandRouter} deps.router
 * @param {import('pino').Logger} deps.logger
 * @returns {void}
 */
export function registerTelegramHandlers({ bot, statusService, rulesRepository, llmService, router, logger }) {
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
      `Started: ${status.startedAt}`,
      `Environment: ${status.environment}`,
      ``,
      `<b>Modules:</b>`,
      moduleLines,
    ].join('\n');

    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    logger.debug({ chatId }, '/status command handled');
  });

  router.register('/downloads-rules', async (message) => {
    const chatId = message.chat.id;

    try {
      const rules = await rulesRepository.loadRules();

      if (rules.length === 0) {
        await bot.sendMessage(chatId, 'No download rules configured.', { parse_mode: 'HTML' });
        return;
      }

      const lines = rules.map((rule, i) => {
        const exts = rule.extensions.join(', ');
        return `${i + 1}. <b>${rule.name}</b>\n   Extensions: ${exts}\n   Target: <code>${rule.targetPath}</code>`;
      });

      const text = `<b>Download Rules (${rules.length}):</b>\n\n${lines.join('\n\n')}`;
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (error) {
      logger.error({ chatId, err: error.message }, '/downloads-rules failed');
      await bot.sendMessage(chatId, 'Failed to load download rules. Check the logs.');
    }

    logger.debug({ chatId }, '/downloads-rules command handled');
  });

  router.register('/llm-status', async (message) => {
    const chatId = message.chat.id;

    await bot.sendMessage(chatId, 'Checking LLM provider...');

    try {
      const healthStatus = await llmService.checkHealth();

      const icon = healthStatus.healthy ? '✅' : '❌';
      const lines = [
        `${icon} <b>LLM Provider: ${healthStatus.provider}</b>`,
        `Model: ${healthStatus.model || '(not configured)'}`,
      ];

      if (healthStatus.baseUrl) {
        lines.push(`Endpoint: <code>${healthStatus.baseUrl}</code>`);
      }

      if (!healthStatus.healthy) {
        lines.push(`\n⚠️ Provider is not reachable. Check your LOCAL_LLM_BASE_URL and model configuration.`);
      }

      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
    } catch (error) {
      logger.error({ chatId, err: error.message }, '/llm-status failed');
      await bot.sendMessage(chatId, `LLM status check failed: ${error.message}`);
    }

    logger.debug({ chatId }, '/llm-status command handled');
  });

  router.register('/help', async (message) => {
    const chatId = message.chat.id;
    const commands = router.listCommands();

    const commandDescriptions = {
      '/status': 'Show assistant status, uptime, and enabled modules',
      '/downloads-rules': 'List configured file organisation rules',
      '/llm-status': 'Check whether the local LLM provider is reachable',
      '/help': 'Show this help message',
    };

    const lines = commands.map((cmd) => {
      const description = commandDescriptions[cmd] ?? 'No description available';
      return `${cmd} — ${description}`;
    });

    const text = `<b>Available Commands:</b>\n\n${lines.join('\n')}`;
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    logger.debug({ chatId }, '/help command handled');
  });
}
