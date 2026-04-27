import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLlmFileClassifier } from '../../../src/modules/downloads/llm-file-classifier.js';

/** @returns {object} */
function makeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

const SAMPLE_RULES = [
  { name: 'PDF documents', extensions: ['.pdf'], targetPath: '/docs/pdf' },
  { name: 'Images', extensions: ['.jpg', '.jpeg', '.png'], targetPath: '/images' },
];

/**
 * @param {import('../../../types/downloads.js').DownloadRule[]} rules
 * @returns {object}
 */
function makeRulesRepository(rules) {
  return {
    loadRules: async () => rules,
    invalidateCache: () => {},
  };
}

/**
 * @param {string} responseText
 * @returns {object}
 */
function makeLlmService(responseText) {
  return {
    generateText: async () => responseText,
    checkHealth: async () => ({ healthy: true, provider: 'local', model: 'test' }),
  };
}

describe('llm-file-classifier', () => {
  describe('classify', () => {
    it('returns matched=true with the correct rule when LLM picks category 1', async () => {
      const llmService = makeLlmService('1');
      const classifier = createLlmFileClassifier(llmService, makeRulesRepository(SAMPLE_RULES), makeLogger());

      const result = await classifier.classify('/downloads/report.xyz');

      assert.equal(result.matched, true);
      assert.equal(result.method, 'llm');
      assert.equal(result.rule.name, 'PDF documents');
    });

    it('returns matched=true with Images rule when LLM picks category 2', async () => {
      const llmService = makeLlmService('2');
      const classifier = createLlmFileClassifier(llmService, makeRulesRepository(SAMPLE_RULES), makeLogger());

      const result = await classifier.classify('/downloads/photo.unknown');

      assert.equal(result.matched, true);
      assert.equal(result.rule.name, 'Images');
    });

    it('returns matched=false when LLM responds "none"', async () => {
      const llmService = makeLlmService('none');
      const classifier = createLlmFileClassifier(llmService, makeRulesRepository(SAMPLE_RULES), makeLogger());

      const result = await classifier.classify('/downloads/mystery.bin');

      assert.equal(result.matched, false);
      assert.equal(result.method, 'llm');
    });

    it('returns matched=false and logs a warning when LLM returns unexpected text', async () => {
      const warnings = [];
      const logger = { ...makeLogger(), warn: (obj) => warnings.push(obj) };
      const llmService = makeLlmService('category three please');
      const classifier = createLlmFileClassifier(llmService, makeRulesRepository(SAMPLE_RULES), logger);

      const result = await classifier.classify('/downloads/unknown.bin');

      assert.equal(result.matched, false);
      assert.ok(warnings.length > 0, 'should log a warning for unexpected response');
    });

    it('returns matched=false and method=none when rules list is empty', async () => {
      const llmService = makeLlmService('1');
      const classifier = createLlmFileClassifier(llmService, makeRulesRepository([]), makeLogger());

      const result = await classifier.classify('/downloads/file.pdf');

      assert.equal(result.matched, false);
      assert.equal(result.method, 'llm');
    });

    it('returns matched=false and method=none when LLM throws an error', async () => {
      const llmService = {
        generateText: async () => { throw new Error('LLM unavailable'); },
      };
      const classifier = createLlmFileClassifier(llmService, makeRulesRepository(SAMPLE_RULES), makeLogger());

      const result = await classifier.classify('/downloads/file.xyz');

      assert.equal(result.matched, false);
      assert.equal(result.method, 'none');
    });
  });
});
