import chokidar from 'chokidar';
import { basename } from 'node:path';

/**
 * Files created with these names are typically temporary and should be ignored.
 * Editors and download managers use them during partial downloads.
 *
 * @type {RegExp}
 */
const TEMP_FILE_PATTERN = /^\..*|\.tmp$|\.crdownload$|\.part$|~$/i;

/**
 * Creates a watcher for the downloads directory.
 * Emits events for newly added files after they are stable (write operations complete).
 *
 * @param {string} watchPath
 * @param {import('pino').Logger} logger
 * @returns {DownloadWatcher}
 */
export function createDownloadWatcher(watchPath, logger) {
  /** @type {chokidar.FSWatcher | null} */
  let watcher = null;

  /** @type {Array<(filePath: string) => void>} */
  const fileHandlers = [];

  /**
   * Starts watching the downloads directory.
   * Calls registered handlers for each stable new file.
   *
   * @returns {void}
   */
  function start() {
    if (watcher) {
      logger.warn({ watchPath }, 'Download watcher is already running');
      return;
    }

    watcher = chokidar.watch(watchPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 500,
      },
      ignored: (path) => {
        const name = basename(path);
        return TEMP_FILE_PATTERN.test(name);
      },
      depth: 0,
    });

    watcher.on('add', (filePath) => {
      logger.info({ filePath }, 'New file detected in downloads');
      for (const handler of fileHandlers) {
        try {
          handler(filePath);
        } catch (error) {
          logger.error({ filePath, err: error.message }, 'File handler threw an error');
        }
      }
    });

    watcher.on('error', (error) => {
      logger.error({ watchPath, err: error.message }, 'Download watcher error');
    });

    logger.info({ watchPath }, 'Download watcher started');
  }

  /**
   * Stops the watcher and releases resources.
   *
   * @returns {Promise<void>}
   */
  async function stop() {
    if (!watcher) return;
    await watcher.close();
    watcher = null;
    logger.info({ watchPath }, 'Download watcher stopped');
  }

  /**
   * Registers a handler to be called when a new file is detected.
   *
   * @param {(filePath: string) => void} handler
   * @returns {void}
   */
  function onNewFile(handler) {
    fileHandlers.push(handler);
  }

  return { start, stop, onNewFile };
}

/**
 * @typedef {Object} DownloadWatcher
 * @property {() => void} start
 * @property {() => Promise<void>} stop
 * @property {(handler: (filePath: string) => void) => void} onNewFile
 */
