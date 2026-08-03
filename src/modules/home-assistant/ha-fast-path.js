import { normaliseAreaName } from './ha-state-cache.js';

const ACTIONABLE_DOMAINS = ['light', 'switch', 'media_player', 'cover', 'fan', 'climate', 'automation', 'script', 'input_boolean', 'humidifier'];

/**
 * Pattern-based fast path for the most common Home Assistant questions and commands.
 *
 * Tries to resolve the user's request from the local cache without invoking the LLM. Returns
 * a {@link FastPathResult} with `handled: true` and a ready-to-speak reply on success, or
 * `null` when the pattern does not match — the caller is then expected to fall back to the
 * regular conversation flow (Ollama via HA).
 *
 * Patterns covered today:
 *  - "qué temperatura hace en X"
 *  - "qué humedad hay en X"
 *  - "qué temperatura/humedad media hay en casa" (or "en toda la casa")
 *  - "lista las áreas" / "qué áreas hay"
 *  - "enciende X" / "apaga X" / "prende X"
 *
 * @param {{
 *   text: string,
 *   stateCache: import('./ha-state-cache.js').HomeAssistantStateCache,
 *   haClient?: import('./ha-client.js').HomeAssistantClient,
 *   logger?: import('pino').Logger,
 *   houseAverageFilter?: (sensor: object) => boolean,
 * }} input
 * @returns {Promise<FastPathResult | null>}
 */
export async function tryFastPath({ text, stateCache, haClient, logger, houseAverageFilter }) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase().replace(/[?¿!¡.,]/g, '');

  if (matchesAreaList(lower)) {
    return handleAreaList(stateCache);
  }

  // Temperatura/humedad por INTENCIÓN, no por frase exacta (LUI-TSK-0085): se
  // detecta el tipo por sinónimos (temperatura/calor/frío/grados/clima, humedad)
  // y se decide por área concreta o media de la casa según se nombre o no un
  // sitio. Así el usuario pregunta como quiera sin memorizar frases.
  const deviceClass = matchTempHumidity(lower);
  if (deviceClass) {
    const area = extractAreaPhrase(lower);
    if (area) {
      return handleSensorByArea(stateCache, deviceClass, area, logger);
    }
    return handleHouseAverage(stateCache, deviceClass, houseAverageFilter);
  }

  const onOff = matchesOnOff(lower);
  if (onOff && haClient) {
    return handleOnOff(stateCache, haClient, onOff.action, onOff.target, logger);
  }

  return null;
}

/**
 * Detects "lista las áreas", "qué áreas hay", "cuántas habitaciones tienes".
 *
 * @param {string} lower
 * @returns {boolean}
 */
function matchesAreaList(lower) {
  return /(?:lista|listame|enumera|cuales? son|que|qu[eé]).*[áa]reas?\b/.test(lower)
    || /(?:cuant[oa]s?|que).*habitaciones?\b/.test(lower);
}

/**
 * @param {import('./ha-state-cache.js').HomeAssistantStateCache} stateCache
 * @returns {FastPathResult}
 */
function handleAreaList(stateCache) {
  const areas = stateCache.listAreas();
  if (areas.length === 0) {
    return { handled: true, speech: 'No hay áreas configuradas en Home Assistant.' };
  }
  const names = areas.map((a) => a.name).sort((a, b) => a.localeCompare(b));
  return {
    handled: true,
    speech: `Tienes ${areas.length} áreas: ${names.join(', ')}.`,
  };
}

/**
 * Detecta el tipo de sensor (temperatura/humedad) por INTENCIÓN, tolerante a
 * sinónimos y redacción libre: "temperatura", "calor", "frío", "grados",
 * "clima", "termómetro" → temperatura; "humedad", "húmedo" → humedad. Así el
 * usuario no depende de una frase concreta.
 *
 * @param {string} lower  texto en minúsculas y sin signos
 * @returns {'temperature' | 'humidity' | null}
 */
function matchTempHumidity(lower) {
  if (/\b(?:temperatura|termometr|term[oó]metr|grados?|calor|fr[ií]o|clima)\b/.test(lower)) return 'temperature';
  if (/\b(?:humedad|h[uú]med[oa]?s?)\b/.test(lower)) return 'humidity';
  return null;
}

