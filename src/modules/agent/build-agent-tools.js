import { createWeatherForecastTool } from './tools/weather-forecast-tool.js';
import { createWebSearchTool } from './tools/web-search-tool.js';
import { createHomeStateTool } from './tools/home-state-tool.js';
import { createHomeControlTool } from './tools/home-control-tool.js';
import { createNodesStatusTool } from './tools/nodes-status-tool.js';
import { createDailyReportTool } from './tools/daily-report-tool.js';
/**
 * Builds the tools the Telegram agent may use from the services LUIS has
 * configured (LUI-TSK-0111). A tool whose service is missing is not offered
 * to the model, and the reason is logged.
 *
 * @param {{
 *   weather: { latitude: number|null, longitude: number|null },
 *   webSearch?: Pick<import('../web/web-search.js').WebSearchService, 'search'>,
 *   fetchHaStates?: () => Promise<Array<{ entity_id: string, state: string, attributes?: object }>>,
 *   haClient?: Pick<import('../home-assistant/ha-client.js').HomeAssistantClient, 'callService'>,
 *   clusterStatus?: Pick<import('../cluster/cluster-status-service.js').ClusterStatusService, 'probe'>,
 *   notificationLog?: { today: () => Array<{ ts: string, text: string, urgent?: boolean }> },
 *   logger: import('pino').Logger,
 * }} deps
 * @returns {import('./tool-registry.js').AgentTool[]}
 */
export function buildAgentTools({ weather, webSearch, fetchHaStates, haClient, clusterStatus, notificationLog, logger }) {
  const tools = [];

  if (Number.isFinite(weather.latitude) && Number.isFinite(weather.longitude)) {
    tools.push(createWeatherForecastTool({ latitude: weather.latitude, longitude: weather.longitude }));
  } else {
    logger.warn({ tool: 'get_weather_forecast' }, 'Agent tool not registered: WEATHER_LAT/WEATHER_LON not set');
  }

  if (webSearch) {
    tools.push(createWebSearchTool({ webSearch }));
  } else {
    logger.warn({ tool: 'web_search' }, 'Agent tool not registered: web search (SearXNG) not configured');
  }

  if (fetchHaStates) {
    tools.push(createHomeStateTool({ fetchStates: fetchHaStates }));
  } else {
    logger.warn({ tool: 'get_home_state' }, 'Agent tool not registered: Home Assistant not configured');
  }

  if (fetchHaStates && haClient) {
    tools.push(createHomeControlTool({ fetchStates: fetchHaStates, haClient, logger }));
  } else {
    logger.warn({ tool: 'control_home_device' }, 'Agent tool not registered: Home Assistant not configured');
  }

  if (clusterStatus) {
    tools.push(createNodesStatusTool({ clusterStatus }));
  } else {
    logger.warn({ tool: 'get_nodes_status' }, 'Agent tool not registered: cluster status not configured');
  }

  if (notificationLog) {
    tools.push(createDailyReportTool({ notificationLog, fetchHaStates }));
  } else {
    logger.warn({ tool: 'get_daily_report' }, 'Agent tool not registered: notification log not configured');
  }

  return tools;
}

/**
 * Returns a copy of `messages` with the current local date and time as a
 * system message right after the system prompt, so the model can resolve
 * "hoy", "mañana" or "este fin de semana".
 *
 * @param {Array<{ role: string, content: string|null }>} messages
 * @param {Date} now
 * @param {string} timeZone
 * @returns {Array<{ role: string, content: string|null }>}
 */
export function withCurrentDate(messages, now, timeZone) {
  const formatted = new Intl.DateTimeFormat('es-ES', { dateStyle: 'full', timeStyle: 'short', timeZone }).format(now);
  const dateMessage = { role: 'system', content: `Fecha y hora actual en casa: ${formatted}.` };
  const insertAt = messages[0]?.role === 'system' ? 1 : 0;
  return messages.toSpliced(insertAt, 0, dateMessage);
}
