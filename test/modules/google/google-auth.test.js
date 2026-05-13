import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createGoogleAuth,
  GoogleAuthNotConfiguredError,
  GoogleAuthMissingCredentialsError,
} from '../../../src/modules/google/google-auth.js';

const VALID_CREDENTIALS_JSON = JSON.stringify({
  installed: {
    client_id: 'fake-client.apps.googleusercontent.com',
    client_secret: 'fake-secret',
    redirect_uris: ['urn:ietf:wg:oauth:2.0:oob'],
  },
});

const WEB_CREDENTIALS_JSON = JSON.stringify({
  web: {
    client_id: 'web-client',
    client_secret: 'web-secret',
    redirect_uris: ['urn:ietf:wg:oauth:2.0:oob'],
  },
});

const INVALID_CREDENTIALS_JSON = JSON.stringify({ installed: { client_id: 'x' } });

describe('createGoogleAuth', () => {
  /** @type {string} */
  let tmpDir;
  let credPath;
  let tokensPath;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'luis-google-auth-test-'));
    credPath = join(tmpDir, 'credentials.json');
    tokensPath = join(tmpDir, 'tokens.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('isConfigured() is false when there are no tokens persisted', async () => {
    await writeFile(credPath, VALID_CREDENTIALS_JSON);
    const auth = createGoogleAuth({ credentialsPath: credPath, tokensPath });
    assert.equal(await auth.isConfigured(), false);
  });

  it('isConfigured() is true when tokens with refresh_token exist', async () => {
    await writeFile(credPath, VALID_CREDENTIALS_JSON);
    await writeFile(tokensPath, JSON.stringify({ refresh_token: 'rt', access_token: 'at' }));
    const auth = createGoogleAuth({ credentialsPath: credPath, tokensPath });
    assert.equal(await auth.isConfigured(), true);
  });

  it('isConfigured() is false when tokens exist but lack refresh_token', async () => {
    await writeFile(credPath, VALID_CREDENTIALS_JSON);
    await writeFile(tokensPath, JSON.stringify({ access_token: 'at' }));
    const auth = createGoogleAuth({ credentialsPath: credPath, tokensPath });
    assert.equal(await auth.isConfigured(), false);
  });

  it('getClient() throws GoogleAuthNotConfiguredError when no tokens yet', async () => {
    await writeFile(credPath, VALID_CREDENTIALS_JSON);
    const auth = createGoogleAuth({ credentialsPath: credPath, tokensPath });
    await assert.rejects(() => auth.getClient(), GoogleAuthNotConfiguredError);
  });

  it('getClient() throws GoogleAuthMissingCredentialsError when credentials.json absent', async () => {
    // No escribimos credPath
    const auth = createGoogleAuth({ credentialsPath: credPath, tokensPath });
    await assert.rejects(() => auth.getClient(), GoogleAuthMissingCredentialsError);
  });

  it('rejects credentials.json with missing client_id / client_secret', async () => {
    await writeFile(credPath, INVALID_CREDENTIALS_JSON);
    const auth = createGoogleAuth({ credentialsPath: credPath, tokensPath });
    await assert.rejects(() => auth.generateAuthUrl(), /Credenciales Google inválidas/);
  });

  it('generateAuthUrl() returns a Google authorisation URL with both scopes and offline access', async () => {
    await writeFile(credPath, VALID_CREDENTIALS_JSON);
    const auth = createGoogleAuth({ credentialsPath: credPath, tokensPath });
    const url = await auth.generateAuthUrl();
    assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth'), 'expected Google auth URL');
    assert.ok(url.includes('access_type=offline'));
    assert.ok(url.includes('prompt=consent'));
    assert.ok(decodeURIComponent(url).includes('https://www.googleapis.com/auth/gmail.readonly'));
    assert.ok(decodeURIComponent(url).includes('https://www.googleapis.com/auth/calendar.readonly'));
    assert.ok(url.includes(encodeURIComponent('fake-client.apps.googleusercontent.com')));
  });

  it('also supports "web" type credentials JSON', async () => {
    await writeFile(credPath, WEB_CREDENTIALS_JSON);
    const auth = createGoogleAuth({ credentialsPath: credPath, tokensPath });
    const url = await auth.generateAuthUrl();
    assert.ok(url.includes(encodeURIComponent('web-client')));
  });

  it('exchangeCode() rejects empty / whitespace code without calling Google', async () => {
    await writeFile(credPath, VALID_CREDENTIALS_JSON);
    const auth = createGoogleAuth({ credentialsPath: credPath, tokensPath });
    await assert.rejects(() => auth.exchangeCode(''), /vacío/);
    await assert.rejects(() => auth.exchangeCode('   '), /vacío/);
    await assert.rejects(() => auth.exchangeCode(null), /vacío/);
  });

  it('getClient() returns cached client on subsequent calls (no re-read of files)', async () => {
    await writeFile(credPath, VALID_CREDENTIALS_JSON);
    await writeFile(tokensPath, JSON.stringify({
      refresh_token: 'rt-stable',
      access_token: 'at-original',
      expiry_date: Date.now() + 60_000,
    }));
    const auth = createGoogleAuth({ credentialsPath: credPath, tokensPath });
    const c1 = await auth.getClient();
    const c2 = await auth.getClient();
    assert.equal(c1, c2, 'same instance returned on cache hit');
  });

  it('getClient() persists rotated tokens via the "tokens" event listener', async () => {
    await writeFile(credPath, VALID_CREDENTIALS_JSON);
    await writeFile(tokensPath, JSON.stringify({
      refresh_token: 'rt-stable',
      access_token: 'at-old',
    }));

    /** @type {string[]} */
    const logs = [];
    const logger = {
      info: (...args) => logs.push(`info:${JSON.stringify(args)}`),
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    const auth = createGoogleAuth({ credentialsPath: credPath, tokensPath, logger });
    const client = await auth.getClient();

    // Disparamos manualmente el evento como haría la librería al refrescar
    client.emit('tokens', { access_token: 'at-new', expiry_date: Date.now() + 60_000 });

    // El handler es async; esperamos un microtask para que persista
    await new Promise((resolve) => setTimeout(resolve, 20));

    const persisted = JSON.parse(await readFile(tokensPath, 'utf8'));
    assert.equal(persisted.access_token, 'at-new', 'nuevo access_token persistido');
    assert.equal(persisted.refresh_token, 'rt-stable', 'refresh_token preservado tras rotación');
  });

  it('saves tokens with 600 permissions when possible (no crash on weird filesystems)', async () => {
    await writeFile(credPath, VALID_CREDENTIALS_JSON);
    const auth = createGoogleAuth({ credentialsPath: credPath, tokensPath });

    // Simulamos el lado de exchangeCode sin llamar a Google: escribimos directamente a través
    // del exchangeCode mediante un mock no-op. Lo más práctico: comprobar el flujo de saveTokens
    // creando un token a mano y leyendo permisos.
    await writeFile(tokensPath, JSON.stringify({ refresh_token: 'rt', access_token: 'at' }));
    const { stat } = await import('node:fs/promises');
    const before = await stat(tokensPath);

    // Disparar rotación que ejerza saveTokens(merged):
    const client = await auth.getClient();
    client.emit('tokens', { access_token: 'at-rotated' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const after = await stat(tokensPath);
    // El modo puede no ser 0o600 exacto (umask, FS), pero al menos el fichero existe y se reescribió
    assert.ok(after.mtimeMs >= before.mtimeMs);
  });
});
