import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationManager } from '../../../src/apps/cli/conversation-manager.js';
import { createSlashCommandRegistry, registerDefaultSlashCommands } from '../../../src/apps/cli/slash-commands.js';

/**
 * @returns {import('../../../src/apps/cli/terminal-renderer.js').TerminalRenderer & { _output: string[], _errors: string[] }}
 */
function makeRenderer() {
  const output = [];
  const errors = [];
  return {
    print: (text = '') => output.push(text),
    header: () => {},
    info: (text) => output.push(`info:${text}`),
    success: (text) => output.push(`ok:${text}`),
    warning: (text) => output.push(`warn:${text}`),
    error: (text) => errors.push(text),
    promptString: () => '> ',
    renderStatus: () => {},
    renderLlmStatus: () => {},
    renderRules: () => {},
    _output: output,
    _errors: errors,
  };
}

/**
 * @returns {object}
 */
function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe('slash commands', () => {
  it('isSlashCommand recognises /command lines', () => {
    const registry = createSlashCommandRegistry({
      conversation: createConversationManager({ systemPrompt: 'sys' }),
      renderer: makeRenderer(),
      sessionState: { model: '' },
      logger: silentLogger(),
    });
    assert.equal(registry.isSlashCommand('/help'), true);
    assert.equal(registry.isSlashCommand('  /fetch https://x'), true);
    assert.equal(registry.isSlashCommand('hola'), false);
    assert.equal(registry.isSlashCommand('/'), false);
  });

  it('/help lists all registered commands', async () => {
    const renderer = makeRenderer();
    const conversation = createConversationManager({ systemPrompt: 'sys' });
    const registry = createSlashCommandRegistry({
      conversation,
      renderer,
      sessionState: { model: '' },
      logger: silentLogger(),
    });
    registerDefaultSlashCommands(registry);

    await registry.execute('/help');

    const helpText = renderer._output.join('\n');
    assert.match(helpText, /\/fetch/);
    assert.match(helpText, /\/search/);
    assert.match(helpText, /\/reset/);
    assert.match(helpText, /\/model/);
  });

  it('/reset clears the conversation history but keeps the system prompt', async () => {
    const conversation = createConversationManager({ systemPrompt: 'sys' });
    conversation.appendUser('hello');
    conversation.appendAssistant('hi');
    assert.equal(conversation.size(), 3);

    const registry = createSlashCommandRegistry({
      conversation,
      renderer: makeRenderer(),
      sessionState: { model: '' },
      logger: silentLogger(),
    });
    registerDefaultSlashCommands(registry);

    await registry.execute('/reset');

    assert.equal(conversation.size(), 1);
    assert.equal(conversation.snapshot()[0].role, 'system');
  });

  it('/model sets a per-session model override', async () => {
    const sessionState = { model: '' };
    const registry = createSlashCommandRegistry({
      conversation: createConversationManager({ systemPrompt: 'sys' }),
      renderer: makeRenderer(),
      sessionState,
      logger: silentLogger(),
    });
    registerDefaultSlashCommands(registry);

    await registry.execute('/model qwen2.5-coder:1.5b');

    assert.equal(sessionState.model, 'qwen2.5-coder:1.5b');
  });

  it('/fetch <url> downloads, appends context and confirms', async () => {
    let captured = null;
    const urlFetcher = {
      fetchUrl: async (url) => {
        captured = url;
        return { url, title: 'Hello', text: 'BODY TEXT', contentType: 'text/html', bytes: 9 };
      },
    };
    const renderer = makeRenderer();
    const conversation = createConversationManager({ systemPrompt: 'sys' });
    const registry = createSlashCommandRegistry({
      conversation,
      renderer,
      urlFetcher,
      sessionState: { model: '' },
      logger: silentLogger(),
    });
    registerDefaultSlashCommands(registry);

    await registry.execute('/fetch https://example.com');

    assert.equal(captured, 'https://example.com');
    const messages = conversation.snapshot();
    const contextMessage = messages.find((m) => m.content.includes('BODY TEXT'));
    assert.ok(contextMessage, 'fetched body should be in conversation context');
    assert.ok(renderer._output.some((line) => line.toLowerCase().includes('added')), 'success message expected');
  });

  it('/fetch without URL prints usage and does not call the fetcher', async () => {
    let calls = 0;
    const renderer = makeRenderer();
    const registry = createSlashCommandRegistry({
      conversation: createConversationManager({ systemPrompt: 'sys' }),
      renderer,
      urlFetcher: { fetchUrl: async () => { calls += 1; return null; } },
      sessionState: { model: '' },
      logger: silentLogger(),
    });
    registerDefaultSlashCommands(registry);

    await registry.execute('/fetch');

    assert.equal(calls, 0);
    assert.ok(renderer._errors.some((line) => line.toLowerCase().includes('usage')));
  });

  it('/search <query> calls webSearch.search and adds results to context', async () => {
    let captured = null;
    const webSearch = {
      search: async (query) => {
        captured = query;
        return [
          { title: 'A', url: 'https://a', snippet: 'sa', engine: 'duck' },
          { title: 'B', url: 'https://b', snippet: 'sb', engine: 'bing' },
        ];
      },
      checkHealth: async () => true,
    };
    const renderer = makeRenderer();
    const conversation = createConversationManager({ systemPrompt: 'sys' });
    const registry = createSlashCommandRegistry({
      conversation,
      renderer,
      webSearch,
      sessionState: { model: '' },
      logger: silentLogger(),
    });
    registerDefaultSlashCommands(registry);

    await registry.execute('/search astro framework');

    assert.equal(captured, 'astro framework');
    const messages = conversation.snapshot();
    const contextMessage = messages.find((m) => m.content.includes('https://a'));
    assert.ok(contextMessage, 'search results should be in conversation context');
  });

  it('unknown slash commands report an error and do not crash', async () => {
    const renderer = makeRenderer();
    const registry = createSlashCommandRegistry({
      conversation: createConversationManager({ systemPrompt: 'sys' }),
      renderer,
      sessionState: { model: '' },
      logger: silentLogger(),
    });
    registerDefaultSlashCommands(registry);

    const result = await registry.execute('/banana');

    assert.equal(result.handled, true);
    assert.ok(renderer._errors.some((line) => line.toLowerCase().includes('unknown')));
  });

  it('handler exceptions are caught and rendered, session continues', async () => {
    const renderer = makeRenderer();
    const registry = createSlashCommandRegistry({
      conversation: createConversationManager({ systemPrompt: 'sys' }),
      renderer,
      urlFetcher: { fetchUrl: async () => { throw new Error('fetch failed'); } },
      sessionState: { model: '' },
      logger: silentLogger(),
    });
    registerDefaultSlashCommands(registry);

    await registry.execute('/fetch https://x');

    assert.ok(renderer._errors.some((line) => line.toLowerCase().includes('failed')));
  });
});

describe('conversation manager', () => {
  it('appendUser and appendAssistant grow the history', () => {
    const conversation = createConversationManager({ systemPrompt: 'sys' });
    conversation.appendUser('hi');
    conversation.appendAssistant('hello');
    assert.equal(conversation.size(), 3);
  });

  it('appendContext adds a tagged user message + ack', () => {
    const conversation = createConversationManager({ systemPrompt: 'sys' });
    conversation.appendContext('label', 'body');
    const messages = conversation.snapshot();
    assert.equal(messages.length, 3);
    assert.match(messages[1].content, /\[CONTEXT: label\]/);
    assert.match(messages[1].content, /body/);
    assert.equal(messages[2].role, 'assistant');
  });

  it('reset removes everything but the system prompt', () => {
    const conversation = createConversationManager({ systemPrompt: 'sys' });
    conversation.appendUser('a');
    conversation.appendAssistant('b');
    conversation.reset();
    assert.equal(conversation.size(), 1);
    assert.equal(conversation.snapshot()[0].role, 'system');
  });
});
