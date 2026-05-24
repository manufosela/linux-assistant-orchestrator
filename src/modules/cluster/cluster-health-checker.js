import net from 'node:net';

/**
 * Creates a health checker for cluster targets.
 *
 * HTTP targets are probed with a GET and considered healthy only on a 200.
 * TCP targets (Postgres) are probed with a raw socket connect.
 *
 * `fetchImpl` and `tcpConnect` are injectable so tests never touch the network.
 *
 * @param {{
 *   logger: import('pino').Logger,
 *   fetchImpl?: typeof fetch,
 *   tcpConnect?: (opts: { host: string, port: number, timeoutMs: number }) => Promise<void>,
 *   timeoutMs?: number,
 * }} deps
 * @returns {ClusterHealthChecker}
 */
export function createClusterHealthChecker({ logger, fetchImpl = fetch, tcpConnect, timeoutMs = 5000 } = {}) {
  const connectTcp = tcpConnect ?? defaultTcpConnect;

  /**
   * @param {import('./cluster-targets.js').ClusterTarget} target
   * @returns {Promise<CheckResult>}
   */
  async function checkHttp(target) {
    const url = `http://${target.host}:${target.port}${target.path ?? '/'}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (response.status === 200) return { ok: true };
      return { ok: false, detail: `HTTP ${response.status}` };
    } catch (error) {
      const detail = error?.name === 'AbortError' ? 'timeout' : (error?.message ?? 'error de red');
      return { ok: false, detail };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {import('./cluster-targets.js').ClusterTarget} target
   * @returns {Promise<CheckResult>}
   */
  async function checkTcp(target) {
    try {
      await connectTcp({ host: target.host, port: target.port, timeoutMs });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error?.message ?? 'conexión TCP rechazada' };
    }
  }

  /**
   * Probes a single target.
   *
   * @param {import('./cluster-targets.js').ClusterTarget} target
   * @returns {Promise<CheckResult>}
   */
  async function check(target) {
    const result = target.kind === 'tcp' ? await checkTcp(target) : await checkHttp(target);
    logger.debug(
      { target: target.id, ok: result.ok, detail: result.detail },
      'Cluster service checked',
    );
    return result;
  }

  return { check };
}

/**
 * Default TCP probe: resolves on connect, rejects on error/timeout.
 *
 * @param {{ host: string, port: number, timeoutMs: number }} opts
 * @returns {Promise<void>}
 */
function defaultTcpConnect({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * @typedef {Object} CheckResult
 * @property {boolean} ok
 * @property {string} [detail] - failure reason when ok is false
 */

/**
 * @typedef {Object} ClusterHealthChecker
 * @property {(target: import('./cluster-targets.js').ClusterTarget) => Promise<CheckResult>} check
 */
