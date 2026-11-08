/**
 * Herramienta del agente: estado ahora mismo de los nodos del cluster y sus
 * servicios (LUI-TSK-0136). Sondea en cada llamada, como el comando /cluster.
 *
 * @param {{ clusterStatus: Pick<import('../../cluster/cluster-status-service.js').ClusterStatusService, 'probe'> }} deps
 * @returns {import('../tool-registry.js').AgentTool}
 */
export function createNodesStatusTool({ clusterStatus }) {
  return {
    name: 'get_nodes_status',
    description:
      'Estado ahora mismo de los nodos del cluster de casa y de sus servicios (modelos de IA, etc.): '
      + 'si responden o están caídos. Úsala para «¿hay algo caído?» o «¿cómo están los nodos?».',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      const entries = await clusterStatus.probe();
      return {
        caidos: entries.filter((entry) => !entry.ok).length,
        servicios: entries.map(({ node, service, ok, detail }) => ({
          nodo: node,
          servicio: service,
          estado: ok ? 'OK' : 'CAÍDO',
          ...(!ok && detail ? { detalle: withoutAddresses(detail) } : {}),
        })),
      };
    },
  };
}

/**
 * El detalle de un error de sondeo puede traer la URL o la IP del nodo: el
 * modelo no las necesita para contestar, así que se quitan.
 *
 * @param {string} detail
 * @returns {string}
 */
function withoutAddresses(detail) {
  return String(detail)
    .replaceAll(/https?:\/\/[^\s)]+/g, '[dirección]')
    .replaceAll(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[dirección]');
}
