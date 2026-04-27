/**
 * Creates a service that reports the assistant's current status.
 *
 * @param {{ assistantName: string, startTime: Date, modules: AssistantModuleStatus[] }} options
 * @returns {AssistantStatusService}
 */
export function createAssistantStatusService({ assistantName, startTime, modules }) {
  /**
   * Returns the current assistant status report.
   *
   * @returns {AssistantStatus}
   */
  function getStatus() {
    const uptimeMs = Date.now() - startTime.getTime();

    return {
      name: assistantName,
      startedAt: startTime.toISOString(),
      uptimeMs,
      uptimeFormatted: formatUptime(uptimeMs),
      environment: process.env.NODE_ENV ?? 'unknown',
      modules,
    };
  }

  /**
   * Formats uptime in a human-readable form.
   *
   * @param {number} ms
   * @returns {string}
   */
  function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  return { getStatus };
}

/**
 * @typedef {Object} AssistantModuleStatus
 * @property {string} name
 * @property {'enabled' | 'disabled' | 'placeholder'} status
 * @property {string} [note]
 */

/**
 * @typedef {Object} AssistantStatus
 * @property {string} name
 * @property {string} startedAt
 * @property {number} uptimeMs
 * @property {string} uptimeFormatted
 * @property {string} environment
 * @property {AssistantModuleStatus[]} modules
 */

/**
 * @typedef {Object} AssistantStatusService
 * @property {() => AssistantStatus} getStatus
 */
