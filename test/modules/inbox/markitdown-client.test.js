import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMarkitdownClient } from '../../../src/modules/inbox/markitdown-client.js';

let tmpDir;
let samplePath;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'luis-md-client-'));
  samplePath = join(tmpDir, 'sample.pdf');
  await writeFile(samplePath, 'PDF FAKE BYTES');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(body, status = 500) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
    text: async () => body,
  };
}

describe('markitdown-client constructor', () => {
  it('lanza si falta baseUrl', () => {
    assert.throws(() => createMarkitdownClient({}), /baseUrl/);
  });

  it('normaliza barras finales en baseUrl', async () => {
    let capturedUrl;
    const fetchImpl = async (url) => { capturedUrl = url; return jsonResponse({ status: 'ok' }); };
    const client = createMarkitdownClient({ baseUrl: 'http://x:5001///', fetchImpl });
    await client.checkHealth();
    assert.equal(capturedUrl, 'http://x:5001/health');
  });
});

describe('markitdown-client.convertFile', () => {
  it('devuelve text+title del JSON de respuesta', async () => {
    const fetchImpl = async () => jsonResponse({
      text: '# Hola mundo\n\nContenido extraído',
      title: 'Hola',
      filename: 'sample.pdf',
    });
    const client = createMarkitdownClient({ baseUrl: 'http://markitdown:5001', fetchImpl });

    const result = await client.convertFile(samplePath);

    assert.match(result.text, /Hola mundo/);
    assert.equal(result.title, 'Hola');
    assert.equal(result.filename, 'sample.pdf');
  });

  it('si el servidor no responde 2xx → lanza con el cuerpo del error', async () => {
    const fetchImpl = async () => textResponse('Internal markitdown crash', 500);
    const client = createMarkitdownClient({ baseUrl: 'http://markitdown:5001', fetchImpl });

    await assert.rejects(
      () => client.convertFile(samplePath),
      /HTTP 500.*Internal markitdown crash/,
    );
  });

  it('si el campo text falta → string vacío sin romper', async () => {
    const fetchImpl = async () => jsonResponse({ title: 'sin texto' });
    const client = createMarkitdownClient({ baseUrl: 'http://markitdown:5001', fetchImpl });

    const result = await client.convertFile(samplePath);

    assert.equal(result.text, '');
    assert.equal(result.title, 'sin texto');
  });

  it('si fetch rechaza (red caída) → propaga el error', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const client = createMarkitdownClient({ baseUrl: 'http://markitdown:5001', fetchImpl });

    await assert.rejects(() => client.convertFile(samplePath), /ECONNREFUSED/);
  });

  it('envía el fichero como multipart con la key "file"', async () => {
    let capturedBody;
    const fetchImpl = async (_url, init) => {
      capturedBody = init.body;
      return jsonResponse({ text: 't', title: null, filename: 'sample.pdf' });
    };
    const client = createMarkitdownClient({ baseUrl: 'http://markitdown:5001', fetchImpl });

    await client.convertFile(samplePath);

    assert.ok(capturedBody instanceof FormData);
    assert.ok(capturedBody.get('file'), 'debe enviar campo "file"');
  });
});

describe('markitdown-client.checkHealth', () => {
  it('true si responde 2xx', async () => {
    const fetchImpl = async () => jsonResponse({ status: 'ok' });
    const client = createMarkitdownClient({ baseUrl: 'http://markitdown:5001', fetchImpl });

    assert.equal(await client.checkHealth(), true);
  });

  it('false si responde 5xx', async () => {
    const fetchImpl = async () => textResponse('boom', 500);
    const client = createMarkitdownClient({ baseUrl: 'http://markitdown:5001', fetchImpl });

    assert.equal(await client.checkHealth(), false);
  });

  it('false si fetch rechaza', async () => {
    const fetchImpl = async () => { throw new Error('refused'); };
    const client = createMarkitdownClient({ baseUrl: 'http://markitdown:5001', fetchImpl });

    assert.equal(await client.checkHealth(), false);
  });
});
