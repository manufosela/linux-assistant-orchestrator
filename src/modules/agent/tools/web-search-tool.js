/**
 * Herramienta del agente: búsqueda en internet vía SearXNG (LUI-TSK-0106).
 *
 * @param {{ webSearch: Pick<import('../../web/web-search.js').WebSearchService, 'search'>, maxResults?: number }} deps
 * @returns {import('../tool-registry.js').AgentTool}
 */
export function createWebSearchTool({ webSearch, maxResults = 5 }) {
  return {
    name: 'web_search',
    description:
      'Busca en internet. Úsala para actualidad, datos que no conoces o que cambian '
      + '(noticias, horarios, precios, resultados). Devuelve título, URL y extracto de los primeros resultados.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Consulta de búsqueda, concisa.' } },
      required: ['query'],
    },
    async execute({ query }) {
      const results = await webSearch.search(query, { maxResults });
      return results.map(({ title, url, snippet }) => ({ titulo: title, url, extracto: snippet }));
    },
  };
}
