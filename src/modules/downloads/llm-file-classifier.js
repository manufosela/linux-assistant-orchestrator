import { basename, extname } from 'node:path';

/**
 * Maximum file name length to send to the LLM to avoid leaking sensitive paths.
 */
const MAX_FILENAME_LENGTH = 120;

/**
 * Creates an LLM-based file classifier used as fallback when rule-based classification fails.
 * Only classifies by filename and extension — never reads file contents.
 *
 * @param {import('../llm/llm-service.js').LlmService} llmService
 * @param {import('./download-rules-repository.js').DownloadRulesRepository} rulesRepository
 * @param {import('pino').Logger} logger
 * @returns {LlmFileClassifier}
 */
export function createLlmFileClassifier(llmService, rulesRepository, logger) {
  /**
   * Attempts to classify a file using the LLM.
   * Returns a classification result with the best matching rule.
   *
   * @param {string} filePath
   * @returns {Promise<import('../../../types/downloads.js').FileClassificationResult>}
   */
  async function classify(filePath) {
    const fileName = basename(filePath).slice(0, MAX_FILENAME_LENGTH);
    const extension = extname(filePath).toLowerCase();
    const rules = await rulesRepository.loadRules();

    if (rules.length === 0) {
      return { matched: false, method: 'llm' };
    }

    const ruleDescriptions = rules
      .map((r, i) => `${i + 1}. "${r.name}" — extensions: ${r.extensions.join(', ')}`)
      .join('\n');

    const prompt = [
      `You are a file organiser. Given a filename, choose the best matching category from the list below.`,
      `Respond with ONLY the category number (1, 2, etc.) or "none" if nothing matches.`,
      ``,
      `Filename: ${fileName}`,
      `Extension: ${extension || '(none)'}`,
      ``,
      `Categories:`,
      ruleDescriptions,
    ].join('\n');

    try {
      const response = await llmService.generateText(prompt, {
        module: 'downloads',
        operation: 'classifyFile',
        private: false,
        maxTokens: 10,
        temperature: 0,
      });

      const trimmed = response.trim().toLowerCase();

      if (trimmed === 'none') {
        return { matched: false, method: 'llm' };
      }

      const index = parseInt(trimmed, 10) - 1;
      if (Number.isInteger(index) && index >= 0 && index < rules.length) {
        return { matched: true, rule: rules[index], method: 'llm' };
      }

      logger.warn({ fileName, response: trimmed }, 'LLM classifier returned unexpected response');
      return { matched: false, method: 'llm' };
    } catch (error) {
      logger.error({ fileName, err: error.message }, 'LLM file classification failed');
      return { matched: false, method: 'none' };
    }
  }

  return { classify };
}

/**
 * @typedef {Object} LlmFileClassifier
 * @property {(filePath: string) => Promise<import('../../../types/downloads.js').FileClassificationResult>} classify
 */
