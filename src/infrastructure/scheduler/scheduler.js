/**
 * Creates a scheduler for recurring tasks.
 * Returns a handle to stop all scheduled jobs.
 *
 * @returns {Scheduler}
 */
export function createScheduler() {
  /** @type {NodeJS.Timeout[]} */
  const handles = [];

  /**
   * Schedules a recurring task at the given interval.
   *
   * @param {() => void | Promise<void>} task
   * @param {number} intervalMs
   * @param {string} [name] - descriptive name for logging
   * @returns {{ stop: () => void }}
   */
  function schedule(task, intervalMs, name = 'unnamed') {
    const handle = setInterval(async () => {
      try {
        await task();
      } catch (error) {
        // Scheduler swallows errors to keep jobs running.
        // Callers should handle errors internally.
        process.emitWarning(`Scheduled task "${name}" threw: ${error.message}`);
      }
    }, intervalMs);

    handles.push(handle);

    return {
      stop: () => clearInterval(handle),
    };
  }

  /**
   * Schedules a one-time delayed task.
   *
   * @param {() => void | Promise<void>} task
   * @param {number} delayMs
   * @returns {{ cancel: () => void }}
   */
  function delay(task, delayMs) {
    const handle = setTimeout(async () => {
      try {
        await task();
      } catch (error) {
        process.emitWarning(`Delayed task threw: ${error.message}`);
      }
    }, delayMs);

    handles.push(handle);

    return { cancel: () => clearTimeout(handle) };
  }

  /**
   * Stops all scheduled tasks.
   */
  function stopAll() {
    for (const handle of handles) {
      clearInterval(handle);
      clearTimeout(handle);
    }
    handles.length = 0;
  }

  return { schedule, delay, stopAll };
}

/**
 * @typedef {Object} Scheduler
 * @property {(task: Function, intervalMs: number, name?: string) => { stop: () => void }} schedule
 * @property {(task: Function, delayMs: number) => { cancel: () => void }} delay
 * @property {() => void} stopAll
 */
