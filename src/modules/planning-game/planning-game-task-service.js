/**
 * Planning Game task service placeholder.
 *
 * @returns {object}
 */
export function createPlanningGameTaskService() {
  /** @returns {Promise<never>} */
  async function fetchAndSummariseTask() {
    throw new Error('Planning Game task service not implemented. Configure PLANNING_GAME_BASE_URL to enable.');
  }

  return { fetchAndSummariseTask };
}
