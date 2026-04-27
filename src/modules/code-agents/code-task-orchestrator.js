/**
 * Code task orchestrator placeholder.
 *
 * Future implementation will:
 * 1. Receive approved coding request from Telegram.
 * 2. Fetch task context from Planning Game.
 * 3. Create isolated workspace.
 * 4. Clone or prepare repository.
 * 5. Create branch.
 * 6. Generate implementation plan.
 * 7. Run selected coding agent.
 * 8. Run tests.
 * 9. Produce summary.
 * 10. Ask for approval before commit/push/PR.
 *
 * Human approval is required for ALL git operations.
 *
 * @returns {object}
 */
export function createCodeTaskOrchestrator() {
  /** @returns {Promise<never>} */
  async function runTask() {
    throw new Error('Code task orchestrator not implemented. Set ENABLE_REMOTE_CODE_TASKS=true to enable.');
  }

  return { runTask };
}
