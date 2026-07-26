import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Persistent JSON store for battery-change history.
 *
 * Shape on disk:
 * {
 *   "levels":  { "<entity_id>": <lastNumericLevel> },   // last seen level, for jump detection
 *   "history": { "<entity_id>": [ { "date": ISO, "level": n, "name": str, "seeded"?: bool } ] }
 * }
 *
 * `levels` is the working baseline used to detect a battery swap (a jump upwards).
 * `history` is the append-only log of detected/seeded changes, used to compute durations.
 */
export function createBatteryHistoryStore({ filePath, logger }) {
  if (!filePath) throw new Error('createBatteryHistoryStore requires filePath');

  let data = { levels: {}, history: {} };

  async function load() {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      data = {
        levels: parsed?.levels && typeof parsed.levels === 'object' ? parsed.levels : {},
        history: parsed?.history && typeof parsed.history === 'object' ? parsed.history : {},
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn({ err: error.message, filePath }, 'battery-history-store read failed');
      }
      data = { levels: {}, history: {} };
    }
    return data;
  }

  async function save() {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  function getLastLevel(entityId) {
    return Object.prototype.hasOwnProperty.call(data.levels, entityId) ? data.levels[entityId] : null;
  }

  function setLastLevel(entityId, level) {
    data.levels[entityId] = level;
  }

  function getHistory(entityId) {
    return Array.isArray(data.history[entityId]) ? [...data.history[entityId]] : [];
  }

  function hasHistory(entityId) {
    return Array.isArray(data.history[entityId]) && data.history[entityId].length > 0;
  }

  function recordChange(entityId, change) {
    (data.history[entityId] ??= []).push(change);
  }

  function isEmpty() {
    return Object.keys(data.levels).length === 0 && Object.keys(data.history).length === 0;
  }

  return {
    load,
    save,
    getLastLevel,
    setLastLevel,
    getHistory,
    hasHistory,
    recordChange,
    isEmpty,
    get data() {
      return data;
    },
  };
}
