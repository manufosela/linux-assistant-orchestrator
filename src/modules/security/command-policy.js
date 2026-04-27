/**
 * Defines the policy for command execution.
 * Centralises the rules about which commands require explicit approval.
 *
 * @returns {CommandPolicy}
 */
export function createCommandPolicy() {
  /**
   * Actions that always require human approval before execution.
   *
   * @type {Set<string>}
   */
  const approvalRequiredActions = new Set([
    'deleteFile',
    'overwriteFile',
    'executeShell',
    'createCommit',
    'pushBranch',
    'openPullRequest',
    'updateTaskStatus',
    'callCloudLlm',
    'sendExternalData',
  ]);

  /**
   * Returns whether a given action requires approval.
   *
   * @param {string} action
   * @returns {boolean}
   */
  function requiresApproval(action) {
    return approvalRequiredActions.has(action);
  }

  /**
   * Returns all actions that require approval (for display purposes).
   *
   * @returns {string[]}
   */
  function listApprovalRequiredActions() {
    return [...approvalRequiredActions];
  }

  return { requiresApproval, listApprovalRequiredActions };
}

/**
 * @typedef {Object} CommandPolicy
 * @property {(action: string) => boolean} requiresApproval
 * @property {() => string[]} listApprovalRequiredActions
 */
