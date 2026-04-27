import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * The only module permitted to execute shell commands.
 * All other modules must use this runner — direct child_process calls are forbidden.
 *
 * @param {import('../../modules/security/dangerous-command-detector.js').DangerousCommandDetector} dangerousCommandDetector
 * @param {import('../../modules/security/approval-service.js').ApprovalService} approvalService
 * @param {import('pino').Logger} logger
 * @returns {ShellCommandRunner}
 */
export function createShellCommandRunner(dangerousCommandDetector, approvalService, logger) {
  /**
   * Executes a shell command with safety checks.
   * Dangerous commands require prior approval.
   *
   * @param {string} command
   * @param {{ cwd?: string, timeoutMs?: number, requireApproval?: boolean }} [options]
   * @returns {Promise<ShellCommandResult>}
   */
  async function run(command, options = {}) {
    const { cwd = process.cwd(), timeoutMs = 30000, requireApproval = true } = options;

    const dangerCheck = dangerousCommandDetector.check(command);
    if (dangerCheck.dangerous) {
      logger.warn({ command, reason: dangerCheck.reason }, 'Dangerous command detected');

      if (requireApproval) {
        const approvalResult = await approvalService.requestApproval({
          action: 'shellCommand',
          description: `Execute shell command: ${command}`,
          payload: { command, cwd },
        });

        if (!approvalResult.approved) {
          return {
            success: false,
            stdout: '',
            stderr: '',
            exitCode: -1,
            blocked: true,
            reason: 'Approval required before executing dangerous command',
          };
        }
      }
    }

    logger.debug({ command, cwd }, 'Executing shell command');

    try {
      const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs });
      logger.debug({ command, exitCode: 0 }, 'Command completed');
      return { success: true, stdout, stderr, exitCode: 0, blocked: false };
    } catch (error) {
      const exitCode = error.code ?? 1;
      logger.error({ command, exitCode, err: error.message }, 'Command failed');
      return {
        success: false,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? error.message,
        exitCode,
        blocked: false,
        reason: error.message,
      };
    }
  }

  return { run };
}

/**
 * @typedef {Object} ShellCommandResult
 * @property {boolean} success
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} exitCode
 * @property {boolean} blocked
 * @property {string} [reason]
 */

/**
 * @typedef {Object} ShellCommandRunner
 * @property {(command: string, options?: object) => Promise<ShellCommandResult>} run
 */
