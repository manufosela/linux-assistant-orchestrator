/**
 * Abstract coding agent interface.
 *
 * All coding agents must expose this contract.
 * Agents are workers — they receive a task context and return a result.
 * Human approval is required before commits, pushes, or PRs.
 *
 * @param {string} agentName
 * @returns {import('../../../types/code-agents.js').CodeAgent}
 */
export function createCodeAgent(agentName) {
  /**
   * @param {import('../../../types/code-agents.js').CodeTaskContext} context
   * @returns {Promise<import('../../../types/code-agents.js').CodeTaskResult>}
   */
  async function runCodeTask(context) {
    void context;
    throw new CodeAgentNotImplementedError(agentName);
  }

  return { name: agentName, runCodeTask };
}

export class CodeAgentNotImplementedError extends Error {
  /** @param {string} agentName */
  constructor(agentName) {
    super(`Coding agent "${agentName}" is not implemented. Set ENABLE_REMOTE_CODE_TASKS=true to enable.`);
    this.name = 'CodeAgentNotImplementedError';
    this.agentName = agentName;
  }
}
