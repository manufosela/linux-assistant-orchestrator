import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAlexaAnnouncer, parseAnnounceInvocation, listTargetChoices } from '../../../src/modules/home-assistant/ha-alexa-announcer.js';

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
      ['despacho', 'alexa_media_echo_despacho'],
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

describe('parseAnnounceInvocation', () => {
  it('returns broadcast when message has no alias prefix', () => {
    const r = parseAnnounceInvocation('hola a todos');
    assert.equal(r.target, undefined);
    assert.equal(r.message, 'hola a todos');
  });

  it('detects alias as first word', () => {
    const r = parseAnnounceInvocation('dormitorio el agua está lista');
    assert.equal(r.target, 'dormitorio');
    assert.equal(r.message, 'el agua está lista');
  });

  it('detects alias with accent as first word', () => {
    const r = parseAnnounceInvocation('Salón vamos a cenar');
    assert.equal(r.target, 'Salón');
    assert.equal(r.message, 'vamos a cenar');
  });

  it('flag-style --en X mensaje takes precedence', () => {
    const r = parseAnnounceInvocation('--en show Mánu llamada');
    assert.equal(r.target, 'show');
    assert.equal(r.message, 'Mánu llamada');
  });

  it('supports --to and --target aliases', () => {
    assert.equal(parseAnnounceInvocation('--to dormitorio agua').target, 'dormitorio');
    assert.equal(parseAnnounceInvocation('--target cocina cena').target, 'cocina');
  });

  it('does NOT steal first word when it is not a known alias', () => {
    const r = parseAnnounceInvocation('hola a todos');
    assert.equal(r.target, undefined);
    assert.equal(r.message, 'hola a todos');
  });

  it('empty input returns empty parts', () => {
    const r = parseAnnounceInvocation('');
    assert.equal(r.target, undefined);
    assert.equal(r.message, '');
  });

  it('null / undefined safe', () => {
    assert.deepEqual(parseAnnounceInvocation(null), { target: undefined, message: '' });
    assert.deepEqual(parseAnnounceInvocation(undefined), { target: undefined, message: '' });
  });

  it('preserves newlines in message', () => {
    const r = parseAnnounceInvocation('salon linea1\nlinea2');
    assert.equal(r.target, 'salon');
    assert.equal(r.message, 'linea1\nlinea2');
  });

  it('accepts em-dash prefix (—en) because mobile keyboards autocorrect -- to —', () => {
    const r = parseAnnounceInvocation('—en dormitorio mensaje');
    assert.equal(r.target, 'dormitorio');
    assert.equal(r.message, 'mensaje');
  });

  it('accepts en-dash prefix (–en)', () => {
    const r = parseAnnounceInvocation('–en salon hola');
    assert.equal(r.target, 'salon');
    assert.equal(r.message, 'hola');
  });

  it('accepts single dash prefix (-en) for tolerance', () => {
    const r = parseAnnounceInvocation('-en show texto');
    assert.equal(r.target, 'show');
    assert.equal(r.message, 'texto');
  });
});

describe('listTargetChoices', () => {
  it('returns the 7 destinations including broadcast (casa)', () => {
    const choices = listTargetChoices();
    assert.equal(choices.length, 7);
    const aliases = choices.map((c) => c.alias);
    assert.ok(aliases.includes('salon'));
    assert.ok(aliases.includes('despacho'));
    assert.ok(aliases.includes('casa'));
    assert.ok(!aliases.includes('pueblo'));
  });

  it('every choice has alias, label and emoji', () => {
    for (const c of listTargetChoices()) {
      assert.ok(c.alias, 'alias');
      assert.ok(c.label, 'label');
      assert.ok(c.emoji, 'emoji');
    }
  });
});
