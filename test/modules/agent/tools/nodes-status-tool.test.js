import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNodesStatusTool } from '../../../../src/modules/agent/tools/nodes-status-tool.js';

describe('get_nodes_status tool', () => {
  it('probes the cluster now and says what is down', async () => {
    const clusterStatus = {
      probe: async () => [
        { node: 'n2', service: 'ollama', address: 'n2:11434', ok: true, detail: null },
        { node: 'n3', service: 'ollama', address: 'n3:11434', ok: false, detail: 'timeout' },
      ],
    };

    const result = await createNodesStatusTool({ clusterStatus }).execute({});

    assert.deepEqual(result, {
      caidos: 1,
      servicios: [
        { nodo: 'n2', servicio: 'ollama', estado: 'OK' },
        { nodo: 'n3', servicio: 'ollama', estado: 'CAÍDO', detalle: 'timeout' },
      ],
    });
  });

  it('removes addresses from the error detail', async () => {
    const clusterStatus = {
      probe: async () => [{
        node: 'n3', service: 'ollama', ok: false, detail: 'connect ECONNREFUSED 10.0.0.3:11434 (http://n3.lan:11434/api)',
      }],
    };

    const result = await createNodesStatusTool({ clusterStatus }).execute({});

    assert.equal(result.servicios[0].detalle, 'connect ECONNREFUSED [dirección] ([dirección])');
  });
});
