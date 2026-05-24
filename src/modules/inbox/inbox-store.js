import { mkdir, writeFile, readFile, readdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Creates a filesystem-backed inbox store.
 *
 * Layout on disk:
 *   <inboxPath>/<YYYY-MM-DD>/<uuid>/meta.json
 *   <inboxPath>/<YYYY-MM-DD>/<uuid>/<original-filename>   (optional, only if a file was attached)
 *
 * meta.json shape:
 *   {
 *     id, receivedAt, status: 'pending'|'routed'|'error',
 *     origin: { type, ... },
 *     mimeType, fileName, textCaption?,
 *     routedTo?: string,  // set by markRouted
 *     error?: string,     // set by markError
 *   }
 *
 * @param {{ inboxPath: string, logger?: import('pino').Logger, now?: () => Date }} deps
 * @returns {InboxStore}
 */
export function createInboxStore({ inboxPath, logger, now = () => new Date() }) {
  if (!inboxPath) throw new Error('createInboxStore requires inboxPath');

  /**
   * Adds a new item to the inbox.
   *
   * @param {{
   *   origin: object,
   *   mimeType?: string,
   *   textCaption?: string,
   *   fileName?: string,
   *   downloadFileTo?: (targetPath: string) => Promise<void>,
   * }} input
   * @returns {Promise<InboxItem>}
   */
  async function add(input) {
    if (!input || !input.origin) throw new Error('inboxStore.add requires { origin, ... }');

    const id = randomUUID();
    const date = now();
    const dateKey = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const dir = join(inboxPath, dateKey, id);
    await mkdir(dir, { recursive: true });

    let fileName = input.fileName ?? null;
    if (input.downloadFileTo) {
      if (!fileName) fileName = id;
      await input.downloadFileTo(join(dir, fileName));
    }

    const meta = {
      id,
      receivedAt: date.toISOString(),
      status: 'pending',
      origin: input.origin,
      mimeType: input.mimeType ?? null,
      fileName,
      textCaption: input.textCaption ?? null,
    };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    logger?.info({ id, origin: input.origin?.type, mimeType: meta.mimeType }, 'inbox.add');
    return { id, dir, meta };
  }

  /**
   * Lists items, optionally filtered by status. Sorted newest first.
   *
   * @param {{ status?: 'pending'|'routed'|'error'|null }} [options]
   * @returns {Promise<Array<{ id: string, dir: string, meta: object }>>}
   */
  async function list({ status = null } = {}) {
    const days = await safeReaddir(inboxPath);
    days.sort().reverse(); // newest day first
    const items = [];
    for (const day of days) {
      const ids = await safeReaddir(join(inboxPath, day));
      for (const id of ids) {
        const dir = join(inboxPath, day, id);
        const meta = await readMeta(dir);
        if (!meta) continue;
        if (status && meta.status !== status) continue;
        items.push({ id, dir, meta });
      }
    }
    return items;
  }

  /**
   * Updates an item's status to 'routed' with a destination description.
   *
   * @param {string} id
   * @param {string} routedTo
   * @returns {Promise<void>}
   */
  async function markRouted(id, routedTo) {
    await updateMeta(id, (meta) => ({ ...meta, status: 'routed', routedTo }));
    logger?.info({ id, routedTo }, 'inbox.markRouted');
  }

  /**
   * Updates an item's status to 'error' with an error message.
   *
   * @param {string} id
   * @param {string} error
   * @returns {Promise<void>}
   */
  async function markError(id, error) {
    await updateMeta(id, (meta) => ({ ...meta, status: 'error', error }));
    logger?.warn({ id, error }, 'inbox.markError');
  }

  async function updateMeta(id, transform) {
    const found = await findById(id);
    if (!found) throw new Error(`inbox item not found: ${id}`);
    const next = transform(found.meta);
    await writeFile(join(found.dir, 'meta.json'), JSON.stringify(next, null, 2), 'utf8');
  }

  async function findById(id) {
    const days = await safeReaddir(inboxPath);
    for (const day of days) {
      const dir = join(inboxPath, day, id);
      const meta = await readMeta(dir);
      if (meta) return { id, dir, meta };
    }
    return null;
  }

  async function readMeta(dir) {
    try {
      const raw = await readFile(join(dir, 'meta.json'), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function safeReaddir(path) {
    try {
      return await readdir(path);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  return { add, list, markRouted, markError };
}

/**
 * @typedef {Object} InboxItem
 * @property {string} id
 * @property {string} dir
 * @property {object} meta
 */

/**
 * @typedef {Object} InboxStore
 * @property {(input: object) => Promise<InboxItem>} add
 * @property {(options?: { status?: string|null }) => Promise<InboxItem[]>} list
 * @property {(id: string, routedTo: string) => Promise<void>} markRouted
 * @property {(id: string, error: string) => Promise<void>} markError
 */
