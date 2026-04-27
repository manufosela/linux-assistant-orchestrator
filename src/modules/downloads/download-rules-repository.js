import { readJsonFile, pathExists } from '../../infrastructure/filesystem/file-system.js';

/**
 * Creates a repository that loads and provides download rules from a JSON file.
 *
 * @param {string} rulesFilePath
 * @param {import('pino').Logger} logger
 * @returns {DownloadRulesRepository}
 */
export function createDownloadRulesRepository(rulesFilePath, logger) {
  /** @type {import('../../../types/downloads.js').DownloadRule[] | null} */
  let cachedRules = null;

  /**
   * Loads rules from the JSON config file.
   * Caches results in memory after first load.
   *
   * @returns {Promise<import('../../../types/downloads.js').DownloadRule[]>}
   */
  async function loadRules() {
    if (cachedRules !== null) return cachedRules;

    const exists = await pathExists(rulesFilePath);
    if (!exists) {
      logger.warn({ rulesFilePath }, 'Download rules file not found — using empty rules');
      cachedRules = [];
      return cachedRules;
    }

    try {
      const data = /** @type {import('../../../types/downloads.js').DownloadRules} */ (
        await readJsonFile(rulesFilePath)
      );

      if (!Array.isArray(data.rules)) {
        logger.error({ rulesFilePath }, 'Download rules file has invalid format — "rules" array missing');
        cachedRules = [];
        return cachedRules;
      }

      cachedRules = data.rules;
      logger.info({ rulesFilePath, count: cachedRules.length }, 'Download rules loaded');
      return cachedRules;
    } catch (error) {
      logger.error({ rulesFilePath, err: error.message }, 'Failed to load download rules');
      cachedRules = [];
      return cachedRules;
    }
  }

  /**
   * Clears the cached rules, forcing a reload on next access.
   */
  function invalidateCache() {
    cachedRules = null;
  }

  return { loadRules, invalidateCache };
}

/**
 * @typedef {Object} DownloadRulesRepository
 * @property {() => Promise<import('../../../types/downloads.js').DownloadRule[]>} loadRules
 * @property {() => void} invalidateCache
 */
