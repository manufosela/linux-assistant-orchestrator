import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Persistent JSON store for dishwasher cycles.
 *
 * Shape on disk:
 * {
 *   "lastState": "<último estado visto de sensor.lavavajillas>",
 *   "cycles": [ { "date": ISO, "energy": kWh, "water": L, "program": str } ]
 * }
 *
 * `lastState` permite detectar la transición a program_ended entre ticks.
 * `cycles` es el registro append-only de lavados completados.
 */
export function createDishwasherHistoryStore({ filePath, logger }) {
  if (!filePath) throw new Error('createDishwasherHistoryStore requires filePath');

  let data = { lastState: null, cycles: [] };

  async function load() {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      data = {
        lastState: typeof parsed?.lastState === 'string' ? parsed.lastState : null,
        cycles: Array.isArray(parsed?.cycles) ? parsed.cycles : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn({ err: error.message, filePath }, 'dishwasher-history-store read failed');
      }
      data = { lastState: null, cycles: [] };
    }
    return data;
  }

  async function save() {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  return {
    load,
    save,
    getLastState: () => data.lastState,
    setLastState: (s) => { data.lastState = s; },
    addCycle: (cycle) => { data.cycles.push(cycle); },
    getCycles: () => [...data.cycles],
    get data() { return data; },
  };
}

// ---- agregación por periodos (funciones puras, testeables) -------------------

/** Epoch ms del inicio del día de `now` (00:00 local). */
export function startOfToday(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Epoch ms del lunes de la semana de `now` (00:00 local). */
export function startOfWeek(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const mondayOffset = (d.getDay() + 6) % 7; // getDay(): 0=domingo → lunes=0
  d.setDate(d.getDate() - mondayOffset);
  return d.getTime();
}

/** Epoch ms del día 1 del mes de `now` (00:00 local). */
export function startOfMonth(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

/** Epoch ms del 1 de enero del año de `now`. */
export function startOfYear(now) {
  return new Date(new Date(now).getFullYear(), 0, 1).getTime();
}

/**
 * Agrega los ciclos con fecha ≥ fromMs: cuenta lavados y suma energía (kWh) y
 * agua (L). Ignora valores no numéricos.
 *
 * @param {Array<{date: string, energy?: number, water?: number}>} cycles
 * @param {number} fromMs
 * @returns {{ count: number, energy: number, water: number }}
 */
export function aggregate(cycles, fromMs) {
  let count = 0;
  let energy = 0;
  let water = 0;
  for (const c of cycles) {
    const t = new Date(c.date).getTime();
    if (!Number.isFinite(t) || t < fromMs) continue;
    count += 1;
    if (Number.isFinite(c.energy)) energy += c.energy;
    if (Number.isFinite(c.water)) water += c.water;
  }
  return { count, energy, water };
}

/**
 * Agregados de hoy/semana/mes/año a partir del histórico de ciclos.
 *
 * @param {Array<object>} cycles
 * @param {number} now  epoch ms
 * @returns {{ today, week, month, year }}
 */
export function summarise(cycles, now) {
  return {
    today: aggregate(cycles, startOfToday(now)),
    week: aggregate(cycles, startOfWeek(now)),
    month: aggregate(cycles, startOfMonth(now)),
    year: aggregate(cycles, startOfYear(now)),
  };
}
