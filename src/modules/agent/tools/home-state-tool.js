import { normaliseAreaName } from '../../home-assistant/ha-state-cache.js';

/** Tipos de entidad de HA que el modelo puede consultar. */
const READABLE_DOMAINS = [
  'climate', 'sensor', 'binary_sensor', 'switch', 'light', 'cover', 'fan', 'media_player',
  'device_tracker', 'person', 'input_boolean', 'automation', 'script', 'scene', 'humidifier', 'weather',
];

/** Atributos útiles para contestar, con el nombre que ve el modelo. El resto se omite. */
const USEFUL_ATTRIBUTES = [
  ['unit_of_measurement', 'unidad'],
  ['current_temperature', 'temperatura_actual'],
  ['temperature', 'temperatura_objetivo'],
  ['hvac_action', 'accion'],
  ['preset_mode', 'modo'],
  ['heating_power_request', 'potencia_pedida'],
  ['current_position', 'posicion'],
  ['brightness', 'brillo'],
];

/** Palabras de enlace que no forman parte de ningún nombre ("radiador del salón"). */
const STOP_WORDS = new Set(['de', 'del', 'el', 'la', 'los', 'las', 'en', 'y']);

/**
 * Palabras que nombran el TIPO de aparato y no aparecen en su nombre: el modelo
 * busca "calefacción" y ningún termostato se llama así. Se quitan de la búsqueda
 * y, si no se indicó tipo, lo fijan.
 */
const DOMAIN_WORDS = new Map([
  ['calefaccion', 'climate'], ['termostato', 'climate'], ['termostatos', 'climate'], ['climatizacion', 'climate'],
]);

const STATE_LABELS = { unavailable: 'no disponible (sin conexión)', unknown: 'sin dato' };

/**
 * Herramienta del agente: estado actual de la casa en Home Assistant
 * (LUI-TSK-0107). Lee /api/states en cada llamada, así que el dato es fresco.
 *
 * @param {{ fetchStates: () => Promise<Array<{ entity_id: string, state: string, attributes?: object }>>, maxResults?: number }} deps
 * @returns {import('../tool-registry.js').AgentTool}
 */
export function createHomeStateTool({ fetchStates, maxResults = 40 }) {
  return {
    name: 'get_home_state',
    description:
      'Estado actual de la casa en Home Assistant: calefacción y termostatos (climate), temperaturas y '
      + 'otros sensores, luces, enchufes, persianas, presencia, automatizaciones... Busca por palabras del '
      + 'nombre o la habitación y/o por tipo. Devuelve nombre, estado y, si los hay, temperatura actual y '
      + 'objetivo, si está calentando (accion=heating) y la potencia que pide cada radiador. '
      + 'Si no estás seguro del tipo, no lo pongas y busca solo por palabras (un enchufe puede llamarse '
      + '"luces"). Para la temperatura de una habitación busca la habitación sin tipo. Si la pregunta '
      + 'trata de varias cosas, llama una vez por cada una.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Palabras del nombre o la habitación, p. ej. "salón" o "radiador".' },
        domain: { type: 'string', enum: READABLE_DOMAINS, description: 'Tipo de entidad. climate = calefacción.' },
      },
      required: [],
    },
    async execute({ query, domain: requestedDomain }) {
      let domain = requestedDomain;
      const words = [];
      for (const word of normaliseAreaName(query).split(' ')) {
        if (!word || STOP_WORDS.has(word)) continue;
        if (DOMAIN_WORDS.has(word)) domain ??= DOMAIN_WORDS.get(word);
        else words.push(word);
      }
      if (words.length === 0 && !domain) {
        throw new Error('Indica query o domain: no se lista la casa entera');
      }
      const states = await fetchStates();
      let matches = findMatches(states, domain, words);
      const notes = [];
      // El modelo a veces acierta mal el tipo ("luces" que son un enchufe): si con
      // ese tipo no hay nada, se busca en todos antes de decir que no existe.
      if (matches.length === 0 && domain && words.length > 0) {
        matches = findMatches(states, null, words);
        if (matches.length > 0) notes.push(`Con el tipo ${domain} no hay nada; esto es lo que coincide en otros tipos.`);
      }
      if (matches.length > maxResults) {
        notes.push(`Solo van las ${maxResults} primeras: afina la búsqueda con más palabras o un tipo.`);
      }
      const result = { total: matches.length, entidades: matches.slice(0, maxResults).map(summarise) };
      if (notes.length > 0) result.aviso = notes.join(' ');
      return result;
    },
  };
}

/**
 * Entidades del tipo pedido (o de cualquier tipo legible) cuyo nombre o id
 * contiene todas las palabras.
 *
 * @param {Array<{ entity_id: string, attributes?: object }>} states
 * @param {string|null|undefined} domain
 * @param {string[]} words
 * @returns {Array<{ entity_id: string, state: string, attributes?: object }>}
 */
function findMatches(states, domain, words) {
  return states.filter((entity) => {
    const entityDomain = entity.entity_id.split('.')[0];
    if (domain ? entityDomain !== domain : !READABLE_DOMAINS.includes(entityDomain)) return false;
    const haystack = normaliseAreaName(`${entity.attributes?.friendly_name ?? ''} ${entity.entity_id.replaceAll('_', ' ')}`);
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * @param {{ entity_id: string, state: string, attributes?: object }} entity
 * @returns {object}
 */
function summarise({ entity_id: id, state, attributes = {} }) {
  const summary = { id, nombre: attributes.friendly_name ?? id, estado: STATE_LABELS[state] ?? state };
  for (const [attribute, label] of USEFUL_ATTRIBUTES) {
    if (attributes[attribute] !== undefined && attributes[attribute] !== null) summary[label] = attributes[attribute];
  }
  return summary;
}
