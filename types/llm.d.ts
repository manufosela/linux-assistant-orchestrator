/**
 * Metadata attached to every LLM request for observability.
 */
export interface LlmRequestMetadata {
  module: string;
  operation: string;
  correlationId: string;
  timestamp?: string;
}

/**
 * Input to an LLM text generation call.
 */
export interface LlmPromptRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  metadata: LlmRequestMetadata;
}

/**
 * Output of an LLM text generation call.
 */
export interface LlmPromptResponse {
  text: string;
  model: string;
  provider: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

/**
 * Abstract LLM provider interface.
 * All providers must implement this contract.
 */
export interface LlmProvider {
  generateText(request: LlmPromptRequest): Promise<LlmPromptResponse>;
  checkHealth(): Promise<boolean>;
}

/**
 * Configuration for the local LLM endpoint.
 */
export interface LocalLlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

/**
 * Configuration for cloud LLM providers.
 */
export interface CloudLlmConfig {
  provider: string;
  apiKey: string;
}

/**
 * Top-level LLM configuration.
 */
export interface LlmConfig {
  provider: 'local' | 'cloud';
  allowCloudLlm: boolean;
  local: LocalLlmConfig;
  cloud?: CloudLlmConfig;
}

/**
 * Result of an LLM health check.
 */
export interface LlmHealthStatus {
  healthy: boolean;
  provider: string;
  model: string;
  baseUrl?: string;
  error?: string;
}
