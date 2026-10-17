import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLlmService, PrivateDataCloudError } from '../../../src/modules/llm/llm-service.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const localConfig = { provider: 'local', allowCloudLlm: false, local: { model: 'fast' } };
const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];

describe('llm-service chatWithTools', () => {
  it('forwards messages and tools to the provider and returns text plus tool calls', async () => {
    let received;
    const provider = {
      async chat(request) {
        received = request;
        return { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{}' }] };
      },
    };
    const service = createLlmService(provider, localConfig, logger);

    const result = await service.chatWithTools([{ role: 'user', content: '¿Lloverá?' }], tools, { module: 'telegram' });

    assert.deepEqual(received.tools, tools);
    assert.equal(received.metadata.module, 'telegram');
    assert.deepEqual(result, { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{}' }] });
  });

  it('refuses private data on a cloud provider without explicit permission', async () => {
    const provider = { async chat() { throw new Error('must not be called'); } };
    const service = createLlmService(provider, { provider: 'cloud', allowCloudLlm: false }, logger);

    await assert.rejects(service.chatWithTools([{ role: 'user', content: 'x' }], tools), PrivateDataCloudError);
  });
});
