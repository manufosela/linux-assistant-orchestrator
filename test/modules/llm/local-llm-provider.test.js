import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Minimal logger stub.
 * @returns {object}
 */
function makeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe('local-llm-provider', () => {
  describe('createLocalLlmProvider', () => {
    it('builds a request with the correct shape and returns text', async () => {
      // Arrange — intercept the http client by overriding global fetch
      const logger = makeLogger();

      const fakeResponseBody = {
        model: 'test-model',
        choices: [{ message: { content: 'Hello from LLM' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };

      const originalFetch = global.fetch;
      global.fetch = async (url, options) => {
        assert.ok(url.includes('/v1/chat/completions'), 'should call the completions endpoint');
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'llama3', 'should send configured model');
        assert.ok(Array.isArray(body.messages), 'should send messages array');
        assert.equal(body.stream, false, 'should not stream');

        return {
          ok: true,
          json: async () => fakeResponseBody,
        };
      };

      try {
        const { createLocalLlmProvider } = await import('../../../src/modules/llm/local-llm-provider.js');

        const provider = createLocalLlmProvider(
          { baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '', timeoutMs: 5000 },
          logger
        );

        const result = await provider.generateText({
          prompt: 'Say hello',
          metadata: { module: 'test', operation: 'test', correlationId: 'abc' },
        });

        assert.equal(result.text, 'Hello from LLM');
        assert.equal(result.provider, 'local');
        assert.equal(result.model, 'test-model');
        assert.equal(result.usage.promptTokens, 10);
        assert.equal(result.usage.completionTokens, 5);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('includes the system prompt as the first message when provided', async () => {
      const logger = makeLogger();
      let capturedMessages = [];

      const originalFetch = global.fetch;
      global.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        capturedMessages = body.messages;
        return {
          ok: true,
          json: async () => ({
            model: 'llama3',
            choices: [{ message: { content: 'ok' } }],
          }),
        };
      };

      try {
        const { createLocalLlmProvider } = await import('../../../src/modules/llm/local-llm-provider.js');

        const provider = createLocalLlmProvider(
          { baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '', timeoutMs: 5000 },
          logger
        );

        await provider.generateText({
          prompt: 'Hello',
          systemPrompt: 'You are a helpful assistant.',
          metadata: { module: 'test', operation: 'test', correlationId: 'xyz' },
        });

        assert.equal(capturedMessages[0].role, 'system');
        assert.equal(capturedMessages[0].content, 'You are a helpful assistant.');
        assert.equal(capturedMessages[1].role, 'user');
        assert.equal(capturedMessages[1].content, 'Hello');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('throws when the endpoint returns a non-ok status', async () => {
      const logger = makeLogger();

      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      });

      try {
        const { createLocalLlmProvider } = await import('../../../src/modules/llm/local-llm-provider.js');

        const provider = createLocalLlmProvider(
          { baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '', timeoutMs: 5000 },
          logger
        );

        await assert.rejects(
          () => provider.generateText({
            prompt: 'Hello',
            metadata: { module: 'test', operation: 'test', correlationId: 'abc' },
          }),
          /HTTP 503/
        );
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('checkHealth returns true when the models endpoint is reachable', async () => {
      const logger = makeLogger();

      const originalFetch = global.fetch;
      global.fetch = async () => ({ ok: true, json: async () => ({ models: [] }) });

      try {
        const { createLocalLlmProvider } = await import('../../../src/modules/llm/local-llm-provider.js');

        const provider = createLocalLlmProvider(
          { baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '', timeoutMs: 5000 },
          logger
        );

        const healthy = await provider.checkHealth();
        assert.equal(healthy, true);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('checkHealth returns false when the endpoint is unreachable', async () => {
      const logger = makeLogger();

      const originalFetch = global.fetch;
      global.fetch = async () => { throw new Error('ECONNREFUSED'); };

      try {
        const { createLocalLlmProvider } = await import('../../../src/modules/llm/local-llm-provider.js');

        const provider = createLocalLlmProvider(
          { baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '', timeoutMs: 5000 },
          logger
        );

        const healthy = await provider.checkHealth();
        assert.equal(healthy, false);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
