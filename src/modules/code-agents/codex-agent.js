import { createCodeAgent } from './code-agent.js';

/** @returns {import('../../../types/code-agents.js').CodeAgent} */
export function createCodexAgent() {
  return createCodeAgent('codex');
}
