/**
 * Agent loop over native tool calling (LUI-TSK-0109): the model decides which
 * LUIS capability to use, the registry runs it and the result goes back to the
 * model until it answers with text. Bad calls are handled by the registry,
 * which returns them as `{ error }` for the model to explain.
 *
 * @param {{
 *   llmService: Pick<import('../llm/llm-service.js').LlmService, 'chatWithTools'>,
 *   registry: import('./tool-registry.js').ToolRegistry,
 *   maxIterations?: number,
 * }} deps
 */
export function createToolAgent({ llmService, registry, maxIterations = 5 }) {
  /**
   * @param {Array<{ role: string, content: string|null }>} conversation  Not mutated.
   * @param {object} [options]  Passed through to llmService.chatWithTools.
   * @returns {Promise<{ text: string, toolsUsed: string[] }>}
   */
  async function run(conversation, options = {}) {
    const messages = [...conversation];
    const toolsUsed = [];

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const reply = await llmService.chatWithTools(messages, registry.definitions(), options);
      if (reply.toolCalls.length === 0) {
        return { text: reply.text, toolsUsed };
      }

      messages.push({
        role: 'assistant',
        content: reply.text || null,
        tool_calls: reply.toolCalls.map(({ id, name, arguments: args }) => ({
          id,
          type: 'function',
          function: { name, arguments: args },
        })),
      });
      for (const call of reply.toolCalls) {
        toolsUsed.push(call.name);
        const result = await registry.invoke(call);
        messages.push({ role: 'tool', tool_call_id: call.id, content: serialise(result) });
      }
    }

    throw new ToolAgentLimitError(maxIterations, toolsUsed);
  }

  return { run };
}

/**
 * @param {unknown} result
 * @returns {string}
 */
function serialise(result) {
  return typeof result === 'string' ? result : JSON.stringify(result ?? null);
}

/**
 * Thrown when the model keeps asking for tools beyond `maxIterations`.
 */
export class ToolAgentLimitError extends Error {
  /**
   * @param {number} maxIterations
   * @param {string[]} toolsUsed
   */
  constructor(maxIterations, toolsUsed) {
    super(`El agente superó ${maxIterations} vueltas de herramientas sin responder (${toolsUsed.join(', ')})`);
    this.name = 'ToolAgentLimitError';
    this.toolsUsed = toolsUsed;
  }
}