/**
 * Extrae el ÁREA de una pregunta de temperatura/humedad ("...en el despacho",
 * "...del salón"). Devuelve null si no se nombra un sitio, o si el "sitio" es en
 * realidad la casa entera (casa/hogar/general/dentro/interior) → en ese caso el
 * llamador responde con la media de la casa.
 *
 * @param {string} lower
 * @returns {string | null}
 */
function extractAreaPhrase(lower) {
  const m = lower.match(/\b(?:en|del|de)\s+(.+?)\s*$/);
  if (!m) return null;
  const area = m[1].trim().replace(/^(?:el|la|los|las)\s+/, '').trim();
  if (!area) return null;
  if (/^(?:casa|hogar|general|interior|toda\s+la\s+casa)$/.test(area)) return null;
  if (/^(?:dentro|adentro)$/.test(area)) return null;
  return area;
}

/**
 * Media de la casa. `houseAverageFilter` (opcional) decide qué sensores cuentan;
 * es el MISMO filtro que usa el temperature-watcher, para que la respuesta a
 * "qué temperatura media hace en casa" y el aviso automático no se contradigan
 * (p.ej. la cocina y los exteriores quedan fuera de ambos). Sin filtro, se
 * mantiene el comportamiento previo: cuentan todos los sensores con lectura.
 *
 * Ojo: sólo aplica a la media de la casa. Preguntar explícitamente por un área
 * ("qué temperatura hace en la cocina") sigue respondiendo con su lectura.
 *
 * @param {import('./ha-state-cache.js').HomeAssistantStateCache} stateCache
 * @param {'temperature' | 'humidity'} deviceClass
 * @param {(sensor: object) => boolean} [houseAverageFilter]
 * @returns {FastPathResult}
 */
function handleHouseAverage(stateCache, deviceClass, houseAverageFilter) {
  const sensors = stateCache.findEntities({ deviceClass });
  const included = houseAverageFilter ? sensors.filter(houseAverageFilter) : sensors;
  // Suelo de cordura: en la media de la CASA (interior) descartamos lecturas
  // imposibles de sensores rotos (p.ej. el sensor de luz TS0222 reporta 0.0º/0%),
  // que si no falsearían la media. No se aplica a la consulta por área concreta
  // porque un exterior legítimo sí puede estar por debajo de 5º.
  const valid = included.filter((s) => isFiniteNumber(s.state) && Number(s.state) >= HOUSE_AVERAGE_PLAUSIBLE_MIN);
  if (valid.length === 0) {
    return {
      handled: true,
      speech: `No tengo lecturas de ${deviceClass === 'temperature' ? 'temperatura' : 'humedad'} disponibles.`,
    };
  }
  const values = valid.map((s) => Number(s.state));
  const avg = values.reduce((acc, v) => acc + v, 0) / values.length;
  const unit = valid[0].unit || (deviceClass === 'temperature' ? '°C' : '%');
  const label = deviceClass === 'temperature' ? 'Temperatura' : 'Humedad';
  return {
    handled: true,
    speech: `${label} media en casa: ${avg.toFixed(1)}${unit} (promedio de ${valid.length} sensores).`,
  };
}


/**
 * @param {import('./ha-state-cache.js').HomeAssistantStateCache} stateCache
 * @param {'temperature' | 'humidity'} deviceClass
 * @param {string} areaQuery
 * @param {import('pino').Logger} [logger]
 * @returns {FastPathResult}
 */
