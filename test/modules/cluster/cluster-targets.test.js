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
});
