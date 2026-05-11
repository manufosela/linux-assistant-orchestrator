import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCliApp } from '../../../src/apps/cli/create-cli-app.js';

/**
 * Builds an in-memory renderer that captures everything for assertions.
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
    renderStatus: (status) => output.push(`status:${status.name}:${status.modules.length}`),
    renderLlmStatus: (health) => output.push(`llm:${health.provider}:${health.healthy ? 'ok' : 'fail'}`),
    renderRules: (rules) => output.push(`rules:${rules.length}`),
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
 * Builds default fake services. Tests can override individual ones via the override argument.
 *
 * @param {Partial<{
 *   llmService: import('../../../src/modules/llm/llm-service.js').LlmService,
 *   statusService: import('../../../src/modules/assistant/assistant-status-service.js').AssistantStatusService,
 *   rulesRepository: import('../../../src/modules/downloads/download-rules-repository.js').DownloadRulesRepository,
 *   approvalService: import('../../../src/modules/security/approval-service.js').ApprovalService,
 *   remoteCodeTasksEnabled: boolean,
 * }>} [overrides]
 * @returns {object}
 */
function makeApp(overrides = {}) {
  const renderer = makeRenderer();
  const logger = makeLogger();

  const defaults = {
    llmService: {
      generateText: async () => 'default-llm-answer',
      chat: async () => 'default-chat-answer',
      checkHealth: async () => ({ healthy: true, provider: 'local', model: 'test-model', baseUrl: 'http://localhost:11434' }),
    },
    statusService: {
      getStatus: () => ({
        name: 'assistant',
        startedAt: new Date(0).toISOString(),
        uptimeMs: 1000,
        uptimeFormatted: '1s',
        environment: 'test',
        modules: [{ name: 'cli', status: 'enabled' }],
      }),
    },
    rulesRepository: {
      loadRules: async () => [{ name: 'PDFs', extensions: ['.pdf'], targetPath: '/tmp/pdf' }],
      invalidateCache: () => {},
    },
    approvalService: {
      requestApproval: async () => ({ approved: false, action: 'x', reason: 'no', requiresManualApproval: true }),
      requiresApproval: () => true,
    },
    urlFetcher: undefined,
    webSearch: undefined,
    remoteCodeTasksEnabled: false,
  };

  const services = { ...defaults, ...overrides };

  const app = createCliApp({
    llmService: services.llmService,
    statusService: services.statusService,
    rulesRepository: services.rulesRepository,
    approvalService: services.approvalService,
    urlFetcher: services.urlFetcher,
    webSearch: services.webSearch,
    logger,
    appName: 'assistant',
    appVersion: 'test',
    llmProvider: 'local',
    remoteCodeTasksEnabled: services.remoteCodeTasksEnabled,
    renderer,
  });

  return { app, renderer };
}

