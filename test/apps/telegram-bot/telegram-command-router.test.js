import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramCommandRouter } from '../../../src/apps/telegram-bot/telegram-command-router.js';

/** @returns {object} */
function makeLogger() {
  const warnings = [];
  const debugs = [];
  return {
    info: () => {},
    warn: (obj) => warnings.push(obj),
    error: () => {},
    debug: (obj) => debugs.push(obj),
    _warnings: warnings,
    _debugs: debugs,
  };
}

/**
 * Creates a mock allowed-chat policy.
 *
 * @param {string[]} allowedIds
 * @returns {object}
 */
function makeAllowedChatPolicy(allowedIds) {
  const warnings = [];
  return {
    isAllowed: (id) => allowedIds.includes(String(id)),
    validate: (id) => {
      const allowed = allowedIds.includes(String(id));
      if (!allowed) warnings.push({ chatId: id });
      return allowed;
    },
    getAllowedCount: () => allowedIds.length,
    _warnings: warnings,
  };
}

describe('telegram-command-router', () => {
  describe('route', () => {
    it('calls the registered handler for a known command', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      let handlerCalled = false;
      router.register('/status', async () => { handlerCalled = true; });

      await router.route({ chat: { id: '123' }, text: '/status' });

      assert.equal(handlerCalled, true);
    });

    it('rejects messages from unauthorised chat IDs', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      let handlerCalled = false;
      router.register('/status', async () => { handlerCalled = true; });

      await router.route({ chat: { id: '999' }, text: '/status' });

      assert.equal(handlerCalled, false);
      assert.equal(policy._warnings.length, 1, 'Should log a warning for rejected chat');
    });

    it('ignores non-command messages from authorised chats', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      let handlerCalled = false;
      router.register('/status', async () => { handlerCalled = true; });

      await router.route({ chat: { id: '123' }, text: 'Hello, how are you?' });

      assert.equal(handlerCalled, false);
    });

    it('routes commands case-insensitively', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      let handlerCalled = false;
      router.register('/status', async () => { handlerCalled = true; });

      await router.route({ chat: { id: '123' }, text: '/STATUS' });

      assert.equal(handlerCalled, true);
    });

    it('strips @botname suffix from commands', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      let handlerCalled = false;
      router.register('/status', async () => { handlerCalled = true; });

      await router.route({ chat: { id: '123' }, text: '/status@mybot' });

      assert.equal(handlerCalled, true);
    });

    it('does not throw when an unknown command is received', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      await assert.doesNotReject(() =>
        router.route({ chat: { id: '123' }, text: '/unknown_command' })
      );
    });
  });

  describe('listCommands', () => {
    it('returns all registered commands sorted', () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy([]);
      const router = createTelegramCommandRouter(policy, logger);

      router.register('/status', async () => {});
      router.register('/help', async () => {});
      router.register('/downloads-rules', async () => {});

      const commands = router.listCommands();

      assert.deepEqual(commands, ['/downloads-rules', '/help', '/status']);
    });
  });
});
