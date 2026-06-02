import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGmailLabels } from '../../../src/modules/email/gmail-labels.js';

/**
 * Builds a stub Gmail API. Records calls and lets each test customise the
 * responses returned by `users.labels.list`, `users.labels.create`,
 * `users.messages.list` and `users.messages.modify`.
 */
function buildGmailStub({
  labels = [],
  createdLabel = null,
  messageIds = [],
  modifyThrowsForIds = new Set(),
} = {}) {
  const calls = {
    labelsList: 0,
    labelsCreate: [],
    messagesList: [],
    messagesModify: [],
  };

  const api = {
    users: {
      labels: {
        async list() {
          calls.labelsList += 1;
          return { data: { labels } };
        },
        async create(params) {
          calls.labelsCreate.push(params);
          const created = createdLabel ?? {
            id: `Label_${labels.length + 1}`,
            name: params.requestBody.name,
            type: 'user',
          };
          // Persist for subsequent listLabels calls in the same test
          labels.push(created);
          return { data: created };
        },
      },
      messages: {
        async list(params) {
          calls.messagesList.push(params);
          return { data: { messages: messageIds.map((id) => ({ id })) } };
        },
        async modify(params) {
          calls.messagesModify.push(params);
          if (modifyThrowsForIds.has(params.id)) {
            throw new Error(`forced failure for ${params.id}`);
          }
          return { data: { id: params.id } };
        },
      },
    },
  };

  return { api, calls };
}

function buildClient(stub) {
  const googleAuth = {
    getClient: async () => ({}),
  };
  return createGmailLabels({
    googleAuth,
    gmailFactory: () => stub.api,
  });
}

describe('createGmailLabels — exposed surface (LUI-TSK-0030: no delete)', () => {
  it('NO expone trash / untrash / delete / send / batchDelete', () => {
    const stub = buildGmailStub();
    const client = buildClient(stub);

    // El cliente DEBE existir, pero NUNCA debe tener métodos que muevan
    // mensajes a Trash, los borren o envíen correo. La ausencia es la
    // garantía — no un check en runtime que se pueda saltar.
    assert.equal(typeof client.trash, 'undefined', 'no trash');
    assert.equal(typeof client.untrash, 'undefined', 'no untrash');
    assert.equal(typeof client.delete, 'undefined', 'no delete');
    assert.equal(typeof client.send, 'undefined', 'no send');
    assert.equal(typeof client.batchDelete, 'undefined', 'no batchDelete');
    assert.equal(typeof client.deleteLabel, 'undefined', 'no deleteLabel');
  });

  it('expone listLabels, findLabelByName, createLabel, ensureLabel, addLabels, removeLabels, applyToQuery, suggestLabel', () => {
    const stub = buildGmailStub();
    const client = buildClient(stub);
    for (const fn of [
      'listLabels',
      'findLabelByName',
      'createLabel',
      'ensureLabel',
      'addLabels',
      'removeLabels',
      'applyToQuery',
      'suggestLabel',
    ]) {
      assert.equal(typeof client[fn], 'function', `expone ${fn}`);
    }
  });
});

describe('listLabels', () => {
  it('devuelve labels normalizadas con id/name/type', async () => {
    const stub = buildGmailStub({
      labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'Label_42', name: 'Estudio' },
      ],
    });
    const client = buildClient(stub);
    const result = await client.listLabels();
    assert.deepEqual(result, [
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'Label_42', name: 'Estudio', type: 'user' },
    ]);
  });
});

describe('findLabelByName', () => {
  it('match case-insensitive', async () => {
    const stub = buildGmailStub({
      labels: [{ id: 'Label_1', name: 'Estudio' }],
    });
    const client = buildClient(stub);
    const found = await client.findLabelByName('ESTUDIO');
    assert.equal(found?.id, 'Label_1');
  });

  it('devuelve null si no existe', async () => {
    const stub = buildGmailStub({ labels: [] });
    const client = buildClient(stub);
    assert.equal(await client.findLabelByName('nope'), null);
  });

  it('devuelve null con nombre vacío sin llamar al API', async () => {
    const stub = buildGmailStub();
    const client = buildClient(stub);
    assert.equal(await client.findLabelByName(''), null);
    assert.equal(stub.calls.labelsList, 0);
  });
});

describe('createLabel', () => {
  it('rechaza nombre vacío', async () => {
    const stub = buildGmailStub();
    const client = buildClient(stub);
    await assert.rejects(client.createLabel({ name: '' }), /Indica un nombre/);
  });

  it('llama a labels.create con visibility por defecto', async () => {
    const stub = buildGmailStub();
    const client = buildClient(stub);
    const created = await client.createLabel({ name: 'Estudio' });
    assert.equal(stub.calls.labelsCreate.length, 1);
    assert.equal(stub.calls.labelsCreate[0].requestBody.name, 'Estudio');
    assert.equal(stub.calls.labelsCreate[0].requestBody.labelListVisibility, 'labelShow');
    assert.equal(stub.calls.labelsCreate[0].requestBody.messageListVisibility, 'show');
    assert.ok(created.id);
    assert.equal(created.name, 'Estudio');
  });
});

