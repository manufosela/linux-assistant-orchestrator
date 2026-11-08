import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHomeControlTool } from '../../../../src/modules/agent/tools/home-control-tool.js';

const STATES = [
  { entity_id: 'light.esquina', state: 'off', attributes: { friendly_name: 'Luz esquina' } },
  { entity_id: 'cover.persiana_salon', state: 'open', attributes: { friendly_name: 'Persiana salón' } },
  { entity_id: 'sensor.temperatura_salon', state: '20.1', attributes: { friendly_name: 'Temperatura Salón' } },
  { entity_id: 'lock.puerta', state: 'locked', attributes: { friendly_name: 'Puerta' } },
];

function setup() {
  const calls = [];
  const logs = [];
  const tool = createHomeControlTool({
    fetchStates: async () => STATES,
    haClient: { callService: async (domain, service, data) => { calls.push({ domain, service, data }); return []; } },
    logger: { info: (obj, msg) => logs.push({ obj, msg }) },
  });
  return { tool, calls, logs };
}

describe('control_home_device tool', () => {
  it('turns a device on through Home Assistant and logs the action', async () => {
    const { tool, calls, logs } = setup();

    const result = await tool.execute({ entity_id: 'light.esquina', action: 'on' });

    assert.deepEqual(calls, [{ domain: 'light', service: 'turn_on', data: { entity_id: 'light.esquina' } }]);
    assert.deepEqual(result, { hecho: true, aparato: 'Luz esquina', accion: 'encendido' });
    assert.deepEqual(logs, [{ obj: { entity: 'light.esquina', service: 'light.turn_on' }, msg: 'Agent home action' }]);
  });

  it('opens and closes covers, which have no turn_on/turn_off', async () => {
    const { tool, calls } = setup();

    await tool.execute({ entity_id: 'cover.persiana_salon', action: 'off' });

    assert.deepEqual(calls[0], { domain: 'cover', service: 'close_cover', data: { entity_id: 'cover.persiana_salon' } });
  });

  it('refuses types it may not touch, without calling Home Assistant', async () => {
    const { tool, calls } = setup();

    await assert.rejects(() => tool.execute({ entity_id: 'lock.puerta', action: 'off' }), /no se pueden encender ni apagar/);
    await assert.rejects(() => tool.execute({ entity_id: 'sensor.temperatura_salon', action: 'on' }), /no se pueden encender ni apagar/);
    assert.equal(calls.length, 0);
  });

  it('refuses an entity that does not exist instead of guessing', async () => {
    const { tool, calls } = setup();

    await assert.rejects(() => tool.execute({ entity_id: 'light.cocina', action: 'on' }), /No existe.*get_home_state/);
    assert.equal(calls.length, 0);
  });

  it('declares entity and action as required', () => {
    const { tool } = setup();

    assert.equal(tool.name, 'control_home_device');
    assert.deepEqual(tool.parameters.required, ['entity_id', 'action']);
    assert.deepEqual(tool.parameters.properties.action.enum, ['on', 'off']);
  });
});
