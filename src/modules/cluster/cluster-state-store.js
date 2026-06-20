import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Persistencia del estado del cluster watcher (LUI-TSK-0068).
 *
 * El watcher pierde su estado en memoria cada vez que el contenedor luis se
 * reinicia (deploy, restart, OOM). Sin persistencia, tras un restart inicia
 * con todos los servicios en 'up' y, si algo lleva apagado (como n4
 * intencionadamente), vuelve a redescubrirlo como nuevo DOWN → otra
 * notificación → spam.
 *
 * Este store guarda en disco un mapa id→{state, since, notifiedDown} para
 * que tras restart se recupere y NO se vuelva a notificar lo ya conocido.
 *
 * @param {{ filePath: string, logger?: import('pino').Logger }} deps
 * @returns {ClusterStateStore}
 */
export function createClusterStateStore({ filePath, logger }) {
  if (!filePath) throw new Error('createClusterStateStore requires filePath');

  async function load() {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger?.warn({ err: error.message, filePath }, 'cluster-state-store read failed');
      }
      return {};
    }
  }

  /**
   * @param {Record<string, { state: string, since: number, notifiedDown: boolean }>} payload
   */
  async function save(payload) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  return { load, save };
}

/**
 * @typedef {Object} ClusterStateStore
 * @property {() => Promise<Record<string, { state: string, since: number, notifiedDown: boolean }>>} load
 * @property {(payload: Record<string, { state: string, since: number, notifiedDown: boolean }>) => Promise<void>} save
 */
