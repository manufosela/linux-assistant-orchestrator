import { google } from 'googleapis';

/**
 * Creates a Google Drive read-only client.
 *
 * Scope used: `drive.readonly`. Cannot create, modify, move or delete files.
 * This is enforced by Google at the API layer — any write call returns 403.
 *
 * @param {{
 *   googleAuth: import('../google/google-auth.js').GoogleAuth,
 *   logger?: import('pino').Logger,
 *   driveFactory?: (opts: { version: string, auth: object }) => object,
 * }} deps
 * @returns {GoogleDriveClient}
 */
export function createGoogleDriveClient({ googleAuth, logger, driveFactory }) {
  // Inyectable para tests sin red.
  const factory = driveFactory ?? google.drive;

  async function client() {
    const auth = await googleAuth.getClient();
    return factory({ version: 'v3', auth });
  }

  /**
   * Lists the immediate children of a folder (default = root of My Drive).
   *
   * @param {string} [folderId='root']
   * @param {{ pageSize?: number }} [options]
   * @returns {Promise<DriveItem[]>}
   */
  async function listFolder(folderId = 'root', { pageSize = 50 } = {}) {
    const drive = await client();
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      pageSize,
      fields: 'files(id, name, mimeType, modifiedTime, size, parents, webViewLink)',
      orderBy: 'folder,name',
    });
    const files = response.data.files ?? [];
    logger?.debug({ folderId, count: files.length }, 'drive.listFolder');
    return files.map(toDriveItem);
  }

  /**
   * Searches files/folders by name across the user's Drive (excluding trash).
   *
   * @param {string} query free-text search
   * @param {{ pageSize?: number }} [options]
   * @returns {Promise<DriveItem[]>}
   */
  async function searchByName(query, { pageSize = 50 } = {}) {
    if (!query || !query.trim()) {
      throw new Error('searchByName requires a non-empty query');
    }
    const drive = await client();
    // Escape single quotes in the query for the q filter.
    const safeQuery = query.replace(/'/g, "\\'");
    const response = await drive.files.list({
      q: `name contains '${safeQuery}' and trashed = false`,
      pageSize,
      fields: 'files(id, name, mimeType, modifiedTime, size, parents, webViewLink)',
      orderBy: 'modifiedTime desc',
    });
    const files = response.data.files ?? [];
    logger?.debug({ query, count: files.length }, 'drive.searchByName');
    return files.map(toDriveItem);
  }

  /**
   * Returns metadata for a specific file or folder.
   *
   * @param {string} fileId
   * @returns {Promise<DriveItem>}
   */
  async function getMetadata(fileId) {
    if (!fileId) throw new Error('getMetadata requires a fileId');
    const drive = await client();
    const response = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, modifiedTime, size, parents, webViewLink, owners(displayName,emailAddress)',
    });
    logger?.debug({ fileId, name: response.data.name }, 'drive.getMetadata');
    return toDriveItem(response.data);
  }

  return { listFolder, searchByName, getMetadata };
}

/**
 * Normalizes a raw Drive API file into our simplified shape.
 *
 * @param {object} raw
 * @returns {DriveItem}
 */
function toDriveItem(raw) {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '(sin nombre)',
    mimeType: raw.mimeType ?? '',
    isFolder: raw.mimeType === 'application/vnd.google-apps.folder',
    modifiedTime: raw.modifiedTime ?? '',
    size: raw.size ? Number(raw.size) : null,
    parents: raw.parents ?? [],
    webViewLink: raw.webViewLink ?? '',
  };
}

/**
 * @typedef {Object} DriveItem
 * @property {string} id
 * @property {string} name
 * @property {string} mimeType
 * @property {boolean} isFolder
 * @property {string} modifiedTime ISO timestamp
 * @property {number|null} size bytes, null for folders
 * @property {string[]} parents
 * @property {string} webViewLink
 */

/**
 * @typedef {Object} GoogleDriveClient
 * @property {(folderId?: string, options?: { pageSize?: number }) => Promise<DriveItem[]>} listFolder
 * @property {(query: string, options?: { pageSize?: number }) => Promise<DriveItem[]>} searchByName
 * @property {(fileId: string) => Promise<DriveItem>} getMetadata
 */
