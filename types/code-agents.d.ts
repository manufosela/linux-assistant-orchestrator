/**
 * Context passed to a coding agent.
 */
export interface CodeTaskContext {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  repositoryUrl: string;
  branchName: string;
  workspacePath: string;
  acceptanceCriteria?: string[];
  implementationPlan?: string;
  agent: 'codex' | 'claude' | 'gemini' | 'karajan';
}

/**
 * Result returned by a coding agent.
 */
export interface CodeTaskResult {
  success: boolean;
  taskId: string;
  agent: string;
  output?: string;
  filesChanged?: string[];
  testsStatus?: 'passed' | 'failed' | 'skipped';
  commitHash?: string;
  prUrl?: string;
  error?: string;
  requiresApproval: boolean;
  pendingActions?: PendingAction[];
}

/**
 * An action that requires explicit human approval before execution.
 */
export interface PendingAction {
  type: 'commit' | 'push' | 'openPr' | 'deleteFile' | 'shellCommand';
  description: string;
  payload: Record<string, unknown>;
}

/**
 * Abstract interface every coding agent must implement.
 */
export interface CodeAgent {
  readonly name: string;
  runCodeTask(context: CodeTaskContext): Promise<CodeTaskResult>;
}
