import { basename, join } from 'node:path';
import { moveFile, pathExists, FileConflictError } from '../../infrastructure/filesystem/file-system.js';

/**
 * Creates a file mover that moves files to their target directories.
 * Never overwrites existing files silently.
 *
 * @param {import('pino').Logger} logger
 * @returns {FileMover}
 */
export function createFileMover(logger) {
  /**
   * Moves a file from its current location to the target directory.
   * The filename is preserved; only the directory changes.
   * Returns the result without throwing on expected conflicts.
   *
   * @param {string} sourcePath
   * @param {string} targetDirectory
   * @param {import('../../../types/downloads.js').FileMoverOptions} [options]
   * @returns {Promise<import('../../../types/downloads.js').FileMoveResult>}
   */
  async function moveToDirectory(sourcePath, targetDirectory, options = {}) {
    const fileName = basename(sourcePath);
    const targetPath = join(targetDirectory, fileName);

    return move(sourcePath, targetPath, options);
  }

  /**
   * Moves a file to an explicit target path.
   * Will not overwrite an existing file unless `overwriteExisting` is explicitly set.
   *
   * @param {string} sourcePath
   * @param {string} targetPath
   * @param {import('../../../types/downloads.js').FileMoverOptions} [options]
   * @returns {Promise<import('../../../types/downloads.js').FileMoveResult>}
   */
  async function move(sourcePath, targetPath, options = {}) {
    const { overwriteExisting = false } = options;

    const sourceExists = await pathExists(sourcePath);
    if (!sourceExists) {
      logger.warn({ sourcePath }, 'File move skipped — source does not exist');
      return {
        success: false,
        sourcePath,
        targetPath,
        skipped: true,
        skipReason: 'Source file does not exist',
      };
    }

    if (!overwriteExisting) {
      const targetExists = await pathExists(targetPath);
      if (targetExists) {
        logger.warn({ sourcePath, targetPath }, 'File move skipped — target already exists');
        return {
          success: false,
          sourcePath,
          targetPath,
          skipped: true,
          skipReason: 'Target already exists and overwrite is disabled',
        };
      }
    }

    try {
      await moveFile(sourcePath, targetPath, { overwrite: overwriteExisting });
      logger.info({ sourcePath, targetPath }, 'File moved');
      return { success: true, sourcePath, targetPath };
    } catch (error) {
      if (error instanceof FileConflictError) {
        return {
          success: false,
          sourcePath,
          targetPath,
          skipped: true,
          skipReason: error.message,
        };
      }

      logger.error({ sourcePath, targetPath, err: error.message }, 'File move failed');
      return { success: false, sourcePath, targetPath, error: error.message };
    }
  }

  return { move, moveToDirectory };
}

/**
 * @typedef {Object} FileMover
 * @property {(source: string, target: string, options?: object) => Promise<import('../../../types/downloads.js').FileMoveResult>} move
 * @property {(source: string, targetDir: string, options?: object) => Promise<import('../../../types/downloads.js').FileMoveResult>} moveToDirectory
 */
