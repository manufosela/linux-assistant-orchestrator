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

  describe('aliases', () => {
    it('resolves /guardar as /guarda when alias is registered', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      let calledWith = null;
      router.register('/guarda', async (msg) => { calledWith = msg.text; });
      router.registerAlias('/guardar', '/guarda');

      await router.route({ chat: { id: '123' }, text: '/guardar https://example.com' });

      assert.equal(calledWith, '/guardar https://example.com');
    });

    it('alias resolves case-insensitively', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      let called = false;
      router.register('/resumir', async () => { called = true; });
      router.registerAlias('/resume', '/resumir');

      await router.route({ chat: { id: '123' }, text: '/RESUME abc' });

      assert.equal(called, true);
    });

    it('rejects alias without leading slash', () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy([]);
      const router = createTelegramCommandRouter(policy, logger);

      assert.throws(() => router.registerAlias('guardar', '/guarda'), /must start with \//);
    });

    it('rejects alias that is already a registered command', () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy([]);
      const router = createTelegramCommandRouter(policy, logger);

      router.register('/guarda', async () => {});
      assert.throws(() => router.registerAlias('/guarda', '/guardar'), /already a registered command/);
    });

    it('listAliases returns the registered aliases', () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy([]);
      const router = createTelegramCommandRouter(policy, logger);

      router.register('/guarda', async () => {});
      router.register('/resumir', async () => {});
      router.registerAlias('/guardar', '/guarda');
      router.registerAlias('/resume', '/resumir');

      const list = router.listAliases();
      assert.equal(list.length, 2);
      assert.ok(list.some((a) => a.alias === '/guardar' && a.canonical === '/guarda'));
      assert.ok(list.some((a) => a.alias === '/resume' && a.canonical === '/resumir'));
    });
  });

  describe('unknown command handler', () => {
    it('invokes setUnknownCommandHandler with the typed command', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      let captured = null;
      router.setUnknownCommandHandler(async (msg, cmd) => { captured = { chatId: msg.chat.id, cmd }; });

      await router.route({ chat: { id: '123' }, text: '/pepito arg1' });

      assert.deepEqual(captured, { chatId: '123', cmd: '/pepito' });
    });

    it('does not invoke unknown handler for known canonical commands', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      let unknownCalled = false;
      router.register('/status', async () => {});
      router.setUnknownCommandHandler(async () => { unknownCalled = true; });

      await router.route({ chat: { id: '123' }, text: '/status' });

      assert.equal(unknownCalled, false);
    });

    it('does not invoke unknown handler for aliased commands', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      let unknownCalled = false;
      let canonicalCalled = false;
      router.register('/guarda', async () => { canonicalCalled = true; });
      router.registerAlias('/guardar', '/guarda');
      router.setUnknownCommandHandler(async () => { unknownCalled = true; });

      await router.route({ chat: { id: '123' }, text: '/guardar url' });

      assert.equal(canonicalCalled, true);
      assert.equal(unknownCalled, false);
    });

    it('does not invoke unknown handler for non-command messages (goes to fallback)', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      let unknownCalled = false;
      let fallbackCalled = false;
      router.setUnknownCommandHandler(async () => { unknownCalled = true; });
      router.setFallback(async () => { fallbackCalled = true; });

      await router.route({ chat: { id: '123' }, text: 'hola, qué tal' });

      assert.equal(unknownCalled, false);
      assert.equal(fallbackCalled, true);
    });

    it('stays silent if no unknown handler is registered (preserves historical behaviour)', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      await assert.doesNotReject(() =>
        router.route({ chat: { id: '123' }, text: '/pepito' })
      );
    });

    it('logs error but does not throw if unknown handler throws', async () => {
      const logger = makeLogger();
      const policy = makeAllowedChatPolicy(['123']);
      const router = createTelegramCommandRouter(policy, logger);

      router.setUnknownCommandHandler(async () => { throw new Error('boom'); });

      await assert.doesNotReject(() =>
        router.route({ chat: { id: '123' }, text: '/pepito' })
      );
    });
  });
});
