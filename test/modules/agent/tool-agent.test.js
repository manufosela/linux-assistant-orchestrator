import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../../src/modules/agent/tool-registry.js';
import { createToolAgent, ToolAgentLimitError } from '../../../src/modules/agent/tool-agent.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const registry = createToolRegistry([{
  name: 'get_weather',
  description: 'Previsión de hoy',
  parameters: { type: 'object', properties: { days: { type: 'integer' } }, required: ['days'] },
  execute: async ({ days }) => ({ days, rain: '80%' }),
}], { logger });

/**
 * Fake llmService whose chatWithTools answers each call with the next scripted reply.
 * @param {Array<{ text: string, toolCalls?: Array<object> }>} replies
 */
function scriptedLlm(replies) {
  const calls = [];
  return {
    calls,
    async chatWithTools(messages, tools, options) {
      calls.push({ messages: structuredClone(messages), tools, options });
      const reply = replies[calls.length - 1];
      return { text: reply.text, toolCalls: reply.toolCalls ?? [] };
    },
  };
}

const askWeather = { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{"days": 1}' }] };

describe('tool-agent', () => {
  it('returns the reply directly when the model asks for no tool', async () => {
    const llm = scriptedLlm([{ text: 'Hola' }]);
    const agent = createToolAgent({ llmService: llm, registry });

    const result = await agent.run([{ role: 'user', content: 'Hola' }], { module: 'telegram' });

    assert.deepEqual(result, { text: 'Hola', toolsUsed: [] });
    assert.equal(llm.calls[0].tools[0].function.name, 'get_weather');
    assert.equal(llm.calls[0].options.module, 'telegram');
  });

  it('runs the requested tool, feeds its result back and returns the final reply', async () => {
    const llm = scriptedLlm([askWeather, { text: 'Lloverá' }]);
    const agent = createToolAgent({ llmService: llm, registry });

    const result = await agent.run([{ role: 'user', content: '¿Lloverá?' }]);

    assert.deepEqual(result, { text: 'Lloverá', toolsUsed: ['get_weather'] });
    const followUp = llm.calls[1].messages;
    assert.deepEqual(followUp.at(-2), {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"days": 1}' } }],
    });
    assert.deepEqual(followUp.at(-1), { role: 'tool', tool_call_id: 'c1', content: '{"days":1,"rain":"80%"}' });
  });

  it('stops with ToolAgentLimitError when the model keeps asking for tools', async () => {
    const llm = scriptedLlm([askWeather, askWeather, askWeather]);
    const agent = createToolAgent({ llmService: llm, registry, maxIterations: 3 });

    await assert.rejects(agent.run([{ role: 'user', content: 'x' }]), ToolAgentLimitError);
    assert.equal(llm.calls.length, 3);
  });

  it('does not mutate the caller conversation', async () => {
    const llm = scriptedLlm([askWeather, { text: 'ok' }]);
    const agent = createToolAgent({ llmService: llm, registry });
    const conversation = [{ role: 'user', content: 'x' }];

    await agent.run(conversation);

    assert.equal(conversation.length, 1);
  });
});
