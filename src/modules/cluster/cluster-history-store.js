import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Creates a file-backed ring buffer of cluster incidents.
 *
 * The daemon (watcher) appends incidents; the CLI — a separate process — reads
 * them back for `luis cluster history`. Only the last `maxEntries` are kept.
 *
 * @param {{ filePath: string, logger: import('pino').Logger, maxEntries?: number }} deps
 * @returns {ClusterHistoryStore}
 */
export function createClusterHistoryStore({ filePath, logger, maxEntries = 10 }) {
  /**
   * Reads the persisted incidents (most recent last). Missing file → empty list.
   *
   * @returns {Promise<ClusterIncident[]>}
   */
  async function read() {
    try {
      const raw = await readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn({ err: error?.message, filePath }, 'Cluster history read failed');
      }
      return [];
    }
  }

  /**
   * Appends one incident and trims to the last `maxEntries`.
   *
   * @param {ClusterIncident} incident
   * @returns {Promise<ClusterIncident[]>} the trimmed list now on disk
   */
  async function append(incident) {
    const entries = await read();
    entries.push(incident);
    const trimmed = entries.slice(-maxEntries);
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
    } catch (error) {
      logger.error({ err: error?.message, filePath }, 'Cluster history write failed');
    }
    return trimmed;
  }

  return { read, append };
}

/**
 * @typedef {Object} ClusterIncident
 * @property {string} timestamp - ISO 8601
 * @property {string} node
 * @property {string} service
 * @property {string} address - host:port
 * @property {'down'|'recovered'} type
 * @property {string|null} [detail]
 */

/**
 * @typedef {Object} ClusterHistoryStore
 * @property {() => Promise<ClusterIncident[]>} read
 * @property {(incident: ClusterIncident) => Promise<ClusterIncident[]>} append
 */
