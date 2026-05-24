/**
 * Creates a stateless cluster status service.
 *
 * Unlike the watcher (which lives in the daemon and keeps in-memory state),
 * this service performs a fresh, on-demand probe of every target. It is what
 * the CLI and the Telegram `/cluster` command use, since those run outside the
 * daemon process and cannot read its memory.
 *
 * @param {{
 *   healthChecker: import('./cluster-health-checker.js').ClusterHealthChecker,
 *   targets: import('./cluster-targets.js').ClusterTarget[],
 *   historyStore: import('./cluster-history-store.js').ClusterHistoryStore,
 * }} deps
 * @returns {ClusterStatusService}
 */
export function createClusterStatusService({ healthChecker, targets, historyStore }) {
  /**
   * Probes every target right now, in parallel.
   *
   * @returns {Promise<LiveStatusEntry[]>}
   */
  async function probe() {
    return Promise.all(
      targets.map(async (target) => {
        const { ok, detail } = await healthChecker.check(target);
        return {
          node: target.node,
          service: target.service,
          address: `${target.host}:${target.port}`,
          ok,
          detail: detail ?? null,
        };
      }),
    );
  }

  /**
   * @returns {Promise<import('./cluster-history-store.js').ClusterIncident[]>}
   */
  async function history() {
    return historyStore.read();
  }

  return { probe, history };
}

/**
 * Formats a live probe result as plain-text lines (no colour, no markup) so the
 * same output works in the terminal and inside a Telegram code block.
 *
 * @param {LiveStatusEntry[]} entries
 * @returns {string[]}
 */
export function formatClusterStatus(entries) {
  if (entries.length === 0) return ['(sin servicios configurados)'];

  const rows = entries.map((entry) => ({
    icon: entry.ok ? '✅' : '⚠️',
    node: entry.node,
    service: entry.service,
    address: entry.address,
    state: entry.ok ? 'OK' : `CAÍDO${entry.detail ? ` (${entry.detail})` : ''}`,
  }));

  const nodeW = Math.max(4, ...rows.map((r) => r.node.length));
  const svcW = Math.max(7, ...rows.map((r) => r.service.length));
  const addrW = Math.max(7, ...rows.map((r) => r.address.length));

  const header = `   ${'NODO'.padEnd(nodeW)}  ${'SERVICIO'.padEnd(svcW)}  ${'DIRECCIÓN'.padEnd(addrW)}  ESTADO`;
  const lines = [header];
  for (const r of rows) {
    lines.push(`${r.icon} ${r.node.padEnd(nodeW)}  ${r.service.padEnd(svcW)}  ${r.address.padEnd(addrW)}  ${r.state}`);
  }
  return lines;
}

/**
 * Formats the incident history (most recent first) as plain-text lines.
 *
 * @param {import('./cluster-history-store.js').ClusterIncident[]} incidents
 * @returns {string[]}
 */
export function formatClusterHistory(incidents) {
  if (incidents.length === 0) return ['Sin incidencias registradas.'];

  return [...incidents].reverse().map((incident) => {
    const icon = incident.type === 'recovered' ? '✅' : '⚠️';
    const verb = incident.type === 'recovered' ? 'recuperado' : 'caído';
    const when = formatTimestamp(incident.timestamp);
    const detail = incident.detail ? ` — ${incident.detail}` : '';
    return `${icon} ${when}  ${incident.service} en ${incident.node} ${verb} (${incident.address})${detail}`;
  });
}

/**
 * @param {string} iso
 * @returns {string}
 */
function formatTimestamp(iso) {
  try {
    const fmt = new Intl.DateTimeFormat('es-ES', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    return fmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * @typedef {Object} LiveStatusEntry
 * @property {string} node
 * @property {string} service
 * @property {string} address
 * @property {boolean} ok
 * @property {string|null} detail
 */

/**
 * @typedef {Object} ClusterStatusService
 * @property {() => Promise<LiveStatusEntry[]>} probe
 * @property {() => Promise<import('./cluster-history-store.js').ClusterIncident[]>} history
 */
