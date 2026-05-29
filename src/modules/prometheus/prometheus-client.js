import { createHttpClient } from '../../infrastructure/http/create-http-client.js';

/**
 * Creates an on-demand Prometheus client.
 *
 * This is deliberately stateless: there is no watcher and no proactive
 * alerting. It exists so the assistant can answer "is anything down?" when
 * the user explicitly asks, by querying the Prometheus HTTP API.
 *
 * @param {{
 *   baseUrl: string,
 *   timeoutMs?: number,
 *   logger?: import('pino').Logger,
 *   httpClient?: import('../../infrastructure/http/create-http-client.js').HttpClient,
 * }} deps
 * @returns {PrometheusClient}
 */
export function createPrometheusClient({ baseUrl, timeoutMs = 8000, logger, httpClient } = {}) {
  // httpClient is injectable so the module can be unit-tested without a network.
  const client = httpClient ?? createHttpClient({ baseUrl, defaultTimeoutMs: timeoutMs });

  /**
   * Runs an instant PromQL query and returns its result vector.
   *
   * @param {string} promql
   * @returns {Promise<Array<{ metric: Record<string, string>, value: [number, string] }>>}
   */
  async function queryVector(promql) {
    const response = await client.get(`/api/v1/query?query=${encodeURIComponent(promql)}`);
    if (!response || response.status !== 'success') {
      throw new Error(`Prometheus query "${promql}" returned an unexpected response`);
    }
    return response.data?.result ?? [];
  }

  /**
   * Fetches the alerts known to Prometheus (firing, pending and inactive).
   *
   * @returns {Promise<Array<object>>}
   */
  async function getActiveAlerts() {
    const response = await client.get('/api/v1/alerts');
    if (!response || response.status !== 'success') {
      throw new Error('Prometheus /api/v1/alerts returned an unexpected response');
    }
    return response.data?.alerts ?? [];
  }

  /**
   * Builds the on-demand "is anything down?" report by combining three signals:
   *  - `up`             → scrape targets / exporters that are unreachable.
   *  - `probe_success`  → HTTP services checked via blackbox-exporter.
   *  - firing alerts    → whatever the Prometheus alert rules flag.
   *
   * Throws if Prometheus itself is unreachable, so callers can report it.
   *
   * @returns {Promise<DownReport>}
   */
  async function getDownReport() {
    const [upSeries, probeSeries, alerts] = await Promise.all([
      queryVector('up'),
      queryVector('probe_success'),
      getActiveAlerts(),
    ]);

    const isDown = (series) => Number(series.value?.[1]) === 0;
    const toEndpoint = (series) => ({
      job: series.metric?.job ?? 'desconocido',
      instance: series.metric?.instance ?? '',
    });

    const downTargets = upSeries.filter(isDown).map(toEndpoint);
    const downProbes = probeSeries.filter(isDown).map(toEndpoint);
    const firingAlerts = alerts
      .filter((alert) => alert.state === 'firing')
      .map((alert) => ({
        name: alert.labels?.alertname ?? 'alerta',
        severity: alert.labels?.severity ?? '',
        summary: alert.annotations?.summary ?? alert.annotations?.description ?? '',
        activeAt: alert.activeAt ?? null,
      }));

    const report = {
      totalTargets: upSeries.length,
      totalProbes: probeSeries.length,
      downTargets,
      downProbes,
      firingAlerts,
      anythingDown: downTargets.length > 0 || downProbes.length > 0 || firingAlerts.length > 0,
    };

    logger?.debug(
      { anythingDown: report.anythingDown, down: downTargets.length + downProbes.length, firing: firingAlerts.length },
      'Prometheus down report built',
    );
    return report;
  }

  return { getDownReport, queryVector, getActiveAlerts };
}

/**
 * @typedef {Object} DownReport
 * @property {number} totalTargets - scrape targets reporting an `up` value
 * @property {number} totalProbes - HTTP services reporting a `probe_success` value
 * @property {Array<{ job: string, instance: string }>} downTargets
 * @property {Array<{ job: string, instance: string }>} downProbes
 * @property {Array<{ name: string, severity: string, summary: string, activeAt: string|null }>} firingAlerts
 * @property {boolean} anythingDown
 */

/**
 * @typedef {Object} PrometheusClient
 * @property {() => Promise<DownReport>} getDownReport
 * @property {(promql: string) => Promise<Array<object>>} queryVector
 * @property {() => Promise<Array<object>>} getActiveAlerts
 */
