/**
 * Builds the static cluster topology.
 *
 * The service layout (ports, paths, check kind) is fixed infrastructure and lives
 * here in code. Only the node IPs are configurable via env, so the physical
 * addresses can change without a code change.
 *
 * The node IPs are deployment-specific and must be supplied (via the
 * `CLUSTER_N2_IP`/`CLUSTER_N3_IP`/`CLUSTER_N4_IP` env vars, surfaced through
 * config). No LAN address is hardcoded so the repo is environment-agnostic.
 *
 * @param {{ n2Ip: string, n3Ip: string, n4Ip: string }} ips
 * @returns {ClusterTarget[]}
 */
export function buildClusterTargets({ n2Ip, n3Ip, n4Ip } = {}) {
  if (!n2Ip || !n3Ip || !n4Ip) {
    throw new Error(
      'buildClusterTargets requires n2Ip, n3Ip and n4Ip. ' +
        'Set CLUSTER_N2_IP, CLUSTER_N3_IP and CLUSTER_N4_IP (see DEPLOYMENT.md).',
    );
  }

  const ipN2 = n2Ip;
  const ipN3 = n3Ip;
  const ipN4 = n4Ip;

  return [
    // LiteLLM's /health requires the API key (401 without it). /health/liveliness
    // is the unauthenticated liveness probe meant exactly for monitoring.
    { id: 'n2:litellm', node: 'n2', service: 'LiteLLM', host: ipN2, port: 8080, kind: 'http', path: '/health/liveliness' },
    { id: 'n2:ollama', node: 'n2', service: 'Ollama', host: ipN2, port: 11434, kind: 'http', path: '/api/tags' },
    { id: 'n2:webui', node: 'n2', service: 'Open WebUI', host: ipN2, port: 3000, kind: 'http', path: '/' },
    { id: 'n3:ollama', node: 'n3', service: 'Ollama', host: ipN3, port: 11434, kind: 'http', path: '/api/tags' },
    { id: 'n3:n8n', node: 'n3', service: 'n8n', host: ipN3, port: 5678, kind: 'http', path: '/healthz' },
    { id: 'n4:ollama', node: 'n4', service: 'Ollama', host: ipN4, port: 11434, kind: 'http', path: '/api/tags' },
    { id: 'n4:qdrant', node: 'n4', service: 'Qdrant', host: ipN4, port: 6333, kind: 'http', path: '/healthz' },
    { id: 'n4:postgres', node: 'n4', service: 'Postgres', host: ipN4, port: 5432, kind: 'tcp' },
  ];
}

/**
 * @typedef {Object} ClusterTarget
 * @property {string} id - stable identifier, e.g. "n3:ollama"
 * @property {string} node - logical node name (n2/n3/n4)
 * @property {string} service - human-readable service name
 * @property {string} host - IP address
 * @property {number} port
 * @property {'http'|'tcp'} kind - probe strategy
 * @property {string} [path] - HTTP path expected to answer 200 (http kind only)
 */
