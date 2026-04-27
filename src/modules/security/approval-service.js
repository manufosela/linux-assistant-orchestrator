/**
 * Approval service placeholder.
 *
 * In the first version, every destructive action is blocked pending approval.
 * Future versions will support Telegram, CLI, and web UI approval flows.
 *
 * @param {import('pino').Logger} logger
 * @returns {ApprovalService}
 */
export function createApprovalService(logger) {
  /**
   * Requests approval for a potentially destructive action.
   * In this initial version, approval is always denied and must be granted manually.
   *
   * @param {ApprovalRequest} approvalRequest
   * @returns {Promise<ApprovalResult>}
   */
  async function requestApproval(approvalRequest) {
    logger.warn(
      {
        action: approvalRequest.action,
        description: approvalRequest.description,
      },
      'Approval required — action blocked (no approval channel configured)'
    );

    return {
      approved: false,
      action: approvalRequest.action,
      reason: 'No approval channel configured. Destructive actions are blocked by default.',
      requiresManualApproval: true,
    };
  }

  /**
   * Returns whether a given action type always requires approval.
   *
   * @param {string} actionType
   * @returns {boolean}
   */
  function requiresApproval(actionType) {
    const alwaysRequireApproval = new Set([
      'deleteFile',
      'overwriteFile',
      'shellCommand',
      'createCommit',
      'pushBranch',
      'openPullRequest',
      'updateTaskStatus',
      'callCloudLlm',
      'sendPrivateData',
    ]);
    return alwaysRequireApproval.has(actionType);
  }

  return { requestApproval, requiresApproval };
}

/**
 * @typedef {Object} ApprovalRequest
 * @property {string} action
 * @property {string} description
 * @property {Record<string, unknown>} [payload]
 */

/**
 * @typedef {Object} ApprovalResult
 * @property {boolean} approved
 * @property {string} action
 * @property {string} reason
 * @property {boolean} requiresManualApproval
 */

/**
 * @typedef {Object} ApprovalService
 * @property {(request: ApprovalRequest) => Promise<ApprovalResult>} requestApproval
 * @property {(actionType: string) => boolean} requiresApproval
 */
