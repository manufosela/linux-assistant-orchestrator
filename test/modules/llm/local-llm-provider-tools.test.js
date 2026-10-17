import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalLlmProvider } from '../../../src/modules/llm/local-llm-provider.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const metadata = { module: 'test', operation: 'test', correlationId: 'abc' };
const weatherTool = {
  type: 'function',
  function: { name: 'get_weather', description: 'Previsión', parameters: { type: 'object', properties: {} } },
};

/**
 * Replaces global fetch with a stub that records the request body and answers `responseBody`.
 * @param {object} responseBody
 * @returns {{ body: () => object }}
 */
function stubFetch(responseBody) {
  let captured;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return { ok: true, json: async () => responseBody };
  };
  return { body: () => captured };
}

const originalFetch = global.fetch;

describe('local-llm-provider tool calling', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const provider = () =>
    createLocalLlmProvider({ baseUrl: 'http://localhost:8080/v1', model: 'fast', apiKey: '', timeoutMs: 5000 }, logger);

  it('sends the tools in the request and returns the parsed tool calls', async () => {
    const fetchStub = stubFetch({
      model: 'fast',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"days": 1}' } }],
        },
      }],
    });

    const result = await provider().chat({ messages: [{ role: 'user', content: '¿Lloverá?' }], tools: [weatherTool], metadata });

    assert.deepEqual(fetchStub.body().tools, [weatherTool]);
    assert.equal(result.text, '');
    assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'get_weather', arguments: '{"days": 1}' }]);
  });

  it('omits tools from the request and returns no tool calls when none are given', async () => {
    const fetchStub = stubFetch({ model: 'fast', choices: [{ message: { content: 'Hola' } }] });

    const result = await provider().chat({ messages: [{ role: 'user', content: 'Hola' }], metadata });

    assert.equal('tools' in fetchStub.body(), false);
    assert.equal(result.text, 'Hola');
    assert.deepEqual(result.toolCalls, []);
  });
});
