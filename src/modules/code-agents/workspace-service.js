/**
 * Workspace service placeholder.
 * Will create isolated directories for each coding task.
 *
 * @returns {object}
 */
export function createWorkspaceService() {
  /** @returns {Promise<never>} */
  async function createWorkspace() {
    throw new Error('Workspace service not implemented. Set ENABLE_REMOTE_CODE_TASKS=true to enable.');
  }

  return { createWorkspace };
}
