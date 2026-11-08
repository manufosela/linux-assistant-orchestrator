import { ACTIONABLE_DOMAINS } from '../../home-assistant/ha-fast-path.js';

/** Las persianas no tienen turn_on/turn_off: encender = abrir, apagar = cerrar. */
const SERVICES = { cover: { on: 'open_cover', off: 'close_cover' } };
const DEFAULT_SERVICES = { on: 'turn_on', off: 'turn_off' };
const DONE_LABELS = { on: 'encendido', off: 'apagado' };

/**
 * Herramienta del agente: enciende o apaga un aparato de Home Assistant
 * (LUI-TSK-0135). Solo actúa sobre los mismos tipos que ya permite
 * «enciende/apaga X» (decisión del usuario 2026-11-08), sobre entidades que
 * existen de verdad, y deja cada acción en el log.
 *
 * @param {{
 *   fetchStates: () => Promise<Array<{ entity_id: string, attributes?: object }>>,
 *   haClient: Pick<import('../../home-assistant/ha-client.js').HomeAssistantClient, 'callService'>,
 *   logger: Pick<import('pino').Logger, 'info'>,
 * }} deps
 * @returns {import('../tool-registry.js').AgentTool}
 */
export function createHomeControlTool({ fetchStates, haClient, logger }) {
  return {
    name: 'control_home_device',
    description:
      'Enciende o apaga un aparato de la casa en Home Assistant (luces, enchufes, persianas, ventiladores, '
      + 'calefacción, automatizaciones...). Necesita el id exacto: búscalo antes con get_home_state. '
      + 'En persianas, on = abrir y off = cerrar. Úsala solo cuando el usuario lo pida.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Id exacto de la entidad, p. ej. "light.esquina".' },
        action: { type: 'string', enum: ['on', 'off'], description: 'on = encender/abrir, off = apagar/cerrar.' },
      },
      required: ['entity_id', 'action'],
    },
    async execute({ entity_id: entityId, action }) {
      const domain = entityId.split('.')[0];
      if (!ACTIONABLE_DOMAINS.includes(domain)) {
        throw new Error(`Los aparatos de tipo ${domain} no se pueden encender ni apagar desde el chat`);
      }
      const entity = (await fetchStates()).find((state) => state.entity_id === entityId);
      if (!entity) {
        throw new Error(`No existe ${entityId} en Home Assistant: busca el id con get_home_state`);
      }
      const service = (SERVICES[domain] ?? DEFAULT_SERVICES)[action];
      logger.info({ entity: entityId, service: `${domain}.${service}` }, 'Agent home action');
      await haClient.callService(domain, service, { entity_id: entityId });
      return { hecho: true, aparato: entity.attributes?.friendly_name ?? entityId, accion: DONE_LABELS[action] };
    },
  };
}
