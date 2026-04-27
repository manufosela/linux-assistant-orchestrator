/**
 * Planning Game client placeholder.
 *
 * Future implementation will call the Planning Game REST API.
 * Status updates require explicit human approval.
 *
 * @returns {object}
 */
export function createPlanningGameClient() {
  /** @returns {Promise<never>} */
  async function getTaskById() {
    throw new PlanningGameNotImplementedError('getTaskById');
  }

  /** @returns {Promise<never>} */
  async function getSprintTasks() {
    throw new PlanningGameNotImplementedError('getSprintTasks');
  }

  return { getTaskById, getSprintTasks };
}

export class PlanningGameNotImplementedError extends Error {
  /** @param {string} operation */
  constructor(operation) {
    super(`Planning Game integration not implemented: ${operation}. Configure PLANNING_GAME_BASE_URL to enable.`);
    this.name = 'PlanningGameNotImplementedError';
  }
}
