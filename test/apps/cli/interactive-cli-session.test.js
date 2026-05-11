import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { createInteractiveCliSession } from '../../../src/apps/cli/interactive-cli-session.js';

/**
 * Builds a renderer that captures writes for assertions.
 *
 * @returns {import('../../../src/apps/cli/terminal-renderer.js').TerminalRenderer & { _output: string[], _errors: string[] }}
 */
function makeRenderer() {
  /** @type {string[]} */
  const output = [];
  /** @type {string[]} */
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
function makeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/**
 * Builds a readable stream that emits the given lines, each followed by a newline.
 *
 * @param {string[]} lines
 * @returns {Readable}
 */
function makeInput(lines) {
  return Readable.from(lines.map((line) => `${line}\n`));
}

describe('interactive-cli-session', () => {
  it('exit word terminates the session cleanly', async () => {
    const renderer = makeRenderer();
    const session = createInteractiveCliSession({
      llmService: {
        generateText: async () => 'unused',
        checkHealth: async () => ({ healthy: true, provider: 'local', model: 'm' }),
      },
      renderer,
      logger: makeLogger(),
      appName: 'assistant',
      appVersion: 'test',
      llmProvider: 'local',
      input: makeInput(['exit']),
      output: new PassThrough(),
    });

    const exitCode = await session.start();

    assert.equal(exitCode, 0);
  });

  it('passes the user prompt to llmService.chat with module=cli', async () => {
    /** @type {{ messages: any, options: any }} */
    const captured = { messages: null, options: null };
    const renderer = makeRenderer();
    const session = createInteractiveCliSession({
      llmService: {
        generateText: async () => 'unused',
        chat: async (messages, options) => {
          captured.messages = messages;
          captured.options = options;
          return 'pong';
        },
        checkHealth: async () => ({ healthy: true, provider: 'local', model: 'm' }),
      },
      renderer,
      logger: makeLogger(),
      appName: 'assistant',
      appVersion: 'test',
      llmProvider: 'local',
      input: makeInput(['ping', 'exit']),
      output: new PassThrough(),
    });

    await session.start();

    const lastUserMessage = captured.messages?.find((m) => m.role === 'user');
    assert.equal(lastUserMessage?.content, 'ping');
    assert.equal(captured.options?.module, 'cli');
    assert.equal(captured.options?.operation, 'interactive');
    assert.equal(captured.options?.private, true);
    assert.ok(renderer._output.includes('pong'), 'expected response printed');
  });

  it('survives an LLM failure and continues to the next turn', async () => {
    let calls = 0;
    const renderer = makeRenderer();
    const session = createInteractiveCliSession({
      llmService: {
        generateText: async () => 'unused',
        chat: async () => {
          calls += 1;
          if (calls === 1) throw new Error('ECONNREFUSED');
          return 'recovered';
        },
        checkHealth: async () => ({ healthy: true, provider: 'local', model: 'm' }),
      },
      renderer,
      logger: makeLogger(),
      appName: 'assistant',
      appVersion: 'test',
      llmProvider: 'local',
      input: makeInput(['hello', 'hello again', 'exit']),
      output: new PassThrough(),
    });

    const exitCode = await session.start();

    assert.equal(exitCode, 0);
    assert.equal(calls, 2, 'second turn should still execute after first error');
    assert.ok(
      renderer._errors.some((line) => line.toLowerCase().includes('not reachable') || line.toLowerCase().includes('econnrefused')),
      'expected a controlled error message for connection refusal'
    );
    assert.ok(renderer._output.includes('recovered'), 'expected recovery response printed');
  });

  it('handles slash commands without sending them to the LLM', async () => {
    let chatCalls = 0;
    const renderer = makeRenderer();
    const session = createInteractiveCliSession({
      llmService: {
        generateText: async () => 'unused',
        chat: async () => { chatCalls += 1; return 'should-not-be-called'; },
        checkHealth: async () => ({ healthy: true, provider: 'local', model: 'm' }),
      },
      renderer,
      logger: makeLogger(),
      appName: 'assistant',
      appVersion: 'test',
      llmProvider: 'local',
      input: makeInput(['/help', '/reset', 'exit']),
      output: new PassThrough(),
    });

    await session.start();

    assert.equal(chatCalls, 0, 'slash commands must not invoke the LLM');
    assert.ok(
      renderer._output.some((line) => line.includes('Available slash commands') || line.includes('/help')),
      'expected /help output'
    );
  });
});
