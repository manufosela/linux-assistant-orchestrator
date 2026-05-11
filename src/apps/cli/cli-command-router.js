/**
 * Creates a CLI command router.
 * Maps command tokens (e.g. ['llm', 'status']) to registered handlers and dispatches them.
 *
 * Handlers receive a {@link CommandContext} with positional args, parsed flags and the renderer.
 * Errors thrown by handlers are caught, rendered as user-facing errors and the router resolves
 * with an exit code so the CLI binary never crashes the process abruptly.
 *
 * @param {{ renderer: import('./terminal-renderer.js').TerminalRenderer, logger: import('pino').Logger }} deps
 * @returns {CliCommandRouter}
 */
export function createCliCommandRouter({ renderer, logger }) {
  /** @type {Map<string, CommandDefinition>} */
  const handlers = new Map();

  /**
   * Registers a handler under a command path.
   *
   * @param {string} commandPath - space-separated command tokens, e.g. 'llm status'
   * @param {CommandHandler} handler
   * @param {{ description?: string }} [meta]
   */
  function register(commandPath, handler, meta = {}) {
    const key = normaliseKey(commandPath);
    handlers.set(key, { handler, description: meta.description ?? '' });
  }

  /**
   * Dispatches a command from a list of argv tokens.
   *
   * @param {string[]} argv
   * @returns {Promise<number>} exit code (0 on success, non-zero on error or unknown command)
   */
  async function route(argv) {
    if (argv.length === 0) {
      printHelp();
      return 0;
    }

    const { commandKey, positional, flags } = matchCommand(argv);

    if (!commandKey) {
      renderer.error(`Unknown command: ${argv.join(' ')}`);
      printHelp();
      return 1;
    }

    const definition = handlers.get(commandKey);
    if (!definition) {
      renderer.error(`Unknown command: ${argv.join(' ')}`);
      printHelp();
      return 1;
    }

    try {
      const result = await definition.handler({
        args: positional,
        flags,
        renderer,
      });
      return result?.exitCode ?? 0;
    } catch (error) {
      logger.error({ err: error?.message, command: commandKey }, 'CLI command failed');
      renderer.error(`Error: ${error?.message ?? 'unknown error'}`);
      return 1;
    }
  }

  /**
   * Returns the longest matching command path against the argv tokens.
   * Anything after the matched path is returned as positional args; tokens starting with `--` are
   * collected as flags. Only the prefix used by registered commands is consumed.
   *
   * @param {string[]} argv
   * @returns {{ commandKey: string | null, positional: string[], flags: Record<string, string|boolean> }}
   */
  function matchCommand(argv) {
    const tokens = argv.slice();
    let commandKey = null;
    let consumed = 0;

    for (let i = Math.min(tokens.length, 4); i >= 1; i -= 1) {
      const candidate = normaliseKey(tokens.slice(0, i).join(' '));
      if (handlers.has(candidate)) {
        commandKey = candidate;
        consumed = i;
        break;
      }
    }

    const rest = tokens.slice(consumed);
    const positional = [];
    const flags = {};

    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (token.startsWith('--')) {
        const flagName = token.slice(2);
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[flagName] = next;
          i += 1;
        } else {
          flags[flagName] = true;
        }
      } else {
        positional.push(token);
      }
    }

    return { commandKey, positional, flags };
  }

  /**
   * Renders the help text listing every registered command.
   */
  function printHelp() {
    const entries = [...handlers.entries()].sort(([a], [b]) => a.localeCompare(b));
    renderer.print('Usage: luis <command> [args] [flags]');
    renderer.print('');
    renderer.print('Available commands:');
    for (const [key, definition] of entries) {
      const description = definition.description ? ` — ${definition.description}` : '';
      renderer.print(`  luis ${key}${description}`);
    }
    renderer.print('');
    renderer.print('Run `luis` with no arguments to start an interactive session.');
  }

  /**
   * Lists registered command paths in registration order.
   *
   * @returns {string[]}
   */
  function listCommands() {
    return [...handlers.keys()].sort();
  }

  /**
   * Normalises a command path: trims, lowercases, collapses whitespace.
   *
   * @param {string} commandPath
   * @returns {string}
   */
  function normaliseKey(commandPath) {
    return commandPath.trim().toLowerCase().split(/\s+/).join(' ');
  }

  return { register, route, listCommands, printHelp };
}

/**
 * @typedef {Object} CommandContext
 * @property {string[]} args
 * @property {Record<string, string|boolean>} flags
 * @property {import('./terminal-renderer.js').TerminalRenderer} renderer
 */

/**
 * @callback CommandHandler
 * @param {CommandContext} context
 * @returns {Promise<{ exitCode?: number } | void> | { exitCode?: number } | void}
 */

/**
 * @typedef {Object} CommandDefinition
 * @property {CommandHandler} handler
 * @property {string} description
 */

/**
 * @typedef {Object} CliCommandRouter
 * @property {(commandPath: string, handler: CommandHandler, meta?: { description?: string }) => void} register
 * @property {(argv: string[]) => Promise<number>} route
 * @property {() => string[]} listCommands
 * @property {() => void} printHelp
 */
