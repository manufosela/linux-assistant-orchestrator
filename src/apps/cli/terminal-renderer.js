/**
 * Creates a terminal renderer with simple ANSI colour formatting.
 * Centralises all stdout/stderr writes so the rest of the CLI never touches the console.
 *
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, useColor?: boolean }} [options]
 * @returns {TerminalRenderer}
 */
export function createTerminalRenderer(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const useColor = options.useColor ?? Boolean(stdout.isTTY);

  const ansi = {
    reset: useColor ? '[0m' : '',
    bold: useColor ? '[1m' : '',
    dim: useColor ? '[2m' : '',
    cyan: useColor ? '[36m' : '',
    green: useColor ? '[32m' : '',
    yellow: useColor ? '[33m' : '',
    red: useColor ? '[31m' : '',
    blue: useColor ? '[34m' : '',
  };

  /**
   * Writes a line to stdout.
   *
   * @param {string} [text]
   */
  function print(text = '') {
    stdout.write(`${text}\n`);
  }

  /**
   * Renders the CLI banner shown at session start.
   *
   * @param {{ name: string, version: string, llmProvider: string }} info
   */
  function header({ name, version, llmProvider }) {
    print(`${ansi.bold}${ansi.cyan}${name}${ansi.reset} ${ansi.dim}v${version}${ansi.reset}`);
    print(`${ansi.dim}LLM provider: ${llmProvider}. Type "exit" or press Ctrl+C to leave.${ansi.reset}`);
    print('');
  }

  /**
   * Renders an informational message.
   *
   * @param {string} text
   */
  function info(text) {
    print(`${ansi.blue}${text}${ansi.reset}`);
  }

  /**
   * Renders a success message.
   *
   * @param {string} text
   */
  function success(text) {
    print(`${ansi.green}${text}${ansi.reset}`);
  }

  /**
   * Renders a warning message.
   *
   * @param {string} text
   */
  function warning(text) {
    print(`${ansi.yellow}${text}${ansi.reset}`);
  }

  /**
   * Renders an error message to stderr.
   *
   * @param {string} text
   */
  function error(text) {
    stderr.write(`${ansi.red}${text}${ansi.reset}\n`);
  }

  /**
   * Returns the prompt string used by the interactive session.
   *
   * @returns {string}
   */
  function promptString() {
    return `${ansi.bold}${ansi.cyan}luis>${ansi.reset} `;
  }

  /**
   * Renders the assistant status as a human-readable block.
   *
   * @param {import('../../modules/assistant/assistant-status-service.js').AssistantStatus} status
   */
  function renderStatus(status) {
    print(`${ansi.bold}${status.name}${ansi.reset}`);
    print(`${ansi.dim}Started:${ansi.reset} ${status.startedAt}`);
    print(`${ansi.dim}Uptime:${ansi.reset}  ${status.uptimeFormatted}`);
    print(`${ansi.dim}Env:${ansi.reset}     ${status.environment}`);
    print('');
    print(`${ansi.bold}Modules:${ansi.reset}`);
    for (const moduleStatus of status.modules) {
      const note = moduleStatus.note ? ` ${ansi.dim}(${moduleStatus.note})${ansi.reset}` : '';
      print(`  • ${moduleStatus.name}: ${moduleStatus.status}${note}`);
    }
  }

  /**
   * Renders an LLM health-check result.
   *
   * @param {import('../../../types/llm.js').LlmHealthStatus} health
   */
  function renderLlmStatus(health) {
    const icon = health.healthy ? `${ansi.green}✓${ansi.reset}` : `${ansi.red}✗${ansi.reset}`;
    print(`${icon} provider: ${health.provider}`);
    print(`  model:    ${health.model || '(not configured)'}`);
    if (health.baseUrl) {
      print(`  endpoint: ${health.baseUrl}`);
    }
    if (!health.healthy) {
      warning('LLM provider is not reachable.');
    }
  }

  /**
   * Renders a list of download rules.
   *
   * @param {import('../../../types/downloads.js').DownloadRule[]} rules
   */
  function renderRules(rules) {
    if (rules.length === 0) {
      info('No download rules configured.');
      return;
    }
    print(`${ansi.bold}Download rules (${rules.length}):${ansi.reset}`);
    rules.forEach((rule, index) => {
      print(`  ${index + 1}. ${ansi.bold}${rule.name}${ansi.reset}`);
      print(`     extensions: ${rule.extensions.join(', ')}`);
      print(`     target:     ${rule.targetPath}`);
    });
  }

  return {
    print,
    header,
    info,
    success,
    warning,
    error,
    promptString,
    renderStatus,
    renderLlmStatus,
    renderRules,
  };
}

/**
 * @typedef {Object} TerminalRenderer
 * @property {(text?: string) => void} print
 * @property {(info: { name: string, version: string, llmProvider: string }) => void} header
 * @property {(text: string) => void} info
 * @property {(text: string) => void} success
 * @property {(text: string) => void} warning
 * @property {(text: string) => void} error
 * @property {() => string} promptString
 * @property {(status: import('../../modules/assistant/assistant-status-service.js').AssistantStatus) => void} renderStatus
 * @property {(health: import('../../../types/llm.js').LlmHealthStatus) => void} renderLlmStatus
 * @property {(rules: import('../../../types/downloads.js').DownloadRule[]) => void} renderRules
 */