describe('ensureLabel', () => {
  it('devuelve la existente sin crear', async () => {
    const stub = buildGmailStub({
      labels: [{ id: 'Label_9', name: 'Estudio' }],
    });
    const client = buildClient(stub);
    const result = await client.ensureLabel('estudio');
    assert.equal(result.id, 'Label_9');
    assert.equal(stub.calls.labelsCreate.length, 0);
  });

  it('crea si no existe', async () => {
    const stub = buildGmailStub({ labels: [] });
    const client = buildClient(stub);
    const result = await client.ensureLabel('Nueva');
    assert.equal(result.name, 'Nueva');
    assert.equal(stub.calls.labelsCreate.length, 1);
  });
});

describe('addLabels / removeLabels', () => {
  it('addLabels llama users.messages.modify con addLabelIds', async () => {
    const stub = buildGmailStub();
    const client = buildClient(stub);
    await client.addLabels({ messageId: 'm1', labelIds: ['Label_1', 'Label_2'] });
    assert.equal(stub.calls.messagesModify.length, 1);
    assert.deepEqual(stub.calls.messagesModify[0].requestBody, {
      addLabelIds: ['Label_1', 'Label_2'],
    });
  });

  it('removeLabels llama users.messages.modify con removeLabelIds', async () => {
    const stub = buildGmailStub();
    const client = buildClient(stub);
    await client.removeLabels({ messageId: 'm1', labelIds: ['INBOX'] });
    assert.deepEqual(stub.calls.messagesModify[0].requestBody, {
      removeLabelIds: ['INBOX'],
    });
  });

  it('addLabels rechaza messageId vacío', async () => {
    const stub = buildGmailStub();
    const client = buildClient(stub);
    await assert.rejects(client.addLabels({ messageId: '', labelIds: ['x'] }), /id del mensaje/);
  });

  it('addLabels rechaza labelIds vacío', async () => {
    const stub = buildGmailStub();
    const client = buildClient(stub);
    await assert.rejects(client.addLabels({ messageId: 'm1', labelIds: [] }), /labelId/);
  });
});

describe('applyToQuery', () => {
  it('etiqueta todos los mensajes que matchean la query con la label dada (creando si no existe)', async () => {
    const stub = buildGmailStub({
      labels: [],
      messageIds: ['m1', 'm2', 'm3'],
    });
    const client = buildClient(stub);
    const result = await client.applyToQuery({
      query: 'from:test@example.com',
      labelName: 'Nuevo',
    });
    assert.equal(result.created, true);
    assert.equal(result.matched, 3);
    assert.equal(result.labeled, 3);
    assert.equal(result.errors, 0);
    assert.equal(stub.calls.messagesModify.length, 3);
    // Cada modify aplica la nueva label
    for (const call of stub.calls.messagesModify) {
      assert.deepEqual(call.requestBody, { addLabelIds: [result.labelId] });
    }
  });

  it('no recrea la label si ya existe (created=false)', async () => {
    const stub = buildGmailStub({
      labels: [{ id: 'Label_X', name: 'Estudio' }],
      messageIds: ['m1'],
    });
    const client = buildClient(stub);
    const result = await client.applyToQuery({ query: 'foo', labelName: 'Estudio' });
    assert.equal(result.created, false);
    assert.equal(result.labelId, 'Label_X');
    assert.equal(stub.calls.labelsCreate.length, 0);
  });

  it('contabiliza errores parciales sin abortar el batch', async () => {
    const stub = buildGmailStub({
      labels: [{ id: 'Label_Y', name: 'X' }],
      messageIds: ['ok1', 'fail', 'ok2'],
      modifyThrowsForIds: new Set(['fail']),
    });
    const client = buildClient(stub);
    const result = await client.applyToQuery({ query: 'q', labelName: 'X' });
    assert.equal(result.matched, 3);
    assert.equal(result.labeled, 2);
    assert.equal(result.errors, 1);
  });

  it('limita maxResults al hard cap', async () => {
    const stub = buildGmailStub({ messageIds: [] });
    const client = buildClient(stub);
    await client.applyToQuery({ query: 'q', labelName: 'L', maxResults: 5000 });
    assert.equal(stub.calls.messagesList[0].maxResults, 100);
  });

  it('rechaza query vacía y labelName vacío', async () => {
    const stub = buildGmailStub();
    const client = buildClient(stub);
    await assert.rejects(client.applyToQuery({ query: '', labelName: 'X' }), /query Gmail/);
    await assert.rejects(client.applyToQuery({ query: 'q', labelName: '' }), /label/);
  });
});

describe('suggestLabel', () => {
  it('devuelve null sin llmService', async () => {
    const stub = buildGmailStub();
    const client = buildClient(stub);
    assert.equal(await client.suggestLabel({}), null);
  });

  it('limpia comillas y espacios del resultado del LLM', async () => {
    const stub = buildGmailStub();
    const fakeLlm = {
      generateText: async () => '  "Estudio"  \n(extra)',
    };
    const client = createGmailLabels({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => stub.api,
      llmService: fakeLlm,
    });
    const result = await client.suggestLabel({
      from: 'a@b.com',
      subject: 'curso udemy',
      snippet: 'tu curso ya está disponible',
    });
    assert.equal(result, 'Estudio');
  });

  it('devuelve null si el LLM contesta texto demasiado largo', async () => {
    const stub = buildGmailStub();
    const longText = 'x'.repeat(200);
    const fakeLlm = { generateText: async () => longText };
    const client = createGmailLabels({
      googleAuth: { getClient: async () => ({}) },
      gmailFactory: () => stub.api,
      llmService: fakeLlm,
    });
    assert.equal(await client.suggestLabel({ from: '', subject: '', snippet: '' }), null);
  });
});
