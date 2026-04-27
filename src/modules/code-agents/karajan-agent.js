import { createCodeAgent } from './code-agent.js';

/** @returns {import('../../../types/code-agents.js').CodeAgent} */
export function createKarajanAgent() {
  return createCodeAgent('karajan');
}
