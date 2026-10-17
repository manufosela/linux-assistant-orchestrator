import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherForecastTool } from '../../../../src/modules/agent/tools/weather-forecast-tool.js';
import { createWebSearchTool } from '../../../../src/modules/agent/tools/web-search-tool.js';

const openMeteo = {
  current: { temperature_2m: 14.2, weather_code: 3 },
  daily: {
    time: ['2026-10-17', '2026-10-18'],
    temperature_2m_max: [19.4, 17.0],
    temperature_2m_min: [9.1, 8.0],
    precipitation_probability_max: [80, 10],
    precipitation_sum: [4.2, 0],
    weather_code: [61, 1],
  },
};

describe('get_weather_forecast tool', () => {
  it('asks Open-Meteo for the configured place and summarises it in Spanish', async () => {
    let requested;
    const tool = createWeatherForecastTool({
      latitude: 40.1,
      longitude: -3.2,
      fetchFn: async (url) => { requested = new URL(url); return { ok: true, json: async () => openMeteo }; },
    });

    const result = await tool.execute({ days: 2 });

    assert.equal(tool.name, 'get_weather_forecast');
    assert.equal(requested.searchParams.get('latitude'), '40.1');
    assert.equal(requested.searchParams.get('forecast_days'), '2');
    assert.deepEqual(result.ahora, { temperatura: 14.2, cielo: 'nublado' });
    assert.deepEqual(result.dias[0], {
      fecha: '2026-10-17', maxima: 19.4, minima: 9.1, probabilidadLluvia: 80, lluviaMm: 4.2, cielo: 'lluvia',
    });
    assert.equal(result.dias[1].cielo, 'poco nuboso');
  });

  it('defaults to one day and clamps the range to 1-7', async () => {
    const days = [];
    const tool = createWeatherForecastTool({
      latitude: 1,
      longitude: 1,
      fetchFn: async (url) => { days.push(new URL(url).searchParams.get('forecast_days')); return { ok: true, json: async () => openMeteo }; },
    });

    await tool.execute({});
    await tool.execute({ days: 30 });

    assert.deepEqual(days, ['1', '7']);
  });

  it('throws a clear error when Open-Meteo fails', async () => {
    const tool = createWeatherForecastTool({ latitude: 1, longitude: 1, fetchFn: async () => ({ ok: false, status: 503 }) });

    await assert.rejects(tool.execute({}), /Open-Meteo HTTP 503/);
  });

  it('refuses to be built without coordinates', () => {
    assert.throws(() => createWeatherForecastTool({ latitude: null, longitude: 1 }), /coordenadas/);
  });
});

describe('web_search tool', () => {
  it('returns the first results with title, url and snippet', async () => {
    const webSearch = {
      search: async (query, options) => {
        assert.equal(query, 'tiempo Madrid');
        assert.equal(options.maxResults, 5);
        return [{ title: 'AEMET', url: 'https://aemet.es', snippet: 'Lluvia por la tarde', extra: 'x' }];
      },
    };
    const tool = createWebSearchTool({ webSearch });

    const result = await tool.execute({ query: 'tiempo Madrid' });

    assert.equal(tool.parameters.required[0], 'query');
    assert.deepEqual(result, [{ titulo: 'AEMET', url: 'https://aemet.es', extracto: 'Lluvia por la tarde' }]);
  });
});
