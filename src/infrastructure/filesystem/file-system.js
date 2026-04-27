import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Checks whether a path exists on the filesystem.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a file as a UTF-8 string.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function readTextFile(filePath) {
  return fs.readFile(filePath, 'utf8');
}

/**
 * Reads and parses a JSON file.
 *
 * @template T
 * @param {string} filePath
 * @returns {Promise<T>}
 */
export async function readJsonFile(filePath) {
  const content = await readTextFile(filePath);
  return JSON.parse(content);
}

/**
 * Moves a file from one path to another.
 * Creates intermediate directories in the target path if needed.
 * Throws if the target already exists and overwrite is disabled.
 *
 * @param {string} sourcePath
 * @param {string} targetPath
 * @param {{ overwrite?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function moveFile(sourcePath, targetPath, { overwrite = false } = {}) {
  const targetExists = await pathExists(targetPath);

  if (targetExists && !overwrite) {
    throw new FileConflictError(sourcePath, targetPath);
  }

  await fs.mkdir(dirname(targetPath), { recursive: true });
  await fs.rename(sourcePath, targetPath);
}

/**
 * Creates a directory and all intermediate directories.
 *
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Lists files in a directory (non-recursive).
 *
 * @param {string} dirPath
 * @returns {Promise<string[]>}
 */
export async function listFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

/**
 * Represents a file-already-exists conflict during a move.
 */
export class FileConflictError extends Error {
  /**
   * @param {string} source
   * @param {string} target
   */
  constructor(source, target) {
    super(`Target already exists: ${target} (source: ${source})`);
    this.name = 'FileConflictError';
    this.source = source;
    this.target = target;
  }
}
