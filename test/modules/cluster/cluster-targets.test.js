import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildClusterTargets } from '../../../src/modules/cluster/cluster-targets.js';

describe('buildClusterTargets', () => {
  it('exige las 3 IPs (no hay LAN hardcodeada)', () => {
    assert.throws(() => buildClusterTargets(), /requires n2Ip, n3Ip and n4Ip/);
    assert.throws(() => buildClusterTargets({ n2Ip: '10.0.0.1' }), /requires n2Ip/);
    assert.throws(
      () => buildClusterTargets({ n2Ip: '10.0.0.1', n3Ip: '10.0.0.2' }),
      /requires n2Ip/,
    );
  });

  it('construye los 8 targets con las IPs dadas', () => {
    const targets = buildClusterTargets({ n2Ip: '10.0.0.1', n3Ip: '10.0.0.2', n4Ip: '10.0.0.3' });
    assert.equal(targets.length, 8);

    const litellm = targets.find((t) => t.id === 'n2:litellm');
    assert.equal(litellm.host, '10.0.0.1');
    assert.equal(litellm.path, '/health/liveliness');

    const postgres = targets.find((t) => t.id === 'n4:postgres');
    assert.equal(postgres.host, '10.0.0.3');
    assert.equal(postgres.kind, 'tcp');

    // Ninguna IP del autor (192.168.1.x) debe filtrarse por defecto.
    assert.ok(targets.every((t) => !t.host.startsWith('192.168.1.')));
  });

  const ALL_IPS = { n2Ip: '10.0.0.1', n3Ip: '10.0.0.2', n4Ip: '10.0.0.3' };

  it('sin mutedNodes monitoriza los 3 nodos (comportamiento por defecto)', () => {
    const nodes = new Set(buildClusterTargets(ALL_IPS).map((t) => t.node));
    assert.deepEqual([...nodes].sort(), ['n2', 'n3', 'n4']);
  });

  it('mutedNodes=[n4] excluye todos los targets de n4 (nodo apagado aposta)', () => {
    const targets = buildClusterTargets({ ...ALL_IPS, mutedNodes: ['n4'] });
    assert.ok(targets.every((t) => t.node !== 'n4'), 'ningún target de n4');
    // n4 aportaba 3 servicios (ollama, qdrant, postgres) → quedan 5.
    assert.equal(targets.length, 5);
  });

  it('mutedNodes acepta lista (n4,n3) y deja solo n2', () => {
    const nodes = new Set(buildClusterTargets({ ...ALL_IPS, mutedNodes: ['n4', 'n3'] }).map((t) => t.node));
    assert.deepEqual([...nodes], ['n2']);
  });

  it('mutedNodes es case/space-insensitive (" N4 " silencia n4)', () => {
    const targets = buildClusterTargets({ ...ALL_IPS, mutedNodes: [' N4 '] });
    assert.ok(targets.every((t) => t.node !== 'n4'));
  });

  it('mutedNodes con un nodo inexistente no altera nada', () => {
    const targets = buildClusterTargets({ ...ALL_IPS, mutedNodes: ['n9'] });
    assert.equal(targets.length, 8);
  });
});
