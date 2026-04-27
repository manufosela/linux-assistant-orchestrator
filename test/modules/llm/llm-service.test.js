import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLlmService, PrivateDataCloudError } from '../../../src/modules/llm/llm-service.js';

/**
 * @returns {object}
 */
function makeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

/**
 * Creates a fake LLM provider.
 *
 * @param {{ text?: string, healthy?: boolean }} [options]
 * @returns {import('../../../types/llm.js').LlmProvider}
 */
function makeFakeProvider(options = {}) {
  const { text = 'fake response', healthy = true } = options;

  return {
    async generateText() {
      return { text, model: 'fake-model', provider: 'local' };
    },
    async checkHealth() {
      return healthy;
    },
  };
}

describe('llm-service', () => {
  describe('generateText', () => {
    it('delegates to the local provider by default', async () => {
      const provider = makeFakeProvider({ text: 'hello world' });
      const config = {
        provider: 'local',
        allowCloudLlm: false,
        local: { baseUrl: 'http://localhost', model: 'llama3', apiKey: '', timeoutMs: 5000 },
      };

      const service = createLlmService(provider, config, makeLogger());
      const result = await service.generateText('some prompt', { module: 'test', operation: 'test' });

      assert.equal(result, 'hello world');
    });

    it('rejects cloud provider when ALLOW_CLOUD_LLM is false and data is private', async () => {
      const provider = makeFakeProvider();
      const config = {
        provider: 'cloud',
        allowCloudLlm: false,
        local: { baseUrl: 'http://localhost', model: '', apiKey: '', timeoutMs: 5000 },
      };

      const service = createLlmService(provider, config, makeLogger());

      await assert.rejects(
        () => service.generateText('private email content', { module: 'email', operation: 'summarise', private: true }),
        PrivateDataCloudError
      );
    });

    it('allows local provider even when private is true', async () => {
      const provider = makeFakeProvider({ text: 'summary' });
      const config = {
        provider: 'local',
        allowCloudLlm: false,
        local: { baseUrl: 'http://localhost', model: 'llama3', apiKey: '', timeoutMs: 5000 },
      };

      const service = createLlmService(provider, config, makeLogger());
      const result = await service.generateText('private content', { module: 'email', operation: 'summarise', private: true });

      assert.equal(result, 'summary');
    });
  });

  describe('checkHealth', () => {
    it('returns healthy status when provider is reachable', async () => {
      const provider = makeFakeProvider({ healthy: true });
      const config = {
        provider: 'local',
        allowCloudLlm: false,
        local: { baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '', timeoutMs: 5000 },
      };

      const service = createLlmService(provider, config, makeLogger());
      const status = await service.checkHealth();

      assert.equal(status.healthy, true);
      assert.equal(status.provider, 'local');
    });

    it('returns unhealthy status when provider is unreachable', async () => {
      const provider = makeFakeProvider({ healthy: false });
      const config = {
        provider: 'local',
        allowCloudLlm: false,
        local: { baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '', timeoutMs: 5000 },
      };

      const service = createLlmService(provider, config, makeLogger());
      const status = await service.checkHealth();

      assert.equal(status.healthy, false);
    });
  });
});