function handleSensorByArea(stateCache, deviceClass, areaQuery, logger) {
  const area = stateCache.findArea(areaQuery);
  if (!area) {
    logger?.debug({ areaQuery, normalised: normaliseAreaName(areaQuery) }, 'Fast path: area not found');
    return {
      handled: true,
      speech: `No conozco ningún área llamada "${areaQuery}".`,
    };
  }
  const sensors = stateCache.findEntities({ areaQuery: area.id, deviceClass });
  if (sensors.length === 0) {
    return {
      handled: true,
      speech: `No hay sensores de ${deviceClass === 'temperature' ? 'temperatura' : 'humedad'} expuestos en ${area.name}.`,
    };
  }
  const valid = sensors.filter((s) => isFiniteNumber(s.state));
  if (valid.length === 0) {
    return {
      handled: true,
      speech: `Los sensores de ${deviceClass === 'temperature' ? 'temperatura' : 'humedad'} en ${area.name} están sin lectura ahora mismo.`,
    };
  }
  if (valid.length === 1) {
    const s = valid[0];
    return {
      handled: true,
      speech: `${area.name}: ${s.state}${s.unit || ''}.`,
    };
  }
  const values = valid.map((s) => Number(s.state));
  const avg = values.reduce((acc, v) => acc + v, 0) / values.length;
  const unit = valid[0].unit || (deviceClass === 'temperature' ? '°C' : '%');
  return {
    handled: true,
    speech: `${area.name}: ${avg.toFixed(1)}${unit} (media de ${valid.length} sensores).`,
  };
}

/**
 * Detects "enciende X", "apaga X", "prende X", "apágalo", "ciérra Y", "abre Y".
 *
 * @param {string} lower
 * @returns {{ action: 'on' | 'off', target: string } | null}
 */
function matchesOnOff(lower) {
  const onMatch = lower.match(/^\s*(?:por favor\s+)?(?:enciende|prende|enciendeme|prendeme|activa|abre)\s+(?:el\s+|la\s+|los\s+|las\s+)?(.+?)\s*$/);
  if (onMatch) return { action: 'on', target: onMatch[1].trim() };

  const offMatch = lower.match(/^\s*(?:por favor\s+)?(?:apaga|apagame|desactiva|cierra|apag[áa]|apagalo|apagala)\s+(?:el\s+|la\s+|los\s+|las\s+)?(.+?)\s*$/);
  if (offMatch) return { action: 'off', target: offMatch[1].trim() };
  return null;
}

/**
 * Resolves the target entity by friendly_name and calls the appropriate turn_on/turn_off
 * service in HA.
 *
 * @param {import('./ha-state-cache.js').HomeAssistantStateCache} stateCache
 * @param {import('./ha-client.js').HomeAssistantClient} haClient
 * @param {'on' | 'off'} action
 * @param {string} target
 * @param {import('pino').Logger} [logger]
 * @returns {Promise<FastPathResult>}
 */
async function handleOnOff(stateCache, haClient, action, target, logger) {
  const matches = stateCache.findEntitiesByName(target, { domains: ACTIONABLE_DOMAINS });
  if (matches.length === 0) {
    return {
      handled: true,
      speech: `No encuentro ningún dispositivo llamado "${target}".`,
    };
  }
  if (matches.length > 1) {
    const names = matches.slice(0, 5).map((entity) => `${entity.friendly_name}${entity.area_name ? ` (${entity.area_name})` : ''}`);
    return {
      handled: true,
      speech: `Hay varios dispositivos que coinciden con "${target}": ${names.join(', ')}. Sé más específico.`,
    };
  }

  const entity = matches[0];
  const service = action === 'on' ? 'turn_on' : 'turn_off';
  try {
    await haClient.callService(entity.domain, service, { entity_id: entity.entity_id });
    const verb = action === 'on' ? 'Encendido' : 'Apagado';
    return {
      handled: true,
      speech: `${verb}: ${entity.friendly_name}${entity.area_name ? ` (${entity.area_name})` : ''}.`,
    };
  } catch (error) {
    logger?.warn({ err: error?.message, entity: entity.entity_id, service }, 'Fast path: callService failed');
    return {
      handled: true,
      speech: `No pude ${action === 'on' ? 'encender' : 'apagar'} ${entity.friendly_name}: ${error?.message ?? 'error desconocido'}.`,
    };
  }
}

// Suelo de cordura para la media de la casa (interior): descarta lecturas
// imposibles de sensores rotos (TS0222 de luz que marca 0.0º/0%). Ningún interior
// real baja de esto ni en invierno.
const HOUSE_AVERAGE_PLAUSIBLE_MIN = 5;

/**
 * @param {string} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  if (value == null) return false;
  if (value === 'unknown' || value === 'unavailable') return false;
  return Number.isFinite(Number(value));
}

/**
 * @typedef {Object} FastPathResult
 * @property {boolean} handled
 * @property {string} speech
 */
