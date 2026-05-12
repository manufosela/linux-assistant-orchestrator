/**
 * Lookup table mapping user-friendly aliases to the suffix of the HA notify service.
 *
 * Keys are normalised (lowercase, accents stripped) before matching, so "Salón" and "salon"
 * both resolve to `echo_salon`. Adding a new Echo only requires another entry here — the rest
 * of the code is data-driven.
 */
const TARGET_ALIASES = {
  // broadcast to every Echo in the house
  casa: 'en_toda_la_casa',
  todo: 'en_toda_la_casa',
  todos: 'en_toda_la_casa',
  todas: 'en_toda_la_casa',
  // individual echos
  salon: 'echo_salon',
  dormitorio: 'echo_dormitorio',
  cocina: 'alexa_cocina',
  pop: 'echo_pop_de_manuel',
  pueblo: 'echo_pueblo',
  show: 'echo_show_de_manu',
  manu: 'echo_show_de_manu',
  // other endpoints
  firetv: 'fire_tv_de_manuel',
};

const DEFAULT_TARGET_SUFFIX = 'en_toda_la_casa';

/**
 * Creates an Alexa announcer that pushes spoken announcements to Echo devices via Home
 * Assistant's `notify.alexa_media_*` services.
 *
 * Always sends `data.type = 'announce'` so the Echo speaks the message out loud regardless
 * of its current state (idle, playing music, etc.). Without this flag the message would only
 * appear in the Alexa app as a notification.
 *
 * @param {{
 *   haClient: import('./ha-client.js').HomeAssistantClient,
 *   logger?: import('pino').Logger,
 * }} deps
 * @returns {AlexaAnnouncer}
 */
export function createAlexaAnnouncer({ haClient, logger }) {
  /**
   * Sends an announcement.
   *
   * Target resolution:
   *  1. No `target` → broadcast to every Echo (`alexa_media_en_toda_la_casa`).
   *  2. Alias match (case-insensitive, accent-insensitive) → that suffix.
   *  3. Raw value passed through. Accepts both `echo_garaje` and `alexa_media_echo_garaje`.
   *
   * @param {string} message
   * @param {{ target?: string }} [options]
   * @returns {Promise<{ service: string, target: string }>}
   */
  async function announce(message, options = {}) {
    const trimmed = String(message ?? '').trim();
    if (!trimmed) throw new Error('Announcement message is empty.');

    const rawTarget = String(options.target ?? '').trim();
    const suffix = rawTarget
      ? resolveTargetSuffix(rawTarget)
      : DEFAULT_TARGET_SUFFIX;

    const fullService = suffix.startsWith('alexa_media_')
      ? suffix
      : `alexa_media_${suffix}`;

    logger?.info(
      { service: fullService, length: trimmed.length, target: rawTarget || '(default)' },
      'Alexa announce: sending',
    );

    await haClient.callService('notify', fullService, {
      message: trimmed,
      data: { type: 'announce' },
    });

    logger?.info({ service: fullService }, 'Alexa announce: sent');

    return { service: fullService, target: rawTarget || 'casa' };
  }

  /**
   * Returns the list of supported aliases (for help text / autocomplete).
   *
   * @returns {string[]}
   */
  function listTargetAliases() {
    return Object.keys(TARGET_ALIASES).sort();
  }

  return { announce, listTargetAliases };
}

/**
 * Maps a raw user-supplied target to the HA service suffix, normalising case and accents.
 *
 * @param {string} rawTarget
 * @returns {string}
 */
function resolveTargetSuffix(rawTarget) {
  const normalised = normaliseAlias(rawTarget);
  if (TARGET_ALIASES[normalised]) return TARGET_ALIASES[normalised];
  // Allow the user to pass the full service name (alexa_media_foo) or the suffix (foo).
  return rawTarget.replace(/^alexa_media_/, '');
}

/**
 * Lowercases and strips accents from an alias so user-typed targets match the table regardless
 * of case ("Salón" / "SALON" / "salon" all map to the same key).
 *
 * @param {string} input
 * @returns {string}
 */
function normaliseAlias(input) {
  return String(input ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * @param {string} input
 * @returns {boolean}
 */
function isKnownAlias(input) {
  return Object.prototype.hasOwnProperty.call(TARGET_ALIASES, normaliseAlias(input));
}

/**
 * Parses a raw `anuncia` invocation string into `{ target, message }`.
 *
 * Shared by the CLI and the Telegram bot so the same input syntaxes work in both:
 *
 *   "mensaje completo"               → target undefined (broadcast)
 *   "dormitorio el agua está lista"  → target "dormitorio", message "el agua está lista"
 *   "--en dormitorio mensaje"        → flag-style, target "dormitorio"
 *   "--to show hola"                 → flag-style (alias)
 *
 * The "first word = target" form only activates when the first word is a known alias; this
 * avoids stealing the first word of an unrelated message ("hola a todos" stays as a message
 * because "hola" is not an alias).
 *
 * @param {string} raw
 * @returns {{ target: string | undefined, message: string }}
 */
export function parseAnnounceInvocation(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { target: undefined, message: '' };

  // Flag-style: --en/--to/--target <target> <message...>
  // Acepta varias formas del prefijo porque los teclados móviles (incluido el de Telegram)
  // suelen autocorregir "--" a un guión largo "—" (em-dash, U+2014) o a "–" (en-dash, U+2013).
  const flagMatch = text.match(/^(?:--|—|–|-)(?:en|to|target)\s+(\S+)\s+([\s\S]+)$/);
  if (flagMatch) {
    return { target: flagMatch[1], message: flagMatch[2].trim() };
  }

  // Natural: first word matches a known alias
  const firstSpace = text.search(/\s/);
  if (firstSpace !== -1) {
    const first = text.slice(0, firstSpace);
    if (isKnownAlias(first)) {
      return { target: first, message: text.slice(firstSpace + 1).trim() };
    }
  }

  return { target: undefined, message: text };
}

/**
 * Returns the list of aliases users can pick when no target is given. Ordered for friendly
 * display (rooms first, then global). Each tuple is `[alias, label, emoji]`.
 *
 * @returns {Array<{ alias: string, label: string, emoji: string }>}
 */
export function listTargetChoices() {
  return [
    { alias: 'salon', label: 'Salón', emoji: '🛋️' },
    { alias: 'dormitorio', label: 'Dormitorio', emoji: '🛏️' },
    { alias: 'cocina', label: 'Cocina', emoji: '🍳' },
    { alias: 'show', label: 'Echo Show', emoji: '📺' },
    { alias: 'pop', label: 'Echo Pop', emoji: '🎵' },
    { alias: 'pueblo', label: 'Pueblo', emoji: '🏡' },
    { alias: 'firetv', label: 'Fire TV', emoji: '📡' },
    { alias: 'casa', label: 'Toda la casa', emoji: '🏠' },
  ];
}

/**
 * @typedef {Object} AlexaAnnouncer
 * @property {(message: string, options?: { target?: string }) => Promise<{ service: string, target: string }>} announce
 * @property {() => string[]} listTargetAliases
 */
