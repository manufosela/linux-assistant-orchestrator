import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Persistencia mínima del último aviso meteo, para no repetir el aviso del mismo
 * episodio entre ticks ni tras un reinicio de LUIS.
 *
 * Forma en disco:
 * {
 *   "lastAlert": { "severity": "rain"|"storm", "onset": ISO, "notifiedAt": ISO } | null
 * }
 *
 * `lastAlert` = null significa "ventana despejada": el próximo evento vuelve a
 * avisar. Mientras haya un episodio en curso se mantiene puesto (no re-avisa),
 * salvo que la severidad escale (lluvia → tormenta).
 */
export function createWeatherStore({ filePath, logger }) {
  if (!filePath) throw new Error('createWeatherStore requires filePath');

  let data = { lastAlert: null };

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      data = { lastAlert: parsed?.lastAlert ?? null };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn({ err: error.message, filePath }, 'weather-store read failed');
      }
      data = { lastAlert: null };
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
    getLastAlert: () => data.lastAlert,
    setLastAlert: (a) => { data.lastAlert = a; },
    get data() { return data; },
  };
}

// ---- evaluación de la previsión (funciones puras, testeables) ----------------

/** Códigos WMO de tormenta (con/ sin granizo). */
export const STORM_CODES = new Set([95, 96, 99]);

const SEVERITY_RANK = { rain: 1, storm: 2 };

/** Rango numérico de severidad para comparar escaladas (0 = sin evento). */
export function severityRank(severity) {
  return severity ? (SEVERITY_RANK[severity] ?? 0) : 0;
}

/**
 * Clasifica una hora de la previsión.
 *
 * @param {{ precipitation?: number, probability?: number, weathercode?: number }} entry
 * @param {{ probThreshold: number, precipThreshold: number }} thresholds
 * @returns {'storm'|'rain'|null}
 */
export function classifyHour(entry, { probThreshold, precipThreshold }) {
  if (STORM_CODES.has(Number(entry.weathercode))) return 'storm';
  const prob = Number(entry.probability);
  const precip = Number(entry.precipitation);
  const rainy = (Number.isFinite(prob) && prob >= probThreshold)
    || (Number.isFinite(precip) && precip >= precipThreshold);
  return rainy ? 'rain' : null;
}

/**
 * Evalúa la ventana [now, now+lookahead] de la previsión horaria y devuelve el
 * primer evento relevante: la tormenta más próxima si la hay, o si no la lluvia
 * más próxima. Ignora horas pasadas o fuera de la ventana.
 *
 * @param {Array<{ epochMs: number, hourLabel: string, precipitation?: number, probability?: number, weathercode?: number }>} entries
 * @param {{ nowMs: number, lookaheadMs: number, probThreshold: number, precipThreshold: number }} opts
 * @returns {{ severity: 'storm'|'rain'|null, at: object|null, prob: number|null, precip: number|null }}
 */
export function evaluateForecast(entries, { nowMs, lookaheadMs, probThreshold, precipThreshold }) {
  let stormHit = null;
  let rainHit = null;
  for (const e of entries) {
    if (!Number.isFinite(e.epochMs)) continue;
    if (e.epochMs < nowMs || e.epochMs > nowMs + lookaheadMs) continue;
    const cls = classifyHour(e, { probThreshold, precipThreshold });
    if (cls === 'storm' && !stormHit) stormHit = e;
    if (cls != null && !rainHit) rainHit = e;
    if (stormHit && rainHit) break; // entries en orden cronológico → ya tenemos los más próximos
  }
  const hit = stormHit ?? rainHit;
  if (!hit) return { severity: null, at: null, prob: null, precip: null };
  return {
    severity: stormHit ? 'storm' : 'rain',
    at: hit,
    prob: Number.isFinite(Number(hit.probability)) ? Number(hit.probability) : null,
    precip: Number.isFinite(Number(hit.precipitation)) ? Number(hit.precipitation) : null,
  };
}
