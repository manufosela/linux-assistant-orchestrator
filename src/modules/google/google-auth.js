import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  // gmail.modify: permite gestionar labels en mensajes (LUI-TSK-0030). El scope
  // técnicamente incluye trash/untrash, pero el módulo gmail-labels.js NUNCA
  // expone esos métodos — sólo listLabels / createLabel / addLabels /
  // removeLabels. Para borrar definitivamente haría falta gmail.modify Y un
  // método delete del API, que tampoco existe en el cliente.
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  // drive.file: app puede crear/leer/modificar/borrar SOLO los ficheros que
  // ella misma haya creado o que el usuario haya abierto explícitamente con la
  // app. NO toca el resto del Drive del usuario.
  'https://www.googleapis.com/auth/drive.file',
];

/**
 * Helper that owns the OAuth2 lifecycle for Google APIs (Gmail + Calendar) used by LUIS.
 *
 *  - Lee las credenciales OAuth2 (client_id, client_secret) de `credentialsPath`. Soporta tanto
 *    `installed` como `web` types del JSON descargado de Google Cloud Console.
 *  - Almacena los tokens (incluido refresh_token) en `tokensPath` con permisos 600.
 *  - El primer arranque NO requiere navegador integrado: `generateAuthUrl()` devuelve la URL
 *    que el usuario abre a mano, autoriza, y `exchangeCode(code)` intercambia el código
 *    pegado por tokens persistentes.
 *  - En cada `getClient()` posterior se cargan los tokens y la librería refresca el
 *    access_token automáticamente. El listener `tokens` persiste cualquier rotación.
 *
 * Solo expone scopes read-only — el módulo nunca podrá enviar correos ni modificar el calendario.
 *
 * @param {{
 *   credentialsPath: string,
 *   tokensPath: string,
 *   logger?: import('pino').Logger,
 * }} deps
 * @returns {GoogleAuth}
 */
export function createGoogleAuth({ credentialsPath, tokensPath, logger }) {
  /** @type {import('google-auth-library').OAuth2Client | null} */
  let cachedClient = null;

  /**
   * @returns {Promise<{ clientId: string, clientSecret: string, redirectUri: string }>}
   */
  async function loadCredentials() {
    let raw;
    try {
      raw = await readFile(credentialsPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new GoogleAuthMissingCredentialsError(
          `No encuentro las credenciales OAuth2 en ${credentialsPath}. Descárgalas de Google Cloud Console (OAuth Client ID → Desktop app).`,
        );
      }
      throw error;
    }
    const data = JSON.parse(raw);
    const cfg = data.installed ?? data.web ?? data;
    if (!cfg?.client_id || !cfg?.client_secret) {
      throw new Error(`Credenciales Google inválidas en ${credentialsPath}: faltan client_id o client_secret.`);
    }
    // OOB (out-of-band) — usuario copia/pega el código manualmente. Google ha deprecado OOB para
    // apps OAuth nuevas, pero para "Desktop app" sigue funcionando si no hay redirect URI propio.
    const redirectUri = cfg.redirect_uris?.[0] ?? 'urn:ietf:wg:oauth:2.0:oob';
    return { clientId: cfg.client_id, clientSecret: cfg.client_secret, redirectUri };
  }

  /**
   * @returns {Promise<object | null>}
   */
  async function loadTokens() {
    try {
      const raw = await readFile(tokensPath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * @param {object} tokens
   */
  async function saveTokens(tokens) {
    await mkdir(dirname(tokensPath), { recursive: true });
    await writeFile(tokensPath, JSON.stringify(tokens, null, 2), 'utf8');
    await chmod(tokensPath, 0o600).catch(() => {
      // chmod puede fallar en sistemas de ficheros sin permisos POSIX; no es crítico
    });
  }

  /**
   * Returns an authenticated OAuth2Client ready to be passed to `google.gmail({auth})` or
   * `google.calendar({auth})`. Throws `GoogleAuthNotConfiguredError` if there is no refresh
   * token yet — the caller is expected to guide the user through `generateAuthUrl` +
   * `exchangeCode` in that case.
   *
   * @returns {Promise<import('google-auth-library').OAuth2Client>}
   */
  async function getClient() {
    if (cachedClient) return cachedClient;

    const creds = await loadCredentials();
    const tokens = await loadTokens();
    if (!tokens?.refresh_token) {
      throw new GoogleAuthNotConfiguredError(
        'Google OAuth2 sin configurar. Ejecuta `luis google login` para autorizar el acceso.',
      );
    }

    const client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, creds.redirectUri);
    client.setCredentials(tokens);

    // Persistir tokens cada vez que la librería rote el access_token. El refresh_token solo se
    // emite en la primera autorización, así que hay que preservarlo manualmente al mergear.
    client.on('tokens', async (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      if (!newTokens.refresh_token && tokens.refresh_token) {
        merged.refresh_token = tokens.refresh_token;
      }
      try {
        await saveTokens(merged);
        logger?.info('Google OAuth2 tokens refreshed and persisted');
      } catch (error) {
        logger?.warn({ err: error?.message }, 'Failed to persist refreshed Google tokens');
      }
    });

    cachedClient = client;
    return client;
  }

  /**
   * Generates the authorisation URL the user must open in a browser. Always requests
   * `access_type=offline` + `prompt=consent` so Google returns a refresh_token even on
   * re-authorisations.
   *
   * @returns {Promise<string>}
   */
  async function generateAuthUrl() {
    const creds = await loadCredentials();
    const client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, creds.redirectUri);
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
    });
  }

  /**
   * Exchanges the authorisation code (pasted by the user after authorising in the browser)
   * for tokens and persists them. Returns the tokens object.
   *
   * @param {string} code
   * @returns {Promise<object>}
   */
  async function exchangeCode(code) {
    const trimmed = String(code ?? '').trim();
    if (!trimmed) throw new Error('Código de autorización vacío.');

    const creds = await loadCredentials();
    const client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, creds.redirectUri);
    const { tokens } = await client.getToken(trimmed);
    if (!tokens?.refresh_token) {
      throw new Error(
        'Google no devolvió refresh_token. Revoca el acceso de la app en https://myaccount.google.com/permissions y vuelve a autorizar.',
      );
    }
    await saveTokens(tokens);
    cachedClient = null; // forzar recarga en próximas llamadas a getClient()
    logger?.info({ scopes: tokens.scope }, 'Google OAuth2 tokens stored on first authorization');
    return tokens;
  }

  /**
   * Returns true if there is a refresh token persisted (i.e. login already done).
   *
   * @returns {Promise<boolean>}
   */
  async function isConfigured() {
    const tokens = await loadTokens();
    return Boolean(tokens?.refresh_token);
  }

  return { getClient, generateAuthUrl, exchangeCode, isConfigured };
}

/**
 * Thrown when there are no tokens persisted yet.
 */
export class GoogleAuthNotConfiguredError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GoogleAuthNotConfiguredError';
  }
}

/**
 * Thrown when the credentials.json file is missing.
 */
export class GoogleAuthMissingCredentialsError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GoogleAuthMissingCredentialsError';
  }
}

/**
 * @typedef {Object} GoogleAuth
 * @property {() => Promise<import('google-auth-library').OAuth2Client>} getClient
 * @property {() => Promise<string>} generateAuthUrl
 * @property {(code: string) => Promise<object>} exchangeCode
 * @property {() => Promise<boolean>} isConfigured
 */
