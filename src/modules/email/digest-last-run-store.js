import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Persistencia de la última tanda enviada por cada etiqueta del digest
 * (LUI-TSK-0064). Para cada etiqueta guardamos los `messageId` que se
 * incluyeron en el último envío de Telegram, junto con el timestamp.
 *
 * El cron del día siguiente lee este store ANTES de hacer fetch, marca esos
 * messageId como leídos (quita UNREAD) y los borra del store. Luego envía
 * el digest del día y guarda los nuevos ids.
 *
 * Fichero por etiqueta: `{dir}/<labelKey>.json`. El labelKey es el nombre
 * de la label normalizado a kebab-case-lowercase para evitar problemas con
 * nombres que contengan barras, espacios o acentos.
 *
 * @param {{ dir: string, logger?: import('pino').Logger }} deps
 * @returns {DigestLastRunStore}
 */
export function createDigestLastRunStore({ dir, logger }) {
  if (!dir) throw new Error('createDigestLastRunStore requires dir');

  function pathFor(labelName) {
    return join(dir, `${labelKey(labelName)}.json`);
  }

  async function read(labelName) {
    try {
      const raw = await readFile(pathFor(labelName), 'utf8');
      const parsed = JSON.parse(raw);
      return {
        labelName: String(parsed?.labelName ?? labelName),
        ids: Array.isArray(parsed?.ids) ? parsed.ids.map(String) : [],
        sentAt: String(parsed?.sentAt ?? ''),
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn({ err: error.message, labelName }, 'last-run read failed');
      }
      return { labelName, ids: [], sentAt: '' };
    }
  }

  async function write(labelName, ids, nowIso) {
    if (!Array.isArray(ids)) throw new Error('ids must be an array');
    await mkdir(dir, { recursive: true });
    const payload = {
      labelName,
      ids: ids.map(String),
      sentAt: nowIso ?? '',
    };
    await writeFile(pathFor(labelName), JSON.stringify(payload, null, 2), 'utf8');
    logger?.debug({ labelName, count: ids.length }, 'last-run saved');
  }

  async function clearFor(labelName) {
    try {
      await unlink(pathFor(labelName));
      logger?.debug({ labelName }, 'last-run cleared');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn({ err: error.message, labelName }, 'last-run clear failed');
      }
    }
  }

  async function listAll() {
    try {
      const entries = await readdir(dir);
      const result = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(dir, entry), 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed?.labelName) result.push(parsed);
        } catch {
          // ignore corrupt file
        }
      }
      return result;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  return { read, write, clearFor, listAll };
}

/**
 * Normaliza un nombre de label a una clave de fichero segura:
 * lower-case, sin acentos, slashes y espacios → guion.
 *
 * @param {string} name
 */
export function labelKey(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unknown';
}

/**
 * @typedef {Object} LastRunRecord
 * @property {string} labelName
 * @property {string[]} ids
 * @property {string} sentAt  - ISO 8601
 */

/**
 * @typedef {Object} DigestLastRunStore
 * @property {(labelName: string) => Promise<LastRunRecord>} read
 * @property {(labelName: string, ids: string[], nowIso?: string) => Promise<void>} write
 * @property {(labelName: string) => Promise<void>} clearFor
 * @property {() => Promise<LastRunRecord[]>} listAll
 */
