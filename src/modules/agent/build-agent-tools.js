import { createWeatherForecastTool } from './tools/weather-forecast-tool.js';
import { createWebSearchTool } from './tools/web-search-tool.js';

/**
 * Builds the tools the Telegram agent may use from the services LUIS has
 * configured (LUI-TSK-0111). A tool whose service is missing is not offered
 * to the model, and the reason is logged.
 *
 * @param {{
 *   weather: { latitude: number|null, longitude: number|null },
 *   webSearch?: Pick<import('../web/web-search.js').WebSearchService, 'search'>,
 *   logger: import('pino').Logger,
 * }} deps
 * @returns {import('./tool-registry.js').AgentTool[]}
 */
export function buildAgentTools({ weather, webSearch, logger }) {
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
