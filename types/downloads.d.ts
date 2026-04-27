/**
 * A single file organisation rule.
 */
export interface DownloadRule {
  name: string;
  extensions: string[];
  targetPath: string;
}

/**
 * The full set of download rules loaded from configuration.
 */
export interface DownloadRules {
  rules: DownloadRule[];
}

/**
 * Result of classifying a file.
 */
export interface FileClassificationResult {
  matched: boolean;
  rule?: DownloadRule;
  method: 'rule' | 'llm' | 'none';
}

/**
 * Result of a file move operation.
 */
export interface FileMoveResult {
  success: boolean;
  sourcePath: string;
  targetPath: string;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
}

/**
 * Options for the file mover.
 */
export interface FileMoverOptions {
  overwriteExisting?: boolean;
}

/**
 * Configuration for the downloads watcher.
 */
export interface DownloadWatcherConfig {
  watchPath: string;
  enableLlmClassification: boolean;
}
