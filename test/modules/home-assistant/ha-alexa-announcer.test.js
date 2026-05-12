import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAlexaAnnouncer } from '../../../src/modules/home-assistant/ha-alexa-announcer.js';

function stubHaClient() {
  const calls = [];
  return {
    calls,
    async callService(domain, service, data) {
      calls.push({ domain, service, data });
    },
  };
}

describe('createAlexaAnnouncer', () => {
  it('defaults to broadcast (en_toda_la_casa) when no target is given', async () => {
    const haClient = stubHaClient();
    const announcer = createAlexaAnnouncer({ haClient });
    await announcer.announce('hola a todos');
    assert.equal(haClient.calls.length, 1);
    assert.equal(haClient.calls[0].domain, 'notify');
    assert.equal(haClient.calls[0].service, 'alexa_media_en_toda_la_casa');
    assert.deepEqual(haClient.calls[0].data, {
      message: 'hola a todos',
      data: { type: 'announce' },
    });
  });

  it('always sets data.type = "announce" so the Echo speaks the message', async () => {
    const haClient = stubHaClient();
    const announcer = createAlexaAnnouncer({ haClient });
    await announcer.announce('test', { target: 'salon' });
    assert.equal(haClient.calls[0].data.data.type, 'announce');
  });

  it('resolves alias "salon" → echo_salon', async () => {
    const haClient = stubHaClient();
    const announcer = createAlexaAnnouncer({ haClient });
    await announcer.announce('test', { target: 'salon' });
    assert.equal(haClient.calls[0].service, 'alexa_media_echo_salon');
  });

  it('is case-insensitive and accent-insensitive ("Salón" → echo_salon)', async () => {
    const haClient = stubHaClient();
    const announcer = createAlexaAnnouncer({ haClient });
    await announcer.announce('test', { target: 'Salón' });
    assert.equal(haClient.calls[0].service, 'alexa_media_echo_salon');
  });

  it('resolves all built-in aliases', async () => {
    const cases = [
      ['salon', 'alexa_media_echo_salon'],
      ['dormitorio', 'alexa_media_echo_dormitorio'],
      ['cocina', 'alexa_media_alexa_cocina'],
      ['pop', 'alexa_media_echo_pop_de_manuel'],
      ['pueblo', 'alexa_media_echo_pueblo'],
      ['show', 'alexa_media_echo_show_de_manu'],
      ['manu', 'alexa_media_echo_show_de_manu'],
      ['firetv', 'alexa_media_fire_tv_de_manuel'],
      ['casa', 'alexa_media_en_toda_la_casa'],
      ['todo', 'alexa_media_en_toda_la_casa'],
    ];
    for (const [alias, expected] of cases) {
      const haClient = stubHaClient();
      const announcer = createAlexaAnnouncer({ haClient });
      await announcer.announce('m', { target: alias });
      assert.equal(haClient.calls[0].service, expected, `alias=${alias}`);
    }
  });

  it('passes through unknown raw suffix (e.g. echo_garaje)', async () => {
    const haClient = stubHaClient();
    const announcer = createAlexaAnnouncer({ haClient });
    await announcer.announce('m', { target: 'echo_garaje' });
    assert.equal(haClient.calls[0].service, 'alexa_media_echo_garaje');
  });

  it('accepts the full service name (alexa_media_*) and avoids double prefix', async () => {
    const haClient = stubHaClient();
    const announcer = createAlexaAnnouncer({ haClient });
    await announcer.announce('m', { target: 'alexa_media_echo_garaje' });
    assert.equal(haClient.calls[0].service, 'alexa_media_echo_garaje');
  });

  it('throws on empty message', async () => {
    const announcer = createAlexaAnnouncer({ haClient: stubHaClient() });
    await assert.rejects(() => announcer.announce(''), /empty/i);
    await assert.rejects(() => announcer.announce('   '), /empty/i);
    await assert.rejects(() => announcer.announce(null), /empty/i);
  });

  it('returns service and target used', async () => {
    const announcer = createAlexaAnnouncer({ haClient: stubHaClient() });
    const result = await announcer.announce('hola', { target: 'salon' });
    assert.equal(result.service, 'alexa_media_echo_salon');
    assert.equal(result.target, 'salon');
  });

  it('returns target = "casa" when broadcasting by default', async () => {
    const announcer = createAlexaAnnouncer({ haClient: stubHaClient() });
    const result = await announcer.announce('hola');
    assert.equal(result.target, 'casa');
  });

  it('propagates errors from haClient.callService', async () => {
    const haClient = {
      async callService() {
        throw new Error('HA: HTTP 500');
      },
    };
    const announcer = createAlexaAnnouncer({ haClient });
    await assert.rejects(() => announcer.announce('hola', { target: 'salon' }), /HTTP 500/);
  });

  it('listTargetAliases() returns sorted alias list', async () => {
    const announcer = createAlexaAnnouncer({ haClient: stubHaClient() });
    const aliases = announcer.listTargetAliases();
    assert.ok(aliases.includes('salon'));
    assert.ok(aliases.includes('casa'));
    assert.deepEqual([...aliases].sort(), aliases);
  });
});
