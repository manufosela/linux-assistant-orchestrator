import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Store JSON con todos los avisos que emite LUIS (LUI-TSK-0100).
 *
 * Solo los avisos críticos salen por Telegram; el resto se guarda aquí y el
 * usuario los consulta con el comando "informe". Se podan los que superan
 * `maxAgeMs` (7 días por defecto) para que el fichero no crezca sin fin.
 *
 * Shape en disco: { "entries": [ { "ts": ISO, "text": string, "level": string, "urgent": boolean } ] }
 */
export function createNotificationLogStore({ filePath, logger, maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  if (!filePath) throw new Error('createNotificationLogStore requires filePath');

  let data = { entries: [] };
  // Cola de escrituras: dos add() concurrentes no deben pisarse en disco.
  let writeQueue = Promise.resolve();

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      data = { entries: Array.isArray(parsed?.entries) ? parsed.entries : [] };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn({ err: error.message, filePath }, 'notification-log-store read failed');
      }
      data = { entries: [] };
    }
    return data;
  }

  async function save() {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  return {
    load,
    /** Añade un aviso y poda los viejos; persiste. */
    add({ text, level = 'info', urgent = false }, now = new Date()) {
      const run = writeQueue.then(async () => {
        data.entries.push({ ts: now.toISOString(), text, level, urgent });
        data.entries = data.entries.filter((e) => now.getTime() - new Date(e.ts).getTime() <= maxAgeMs);
        await save();
      });
      // La cola sigue aunque una escritura falle; el error llega a quien llamó.
      writeQueue = run.catch(() => {});
      return run;
    },
    /** Avisos del día local de `now`, en orden de llegada. */
    today(now = new Date()) {
      return entriesOfDay(data.entries, now);
    },
    get data() { return data; },
  };
}

/**
 * Entradas cuyo `ts` cae en el mismo día local que `now` (función pura).
 *
 * @param {Array<{ ts: string }>} entries
 * @param {Date} now
 */
export function entriesOfDay(entries, now) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Siguiente medianoche local (no +24h: los días de cambio de hora duran 23 o 25h).
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return (entries ?? []).filter((e) => {
    const t = new Date(e?.ts).getTime();
    return Number.isFinite(t) && t >= start && t < end;
  });
}
