import { extname } from 'node:path';

/**
 * Creates a rule-based file classifier.
 * Classifies files by matching their extension against configured rules.
 *
 * @param {import('./download-rules-repository.js').DownloadRulesRepository} rulesRepository
 * @returns {FileClassifier}
 */
export function createFileClassifier(rulesRepository) {
  /**
   * Classifies a file by its path using extension-based rules.
   * Returns the first matching rule or an unmatched result.
   *
   * @param {string} filePath
   * @returns {Promise<import('../../../types/downloads.js').FileClassificationResult>}
   */
  async function classify(filePath) {
    const extension = extname(filePath).toLowerCase();

    if (!extension) {
      return { matched: false, method: 'none' };
    }

    const rules = await rulesRepository.loadRules();
    const matchingRule = findMatchingRule(rules, extension);

    if (matchingRule) {
      return { matched: true, rule: matchingRule, method: 'rule' };
    }

    return { matched: false, method: 'none' };
  }

  /**
   * Finds the first rule whose extension list contains the given extension.
   *
   * @param {import('../../../types/downloads.js').DownloadRule[]} rules
   * @param {string} extension - already lowercased
   * @returns {import('../../../types/downloads.js').DownloadRule | undefined}
   */
  function findMatchingRule(rules, extension) {
    return rules.find((rule) =>
      rule.extensions.some((ext) => ext.toLowerCase() === extension)
    );
  }

  return { classify };
}

/**
 * @typedef {Object} FileClassifier
 * @property {(filePath: string) => Promise<import('../../../types/downloads.js').FileClassificationResult>} classify
 */