describe('create-cli-app — command routing', () => {
  it('"ai status" calls statusService.getStatus and renders it', async () => {
    let getStatusCalls = 0;
    const { app, renderer } = makeApp({
      statusService: {
        getStatus: () => {
          getStatusCalls += 1;
          return {
            name: 'unit-test-bot',
            startedAt: new Date(0).toISOString(),
            uptimeMs: 0,
            uptimeFormatted: '0s',
            environment: 'test',
            modules: [{ name: 'cli', status: 'enabled' }, { name: 'telegram', status: 'disabled' }],
          };
        },
      },
    });

    const exit = await app.runCommand(['status']);

    assert.equal(exit, 0);
    assert.equal(getStatusCalls, 1);
    assert.ok(renderer._output.some((line) => line.startsWith('status:unit-test-bot:2')), 'expected renderStatus to be called with the produced status');
  });

  it('"ai llm status" calls llmService.checkHealth and exits 1 on unhealthy', async () => {
    let healthCalls = 0;
    const { app, renderer } = makeApp({
      llmService: {
        generateText: async () => 'unused',
        checkHealth: async () => {
          healthCalls += 1;
          return { healthy: false, provider: 'local', model: 'm', baseUrl: 'http://x' };
        },
      },
    });

    const exit = await app.runCommand(['llm', 'status']);

    assert.equal(healthCalls, 1);
    assert.equal(exit, 1, 'unhealthy LLM should produce exit code 1');
    assert.ok(renderer._output.some((line) => line === 'llm:local:fail'), 'expected llm status to render unhealthy');
  });

  it('"ai ask hola" calls llmService.generateText with module=cli and prints the response', async () => {
    /** @type {{ prompt: string | null, options: any }} */
    const captured = { prompt: null, options: null };
    const { app, renderer } = makeApp({
      llmService: {
        generateText: async (prompt, options) => {
          captured.prompt = prompt;
          captured.options = options;
          return 'hola humano';
        },
        checkHealth: async () => ({ healthy: true, provider: 'local', model: 'm', baseUrl: 'http://x' }),
      },
    });

    const exit = await app.runCommand(['ask', 'hola']);

    assert.equal(exit, 0);
    assert.equal(captured.prompt, 'hola');
    assert.equal(captured.options.module, 'cli');
    assert.equal(captured.options.operation, 'ask');
    assert.equal(captured.options.private, true);
    assert.ok(renderer._output.includes('hola humano'), 'response should be printed');
  });

  it('unknown command returns exit code 1 and prints help', async () => {
    const { app, renderer } = makeApp();

    const exit = await app.runCommand(['banana', 'split']);

    assert.equal(exit, 1);
    assert.ok(renderer._errors.some((line) => line.includes('Unknown command')), 'should print unknown command error');
  });

  it('"ai ask" with no prompt prints usage and exits 1', async () => {
    const { app, renderer } = makeApp();

    const exit = await app.runCommand(['ask']);

    assert.equal(exit, 1);
    assert.ok(renderer._errors.some((line) => line.toLowerCase().includes('usage')), 'should hint usage');
  });

  it('LLM failure on "ai ask" is caught and rendered as a controlled error', async () => {
    const { app, renderer } = makeApp({
      llmService: {
        generateText: async () => { throw new Error('fetch failed'); },
        checkHealth: async () => ({ healthy: false, provider: 'local', model: 'm' }),
      },
    });

    const exit = await app.runCommand(['ask', 'hola']);

    assert.equal(exit, 1);
    assert.ok(
      renderer._errors.some((line) => line.toLowerCase().includes('not reachable') || line.toLowerCase().includes('llm')),
      'should render a controlled, user-friendly error message'
    );
  });

  it('"ai code PG-123 --agent codex" is blocked when remote coding is disabled', async () => {
    const { app, renderer } = makeApp({ remoteCodeTasksEnabled: false });

    const exit = await app.runCommand(['code', 'PG-123', '--agent', 'codex']);

    assert.equal(exit, 1);
    assert.ok(
      renderer._output.some((line) => line.toLowerCase().includes('remote coding is disabled')),
      'should warn that remote coding is disabled'
    );
  });

  it('"ai code PG-123 --agent codex" runs (placeholder) when remote coding is enabled', async () => {
    const { app, renderer } = makeApp({ remoteCodeTasksEnabled: true });

    const exit = await app.runCommand(['code', 'PG-123', '--agent', 'codex']);

    assert.equal(exit, 0);
    assert.ok(renderer._output.some((line) => line.toLowerCase().includes('codex')), 'agent name should appear in output');
  });

  it('"ai mail summary" returns the not-implemented placeholder', async () => {
    const { app, renderer } = makeApp();

    const exit = await app.runCommand(['mail', 'summary']);

    assert.equal(exit, 0);
    assert.ok(
      renderer._output.some((line) => line.toLowerCase().includes('email integration is not implemented')),
      'should render the placeholder message'
    );
  });

  it('"ai calendar today" returns the not-implemented placeholder', async () => {
    const { app, renderer } = makeApp();

    const exit = await app.runCommand(['calendar', 'today']);

    assert.equal(exit, 0);
    assert.ok(
      renderer._output.some((line) => line.toLowerCase().includes('calendar integration is not implemented')),
      'should render the placeholder message'
    );
  });

  it('"ai pg task PG-9" returns the planning game placeholder including the id', async () => {
    const { app, renderer } = makeApp();

    const exit = await app.runCommand(['pg', 'task', 'PG-9']);

    assert.equal(exit, 0);
    assert.ok(
      renderer._output.some((line) => line.toLowerCase().includes('planning game integration is not implemented') && line.includes('PG-9')),
      'should render the placeholder message and include the requested task id'
    );
  });

  it('"ai downloads rules" calls rulesRepository.loadRules and renders them', async () => {
    let loadCalls = 0;
    const { app, renderer } = makeApp({
      rulesRepository: {
        loadRules: async () => {
          loadCalls += 1;
          return [
            { name: 'PDFs', extensions: ['.pdf'], targetPath: '/tmp/pdf' },
            { name: 'Images', extensions: ['.png'], targetPath: '/tmp/img' },
          ];
        },
        invalidateCache: () => {},
      },
    });

    const exit = await app.runCommand(['downloads', 'rules']);

    assert.equal(exit, 0);
    assert.equal(loadCalls, 1);
    assert.ok(renderer._output.includes('rules:2'), 'should render two rules');
  });

  it('"luis fetch <url>" calls urlFetcher.fetchUrl and prints the text', async () => {
    let captured = null;
    const { app, renderer } = makeApp({
      urlFetcher: {
        fetchUrl: async (url) => {
          captured = url;
          return { url, title: 'Doc', text: 'CONTENT BODY', contentType: 'text/html', bytes: 12 };
        },
      },
    });

    const exit = await app.runCommand(['fetch', 'https://example.com']);

    assert.equal(exit, 0);
    assert.equal(captured, 'https://example.com');
    assert.ok(renderer._output.some((line) => line.includes('CONTENT BODY')), 'should print the fetched text');
    assert.ok(renderer._output.some((line) => line.includes('Doc')), 'should include the title');
  });

  it('"luis fetch <url>" returns 1 when the fetcher throws', async () => {
    const { app, renderer } = makeApp({
      urlFetcher: { fetchUrl: async () => { throw new Error('boom'); } },
    });

    const exit = await app.runCommand(['fetch', 'https://example.com']);

    assert.equal(exit, 1);
    assert.ok(renderer._errors.some((line) => line.toLowerCase().includes('boom')));
  });

  it('"luis fetch" without URL returns 1 with usage hint', async () => {
    const { app, renderer } = makeApp();

    const exit = await app.runCommand(['fetch']);

    assert.equal(exit, 1);
    assert.ok(renderer._errors.some((line) => line.toLowerCase().includes('usage')));
  });

  it('"luis search <query>" calls webSearch.search and prints the results', async () => {
    let captured = null;
    const { app, renderer } = makeApp({
      webSearch: {
        search: async (query) => {
          captured = query;
          return [
            { title: 'A', url: 'https://a', snippet: 'sa', engine: 'duck' },
            { title: 'B', url: 'https://b', snippet: 'sb', engine: 'bing' },
          ];
        },
        checkHealth: async () => true,
      },
    });

    const exit = await app.runCommand(['search', 'astro', 'framework']);

    assert.equal(exit, 0);
    assert.equal(captured, 'astro framework');
    assert.ok(renderer._output.some((line) => line.includes('1. A')), 'should print numbered results');
    assert.ok(renderer._output.some((line) => line.includes('https://b')), 'should include URLs');
  });

  it('"luis search ... --ask" passes formatted results to the LLM', async () => {
    let llmCall = null;
    const { app, renderer } = makeApp({
      llmService: {
        generateText: async (prompt, options) => {
          llmCall = { prompt, options };
          return 'SUMMARY';
        },
        chat: async () => 'unused',
        checkHealth: async () => ({ healthy: true, provider: 'local', model: 'm', baseUrl: 'http://x' }),
      },
      webSearch: {
        search: async () => [{ title: 'A', url: 'https://a', snippet: 'sa', engine: 'duck' }],
        checkHealth: async () => true,
      },
    });

    const exit = await app.runCommand(['search', 'query', '--ask']);

    assert.equal(exit, 0);
    assert.ok(llmCall?.prompt?.includes('query'), 'prompt should reference the original query');
    assert.equal(llmCall?.options?.module, 'cli');
    assert.equal(llmCall?.options?.operation, 'search-ask');
    assert.equal(llmCall?.options?.private, true);
    assert.ok(renderer._output.includes('SUMMARY'), 'summary should be printed');
  });

  it('"luis search" returns 1 when web search is not configured', async () => {
    const { app, renderer } = makeApp({ webSearch: undefined });

    const exit = await app.runCommand(['search', 'q']);

    assert.equal(exit, 1);
    assert.ok(renderer._errors.some((line) => line.toLowerCase().includes('not configured')));
  });
});
