/**
 * Patterns that are considered dangerous when executed in a shell.
 * Each entry has a pattern to match and a human-readable reason.
 *
 * @type {Array<{ pattern: RegExp, reason: string }>}
 */
const DANGEROUS_PATTERNS = [
  { pattern: /\brm\s+-rf?\b/i, reason: 'Recursive delete command' },
  { pattern: /\bsudo\b/i, reason: 'Privilege escalation via sudo' },
  { pattern: /\bmkfs\b/i, reason: 'Filesystem format command' },
  { pattern: /\bdd\b.*of=/i, reason: 'Raw disk write via dd' },
  { pattern: /\bchmod\s+-R\s+777\b/i, reason: 'Insecure recursive chmod' },
  { pattern: /\bchown\s+-R\b/i, reason: 'Recursive ownership change' },
  { pattern: /\bdocker\s+system\s+prune\b/i, reason: 'Docker system prune removes all unused resources' },
  { pattern: /\bgit\s+push\s+--force\b/i, reason: 'Force push rewrites remote history' },
  { pattern: /\bgit\s+push\s+-f\b/i, reason: 'Force push rewrites remote history' },
  { pattern: /\btruncate\b/i, reason: 'File truncation command' },
  { pattern: /\bshred\b/i, reason: 'Irreversible file destruction' },
  { pattern: />\s*\/dev\/(s?d[a-z]|null|zero)/i, reason: 'Redirect to raw device or destructive target' },
  { pattern: /\bkillall\b/i, reason: 'Terminates all matching processes' },
  { pattern: /\bpkill\b/i, reason: 'Sends signals to processes by name' },
  { pattern: /:\(\)\s*\{.*\}\s*;/i, reason: 'Fork bomb pattern detected' },
];

/**
 * Creates a dangerous-command detector.
 *
 * @returns {DangerousCommandDetector}
 */
export function createDangerousCommandDetector() {
  /**
   * Checks whether a shell command matches any dangerous pattern.
   *
   * @param {string} command
   * @returns {{ dangerous: boolean, reason?: string }}
   */
  function check(command) {
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { dangerous: true, reason };
      }
    }
    return { dangerous: false };
  }

  /**
   * Returns the full list of dangerous patterns for inspection.
   *
   * @returns {Array<{ pattern: RegExp, reason: string }>}
   */
  function listPatterns() {
    return [...DANGEROUS_PATTERNS];
  }

  return { check, listPatterns };
}

/**
 * @typedef {Object} DangerousCommandDetector
 * @property {(command: string) => { dangerous: boolean, reason?: string }} check
 * @property {() => Array<{ pattern: RegExp, reason: string }>} listPatterns
 */
