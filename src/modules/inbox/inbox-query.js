import { readFile } from 'node:fs/promises';

/**
 * Inbox query — answers "what did I save?" by walking the inbox store and
 * filtering by time range / category / status.
 *
 * The actual storage layout (dates as dirs, uuid items, meta.json with
 * classification + extraction) is owned by inbox-store. This module only
 * filters and optionally enriches with a preview of extracted.md.
 *
 * @param {{
 *   inboxStore: { list: Function },
 *   logger?: import('pino').Logger,
 * }} deps
 * @returns {InboxQuery}
 */
export function createInboxQuery({ inboxStore, logger }) {
  if (!inboxStore) throw new Error('createInboxQuery requires inboxStore');

  /**
   * Returns inbox items matching the filters, sorted newest first.
   *
   * @param {{
   *   since?: Date,
   *   until?: Date | null,
   *   categories?: string[] | null,
   *   includePreview?: boolean,
   *   previewMaxChars?: number,
   * }} [options]
   * @returns {Promise<InboxQueryItem[]>}
   */
  async function query({
    since = new Date(0),
    until = null,
    categories = null,
    includePreview = true,
    previewMaxChars = 180,
  } = {}) {
    const items = await inboxStore.list();
    const filtered = [];
    for (const item of items) {
      const receivedAt = parseDate(item.meta.receivedAt);
      if (receivedAt < since) continue;
      if (until && receivedAt > until) continue;

      if (categories && categories.length > 0) {
        const cat = item.meta.classification?.category;
        if (!cat || !categories.includes(cat)) continue;
      }

      let preview = null;
      if (includePreview) {
        preview = await loadPreview(item, previewMaxChars);
      }
      filtered.push({ ...item, preview });
    }
    // Newest first
    filtered.sort((a, b) => parseDate(b.meta.receivedAt) - parseDate(a.meta.receivedAt));
    logger?.debug({ count: filtered.length, since, categories }, 'inbox.query');
    return filtered;
  }

  return { query };
}

async function loadPreview(item, maxChars) {
  const extractedPath = item.meta.extraction?.path;
  if (!extractedPath) return null;
  try {
    const content = await readFile(extractedPath, 'utf8');
    // Skip leading markdown title / front-matter to get a meaningful snippet.
    const body = content
      .replace(/^#+\s+.*$/gm, '')
      .replace(/^>\s+.*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    return body.slice(0, maxChars);
  } catch {
    return null;
  }
}

function parseDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

/**
 * @typedef {Object} InboxQueryItem
 * @property {string} id
 * @property {string} dir
 * @property {object} meta
 * @property {string | null} preview
 */

/**
 * @typedef {Object} InboxQuery
 * @property {(options?: object) => Promise<InboxQueryItem[]>} query
 */
