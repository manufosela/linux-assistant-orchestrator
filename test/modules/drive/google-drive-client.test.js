import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGoogleDriveClient } from '../../../src/modules/drive/google-drive-client.js';

/**
 * Builds a fake googleAuth + driveFactory pair that returns canned files.
 *
 * @param {object} options
 * @param {Array<object>} [options.files] - returned by drive.files.list
 * @param {object} [options.singleFile] - returned by drive.files.get
 * @param {(args: object) => any} [options.onList] - assertion hook
 */
function fakeClient({ files = [], singleFile = null, onList = () => {} } = {}) {
  const googleAuth = { getClient: async () => ({}) };
  const driveFactory = () => ({
    files: {
      async list(args) {
        onList(args);
        return { data: { files } };
      },
      async get() {
        return { data: singleFile };
      },
    },
  });
  return { googleAuth, driveFactory };
}

const folder = (id, name, parents = ['root']) => ({
  id,
  name,
  mimeType: 'application/vnd.google-apps.folder',
  modifiedTime: '2026-05-20T10:00:00Z',
  parents,
});
const file = (id, name, mimeType = 'application/pdf', parents = ['root']) => ({
  id,
  name,
  mimeType,
  modifiedTime: '2026-05-20T10:00:00Z',
  size: '1024',
  parents,
  webViewLink: `https://docs.google.com/file/d/${id}`,
});

describe('createGoogleDriveClient.listFolder', () => {
  it('lista hijos directos de una carpeta y normaliza', async () => {
    const { googleAuth, driveFactory } = fakeClient({
      files: [folder('f1', 'Subcarpeta'), file('d1', 'doc.pdf')],
    });
    const client = createGoogleDriveClient({ googleAuth, driveFactory });

    const items = await client.listFolder();

    assert.equal(items.length, 2);
    assert.equal(items[0].isFolder, true);
    assert.equal(items[0].name, 'Subcarpeta');
    assert.equal(items[1].isFolder, false);
    assert.equal(items[1].size, 1024);
    assert.match(items[1].webViewLink, /^https:\/\/docs\.google\.com/);
  });

  it('usa folderId="root" por defecto', async () => {
    let listedQ = '';
    const { googleAuth, driveFactory } = fakeClient({
      onList: (args) => { listedQ = args.q; },
    });
    const client = createGoogleDriveClient({ googleAuth, driveFactory });

    await client.listFolder();

    assert.match(listedQ, /'root' in parents/);
    assert.match(listedQ, /trashed = false/);
  });

  it('usa el folderId que le pasen', async () => {
    let listedQ = '';
    const { googleAuth, driveFactory } = fakeClient({
      onList: (args) => { listedQ = args.q; },
    });
    const client = createGoogleDriveClient({ googleAuth, driveFactory });

    await client.listFolder('ABC123');

    assert.match(listedQ, /'ABC123' in parents/);
  });
});

describe('createGoogleDriveClient.searchByName', () => {
  it('construye la query con name contains', async () => {
    let listedQ = '';
    const { googleAuth, driveFactory } = fakeClient({
      files: [file('d1', 'factura-marzo.pdf')],
      onList: (args) => { listedQ = args.q; },
    });
    const client = createGoogleDriveClient({ googleAuth, driveFactory });

    const items = await client.searchByName('factura');

    assert.match(listedQ, /name contains 'factura'/);
    assert.match(listedQ, /trashed = false/);
    assert.equal(items.length, 1);
    assert.equal(items[0].name, 'factura-marzo.pdf');
  });

  it('escapa comillas simples en la query', async () => {
    let listedQ = '';
    const { googleAuth, driveFactory } = fakeClient({ onList: (args) => { listedQ = args.q; } });
    const client = createGoogleDriveClient({ googleAuth, driveFactory });

    await client.searchByName("Manu's docs");

    assert.match(listedQ, /Manu\\'s docs/);
  });

  it('lanza si query vacío', async () => {
    const { googleAuth, driveFactory } = fakeClient();
    const client = createGoogleDriveClient({ googleAuth, driveFactory });

    await assert.rejects(() => client.searchByName(''), /non-empty/);
    await assert.rejects(() => client.searchByName('   '), /non-empty/);
  });
});

describe('createGoogleDriveClient.getMetadata', () => {
  it('devuelve metadata normalizada', async () => {
    const { googleAuth, driveFactory } = fakeClient({
      singleFile: { id: 'X1', name: 'informe.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', modifiedTime: '2026-05-22T12:00:00Z', parents: ['F1'] },
    });
    const client = createGoogleDriveClient({ googleAuth, driveFactory });

    const item = await client.getMetadata('X1');

    assert.equal(item.id, 'X1');
    assert.equal(item.name, 'informe.docx');
    assert.equal(item.isFolder, false);
    assert.deepEqual(item.parents, ['F1']);
  });

  it('lanza si fileId vacío', async () => {
    const { googleAuth, driveFactory } = fakeClient();
    const client = createGoogleDriveClient({ googleAuth, driveFactory });

    await assert.rejects(() => client.getMetadata(''), /fileId/);
  });
});
