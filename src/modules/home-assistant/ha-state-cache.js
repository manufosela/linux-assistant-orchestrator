/**
 * In-memory cache of Home Assistant areas and entities, refreshed periodically.
 *
 * Built so the "fast path" can answer common questions ("qué temperatura hace en el despacho")
 * without sending the full entity catalogue to the LLM. Uses HA's template API to fetch the
 * area→entities mapping in a single round-trip.
 *
 * @param {{
 *   baseUrl: string,
 *   token: string,
 *   logger: import('pino').Logger,
 *   refreshIntervalMs?: number,
 *   timeoutMs?: number,
 * }} deps
 * @returns {HomeAssistantStateCache}
 */
export function createHomeAssistantStateCache({
  baseUrl,
  token,
  logger,
  refreshIntervalMs = 60 * 60 * 1000,
  timeoutMs = 30_000,
}) {
  const normalisedBase = String(baseUrl ?? '').replace(/\/+$/, '');
  /** @type {{ areas: Array<{id: string, name: string}>, entities: EntitySnapshot[], generatedAt: Date | null }} */
  const cache = { areas: [], entities: [], generatedAt: null };
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  /**
   * Fetches a fresh snapshot of all areas + their entities + state attributes.
   *
   * @returns {Promise<void>}
   */
  async function refresh() {
    const template = buildIndexTemplate();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${normalisedBase}/api/template`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ template }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HA template HTTP ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      const parsed = JSON.parse(text);
      cache.areas = Array.isArray(parsed?.areas) ? parsed.areas : [];
      cache.entities = Array.isArray(parsed?.entities) ? parsed.entities : [];
      cache.generatedAt = new Date();
      logger?.info(
        { areas: cache.areas.length, entities: cache.entities.length },
        'HA state cache refreshed',
      );
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Loads an initial snapshot and schedules periodic refreshes.
   *
   * @returns {Promise<void>}
   */
  async function start() {
    await refresh();
    timer = setInterval(() => {
      refresh().catch((error) => logger?.warn({ err: error?.message }, 'HA cache refresh failed'));
    }, refreshIntervalMs);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  /**
   * Stops the refresh schedule.
   */
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /**
   * Returns the area whose id, name or normalised form matches the query, or null.
   *
   * @param {string} query
   * @returns {{ id: string, name: string } | null}
   */
  function findArea(query) {
    const norm = normaliseAreaName(query);
    if (!norm) return null;
    return (
      cache.areas.find((area) => normaliseAreaName(area.id) === norm)
      ?? cache.areas.find((area) => normaliseAreaName(area.name) === norm)
      ?? null
    );
  }

  /**
   * Returns entities matching the optional filters within an area (or across all areas if
   * areaQuery is omitted). Filters are AND-combined.
   *
   * @param {{ areaQuery?: string, domain?: string, deviceClass?: string }} options
   * @returns {EntitySnapshot[]}
   */
  function findEntities({ areaQuery, domain, deviceClass } = {}) {
    let pool = cache.entities;
    if (areaQuery) {
      const area = findArea(areaQuery);
      if (!area) return [];
      pool = pool.filter((entity) => entity.area_id === area.id);
    }
    return pool.filter((entity) => {
      if (domain && entity.domain !== domain) return false;
      if (deviceClass && entity.device_class !== deviceClass) return false;
      return true;
    });
  }

  /**
   * Returns the list of areas (id + name).
   *
   * @returns {Array<{ id: string, name: string }>}
   */
  function listAreas() {
    return cache.areas.map((area) => ({ id: area.id, name: area.name }));
  }

  /**
   * Searches entities whose friendly_name (or entity_id) matches the query. Used by the fast
   * path for "enciende luz esquina" style commands. Includes entities WITHOUT an assigned area.
   *
   * Matching strategy:
   *  1. Exact match against the normalised friendly_name.
   *  2. Otherwise, all entities whose normalised friendly_name+entity_id contains every word
   *     of the query.
   *
   * Optional `domains` filter restricts the search to actionable domains.
   *
   * @param {string} query
   * @param {{ domains?: string[] }} [options]
   * @returns {EntitySnapshot[]}
   */
  function findEntitiesByName(query, options = {}) {
    const norm = normaliseAreaName(query);
    if (!norm) return [];
    const words = norm.split(/\s+/).filter(Boolean);
    const allowedDomains = options.domains;

    const pool = allowedDomains
      ? cache.entities.filter((entity) => allowedDomains.includes(entity.domain))
      : cache.entities;

    const exact = pool.filter((entity) => normaliseAreaName(entity.friendly_name) === norm);
    if (exact.length > 0) return exact;

    return pool.filter((entity) => {
      const haystack = `${normaliseAreaName(entity.friendly_name)} ${normaliseAreaName(entity.entity_id)}`;
      return words.every((word) => haystack.includes(word));
    });
  }

  return {
    start,
    stop,
    refresh,
    findArea,
    findEntities,
    findEntitiesByName,
    listAreas,
    get generatedAt() { return cache.generatedAt; },
    get areaCount() { return cache.areas.length; },
  };
}

/**
 * Returns a Jinja template that produces a JSON object with two keys:
 *  - `areas`: id + name of every area in HA
 *  - `entities`: every entity in HA with its domain, friendly_name, device_class, state,
 *    unit, area_id (or empty), area_name (or empty)
 *
 * Includes entities not assigned to any area, so the fast path can match by name even when
 * the user has not bothered to assign rooms.
 *
 * @returns {string}
 */
function buildIndexTemplate() {
  return [
    "{",
    "  \"areas\": [",
    "    {%- for area_id in areas() -%}",
    "      { \"id\": \"{{ area_id }}\", \"name\": {{ area_name(area_id) | tojson }} }{{ ',' if not loop.last else '' }}",
    "    {%- endfor -%}",
    "  ],",
    "  \"entities\": [",
    "    {%- for ent in states -%}",
    "      {",
    "        \"entity_id\": \"{{ ent.entity_id }}\",",
    "        \"domain\": \"{{ ent.entity_id.split('.')[0] }}\",",
    "        \"friendly_name\": {{ (ent.attributes.friendly_name or ent.entity_id) | tojson }},",
    "        \"device_class\": {{ (ent.attributes.device_class or '') | tojson }},",
    "        \"state\": {{ ent.state | tojson }},",
    "        \"unit\": {{ (ent.attributes.unit_of_measurement or '') | tojson }},",
    "        \"area_id\": {{ (area_id(ent.entity_id) or '') | tojson }},",
    "        \"area_name\": {{ (area_name(ent.entity_id) or '') | tojson }}",
    "      }{{ ',' if not loop.last else '' }}",
    "    {%- endfor -%}",
    "  ]",
    "}",
  ].join('\n');
}

/**
 * Normalises an area name for matching: lowercase, strip diacritics, drop common Spanish
 * articles, collapse whitespace.
 *
 * @param {string} input
 * @returns {string}
 */
export function normaliseAreaName(input) {
  return String(input ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/^\s*(el|la|los|las|del|de la|de los|de las)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @typedef {Object} EntitySnapshot
 * @property {string} entity_id
 * @property {string} domain
 * @property {string} friendly_name
 * @property {string} device_class
 * @property {string} state
 * @property {string} unit
 * @property {string} area_id
 * @property {string} area_name
 */

/**
 * @typedef {Object} HomeAssistantStateCache
 * @property {() => Promise<void>} start
 * @property {() => void} stop
 * @property {() => Promise<void>} refresh
 * @property {(query: string) => { id: string, name: string } | null} findArea
 * @property {(options?: { areaQuery?: string, domain?: string, deviceClass?: string }) => EntitySnapshot[]} findEntities
 * @property {(query: string, options?: { domains?: string[] }) => EntitySnapshot[]} findEntitiesByName
 * @property {() => Array<{ id: string, name: string }>} listAreas
 * @property {Date | null} generatedAt
 * @property {number} areaCount
 */
