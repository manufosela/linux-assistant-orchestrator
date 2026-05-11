import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCliCommandRouter } from '../../../src/apps/cli/cli-command-router.js';

/**
 * Builds an in-memory renderer that captures every output for assertions.
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
    info: (text) => output.push(text),
    success: (text) => output.push(text),
    warning: (text) => output.push(text),
    error: (text) => errors.push(text),
    promptString: () => '> ',
    renderStatus: (status) => output.push(`status:${status.name}`),
    renderLlmStatus: (health) => output.push(`llm:${health.provider}:${health.healthy ? 'ok' : 'fail'}`),
    renderRules: (rules) => output.push(`rules:${rules.length}`),
    _output: output,
    _errors: errors,
  };
}

/**
 * Returns a no-op pino-like logger.
 *
 * @returns {object}
 */
function makeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe('cli-command-router', () => {
  it('routes a single-token command to its handler', async () => {
    const renderer = makeRenderer();
    const router = createCliCommandRouter({ renderer, logger: makeLogger() });
    let called = false;
    router.register('status', async () => { called = true; });

    const exit = await router.route(['status']);

    assert.equal(exit, 0);
    assert.equal(called, true);
  });

  it('routes multi-token commands to the longest matching path', async () => {
    const renderer = makeRenderer();
    const router = createCliCommandRouter({ renderer, logger: makeLogger() });
    let calledStatus = false;
    let calledLlmStatus = false;
    router.register('status', async () => { calledStatus = true; });
    router.register('llm status', async () => { calledLlmStatus = true; });

    await router.route(['llm', 'status']);

    assert.equal(calledLlmStatus, true);
    assert.equal(calledStatus, false);
  });

  it('passes positional args and parsed flags to the handler', async () => {
    const renderer = makeRenderer();
    const router = createCliCommandRouter({ renderer, logger: makeLogger() });
    /** @type {{ args: string[], flags: Record<string, string|boolean> } | null} */
    let received = null;
    router.register('code', async ({ args, flags }) => { received = { args, flags }; });

    await router.route(['code', 'PG-123', '--agent', 'codex', '--dry']);

    assert.deepEqual(received?.args, ['PG-123']);
    assert.deepEqual(received?.flags, { agent: 'codex', dry: true });
  });

  it('returns help and exit code 1 for unknown commands', async () => {
    const renderer = makeRenderer();
    const router = createCliCommandRouter({ renderer, logger: makeLogger() });
    router.register('status', async () => {});

    const exit = await router.route(['totally-unknown']);

    assert.equal(exit, 1);
    assert.ok(renderer._errors.some((line) => line.includes('Unknown command')), 'should print unknown command error');
  });

  it('catches handler exceptions and returns exit code 1', async () => {
    const renderer = makeRenderer();
    const router = createCliCommandRouter({ renderer, logger: makeLogger() });
    router.register('boom', async () => { throw new Error('explosion'); });

    const exit = await router.route(['boom']);

    assert.equal(exit, 1);
    assert.ok(renderer._errors.some((line) => line.includes('explosion')), 'should render the error message');
  });

  it('lists registered commands sorted', () => {
    const renderer = makeRenderer();
    const router = createCliCommandRouter({ renderer, logger: makeLogger() });
    router.register('status', async () => {});
    router.register('ask', async () => {});
    router.register('llm status', async () => {});

    assert.deepEqual(router.listCommands(), ['ask', 'llm status', 'status']);
  });
});
