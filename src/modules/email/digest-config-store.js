import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Persistent store for the daily digest configuration (LUI-TSK-0063).
 *
 * Persistido en `{statePath}` (típicamente `/data/digest-cache/state.json`).
 * Estructura:
 * ```json
 * {
 *   "listLabels":    ["INBOX", "Trabajo"],
 *   "summaryLabels": ["Estudio", "Newsletters"]
 * }
 * ```
 *
 * Si el fichero no existe, devuelve los defaults pasados en `defaults`
 * (típicamente los valores de env vars). Cualquier mutación lo persiste
 * de manera atómica y completa.
 *
 * Diseño deliberado:
 *  - Sin lock distribuido — esto es un único proceso luis y las mutaciones
 *    vienen del bot Telegram en serie.
 *  - Validación mínima: nombres de label se trimean y duplicados se evitan
 *    (case-insensitive). El módulo NO comprueba que la label exista en
 *    Gmail; eso es responsabilidad del comando que la usa.
 *
 * @param {{ statePath: string, defaults?: { listLabels?: string[], summaryLabels?: string[] }, logger?: import('pino').Logger }} deps
 * @returns {DigestConfigStore}
 */
export function createDigestConfigStore({ statePath, defaults = {}, logger }) {
  if (!statePath) throw new Error('createDigestConfigStore requires statePath');

  /** @type {DigestConfig | null} */
  let cached = null;

  async function load() {
    if (cached) return cached;
    try {
      const raw = await readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      cached = normalise({
        listLabels: parsed.listLabels,
        summaryLabels: parsed.summaryLabels,
      });
      logger?.debug({ statePath }, 'digest config loaded from disk');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn({ err: error.message, statePath }, 'digest config read failed, falling back to defaults');
      }
      cached = normalise(defaults);
    }
    return cached;
  }

  async function save(next) {
    cached = normalise(next);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(cached, null, 2), 'utf8');
    logger?.info({ statePath, ...counts(cached) }, 'digest config saved');
    return cached;
  }

  async function get() {
    return { ...(await load()) };
  }

  async function addLabel(channel, label) {
    assertChannel(channel);
    const name = String(label ?? '').trim();
    if (!name) throw new Error('Indica el nombre de la etiqueta.');
    const current = await load();
    const key = `${channel}Labels`;
    const list = current[key];
    if (list.some((l) => l.toLowerCase() === name.toLowerCase())) {
      return { changed: false, config: { ...current } };
    }
    const next = { ...current, [key]: [...list, name] };
    return { changed: true, config: await save(next) };
  }

  async function removeLabel(channel, label) {
    assertChannel(channel);
    const name = String(label ?? '').trim();
    if (!name) throw new Error('Indica el nombre de la etiqueta.');
    const current = await load();
    const key = `${channel}Labels`;
    const list = current[key];
    const filtered = list.filter((l) => l.toLowerCase() !== name.toLowerCase());
    if (filtered.length === list.length) {
      return { changed: false, config: { ...current } };
    }
    const next = { ...current, [key]: filtered };
    return { changed: true, config: await save(next) };
  }

  async function clear(channel) {
    assertChannel(channel);
    const current = await load();
    const key = `${channel}Labels`;
    if (current[key].length === 0) return { changed: false, config: { ...current } };
    const next = { ...current, [key]: [] };
    return { changed: true, config: await save(next) };
  }

  return { get, addLabel, removeLabel, clear };
}

function normalise(raw) {
  return {
    listLabels: dedupTrim(raw?.listLabels),
    summaryLabels: dedupTrim(raw?.summaryLabels),
  };
}

function dedupTrim(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const name = String(item ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function assertChannel(channel) {
  if (channel !== 'list' && channel !== 'summary') {
    throw new Error(`Canal inválido: ${channel}. Usa "list" o "summary".`);
  }
}

function counts(config) {
  return { listCount: config.listLabels.length, summaryCount: config.summaryLabels.length };
}

/**
 * @typedef {Object} DigestConfig
 * @property {string[]} listLabels
 * @property {string[]} summaryLabels
 */

/**
 * @typedef {Object} DigestConfigStore
 * @property {() => Promise<DigestConfig>} get
 * @property {(channel: 'list' | 'summary', label: string) => Promise<{ changed: boolean, config: DigestConfig }>} addLabel
 * @property {(channel: 'list' | 'summary', label: string) => Promise<{ changed: boolean, config: DigestConfig }>} removeLabel
 * @property {(channel: 'list' | 'summary') => Promise<{ changed: boolean, config: DigestConfig }>} clear
 */
