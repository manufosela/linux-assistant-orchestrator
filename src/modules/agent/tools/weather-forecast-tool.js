const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/** Códigos WMO de Open-Meteo agrupados en descripciones cortas en español. */
const SKY_BY_CODE = [
  [[0], 'despejado'],
  [[1], 'poco nuboso'],
  [[2], 'nubes y claros'],
  [[3], 'nublado'],
  [[45, 48], 'niebla'],
  [[51, 53, 55, 56, 57], 'llovizna'],
  [[61, 63, 65, 66, 67, 80, 81, 82], 'lluvia'],
  [[71, 73, 75, 77, 85, 86], 'nieve'],
  [[95, 96, 99], 'tormenta'],
];

/**
 * @param {number} code
 * @returns {string}
 */
function describeSky(code) {
  return SKY_BY_CODE.find(([codes]) => codes.includes(code))?.[1] ?? `código ${code}`;
}

/**
 * Herramienta del agente: previsión del tiempo en casa (LUI-TSK-0106).
 * Las coordenadas vienen de la config (WEATHER_LAT/LON), nunca del modelo.
 *
 * Open-Meteo responde 503 «service is overloaded» a ratos (LUI-BUG-0015): los
 * 5xx se reintentan `retries` veces antes de devolver el error al modelo.
 *
 * @param {{ latitude: number|null, longitude: number|null, fetchFn?: typeof fetch, retries?: number, retryDelayMs?: number }} deps
 * @returns {import('../tool-registry.js').AgentTool}
 */
export function createWeatherForecastTool({ latitude, longitude, fetchFn = fetch, retries = 2, retryDelayMs = 1000 }) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('get_weather_forecast necesita las coordenadas de casa (WEATHER_LAT/WEATHER_LON)');
  }

  return {
    name: 'get_weather_forecast',
    description:
      'Previsión del tiempo en casa: temperatura actual y, por día, máxima, mínima, '
      + 'probabilidad y cantidad de lluvia y estado del cielo. Úsala para cualquier pregunta sobre el tiempo.',
    parameters: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'Días de previsión desde hoy (1-7). Por defecto 1.' } },
      required: [],
    },
    async execute({ days = 1 }) {
      const forecastDays = Math.min(7, Math.max(1, days));
      const url = new URL(OPEN_METEO_URL);
      url.search = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: 'temperature_2m,weather_code',
        daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,weather_code',
        timezone: 'auto',
        forecast_days: String(forecastDays),
      }).toString();

      let response = await fetchFn(url.toString());
      for (let attempt = 0; attempt < retries && response?.status >= 500; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        response = await fetchFn(url.toString());
      }
      if (!response?.ok) throw new Error(`Open-Meteo HTTP ${response?.status}`);
      const { current, daily } = await response.json();

      return {
        ahora: { temperatura: current.temperature_2m, cielo: describeSky(current.weather_code) },
        dias: daily.time.map((fecha, i) => ({
          fecha,
          maxima: daily.temperature_2m_max[i],
          minima: daily.temperature_2m_min[i],
          probabilidadLluvia: daily.precipitation_probability_max[i],
          lluviaMm: daily.precipitation_sum[i],
          cielo: describeSky(daily.weather_code[i]),
        })),
      };
    },
  };
}
