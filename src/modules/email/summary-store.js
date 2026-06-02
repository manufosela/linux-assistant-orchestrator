import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SHORT_ID_LEN = 8;

/**
 * Persistencia de resúmenes pre-generados para el canal RESUMEN del digest
 * (LUI-TSK-0065). Cada resumen vive en `{dir}/<shortId>.json` con TTL
 * configurable (default 7 días). El shortId es un hash determinista del
 * messageId de Gmail (sha256 truncado a 8 chars hex), así el usuario
 * escribe un comando corto y reproducible.
 *
 * Operaciones:
 *  - `save({messageId, summary, ...})`: persiste y devuelve el shortId
 *  - `get(shortId)`: devuelve el resumen o null si no existe / expiró
 *  - `gc()`: borra entradas con mtime > ttl
 *
 * @param {{ dir: string, ttlMs?: number, logger?: import('pino').Logger, nowFn?: () => number }} deps
 * @returns {SummaryStore}
 */
export function createSummaryStore({ dir, ttlMs = DEFAULT_TTL_MS, logger, nowFn = Date.now }) {
  if (!dir) throw new Error('createSummaryStore requires dir');

  function shortId(messageId) {
    return createHash('sha256').update(String(messageId)).digest('hex').slice(0, SHORT_ID_LEN);
  }

  function pathFor(id) {
    return join(dir, `${id}.json`);
  }

  /**
   * @param {{ messageId: string, labelName: string, from: string, subject: string, date: string, summary: string }} entry
   */
  async function save(entry) {
    if (!entry?.messageId) throw new Error('messageId requerido');
    const id = shortId(entry.messageId);
    await mkdir(dir, { recursive: true });
    const payload = {
      id,
      messageId: entry.messageId,
      labelName: entry.labelName ?? '',
      from: entry.from ?? '',
      subject: entry.subject ?? '',
      date: entry.date ?? '',
      summary: entry.summary ?? '',
      createdAt: new Date(nowFn()).toISOString(),
    };
    await writeFile(pathFor(id), JSON.stringify(payload, null, 2), 'utf8');
    logger?.debug({ id, messageId: entry.messageId, label: entry.labelName }, 'summary saved');
    return id;
  }

  async function get(id) {
    const cleanId = String(id ?? '').trim().toLowerCase();
    if (!/^[a-f0-9]{4,16}$/.test(cleanId)) return null;
    try {
      const filePath = pathFor(cleanId);
      const fileStat = await stat(filePath);
      if (nowFn() - fileStat.mtimeMs > ttlMs) {
        // Expirado — eliminarlo en best-effort.
        await unlink(filePath).catch(() => {});
        return null;
      }
      const raw = await readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn({ err: error.message, id: cleanId }, 'summary get failed');
      }
      return null;
    }
  }

  /**
   * Garbage-collect: borra ficheros con mtime > ttl. Devuelve cuántos.
   */
  async function gc() {
    let removed = 0;
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const filePath = join(dir, entry);
        try {
          const fileStat = await stat(filePath);
          if (nowFn() - fileStat.mtimeMs > ttlMs) {
            await unlink(filePath);
            removed += 1;
          }
        } catch {
          // ignore
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn({ err: error.message }, 'summary gc failed');
      }
    }
    if (removed > 0) logger?.info({ removed }, 'summary store GC');
    return removed;
  }

  return { save, get, gc, shortId };
}

/**
 * @typedef {Object} SummaryEntry
 * @property {string} id           - shortId (8 hex chars)
 * @property {string} messageId    - Gmail message id
 * @property {string} labelName
 * @property {string} from
 * @property {string} subject
 * @property {string} date
 * @property {string} summary
 * @property {string} createdAt    - ISO 8601
 */

/**
 * @typedef {Object} SummaryStore
 * @property {(entry: { messageId: string, labelName: string, from: string, subject: string, date: string, summary: string }) => Promise<string>} save
 * @property {(id: string) => Promise<SummaryEntry | null>} get
 * @property {() => Promise<number>} gc
 * @property {(messageId: string) => string} shortId
 */
