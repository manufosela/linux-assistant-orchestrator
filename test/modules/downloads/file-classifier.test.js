import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFileClassifier } from '../../../src/modules/downloads/file-classifier.js';

/**
 * Creates a fake rules repository with the given rules.
 *
 * @param {import('../../../types/downloads.js').DownloadRule[]} rules
 * @returns {object}
 */
function makeRulesRepository(rules) {
  return {
    loadRules: async () => rules,
    invalidateCache: () => {},
  };
}

const SAMPLE_RULES = [
  { name: 'PDF documents', extensions: ['.pdf'], targetPath: '/docs/pdf' },
  { name: 'Images', extensions: ['.jpg', '.jpeg', '.png', '.webp'], targetPath: '/images' },
  { name: 'Archives', extensions: ['.zip', '.tar', '.gz'], targetPath: '/archives' },
];

describe('file-classifier', () => {
  describe('classify', () => {
    it('returns matched=true and the correct rule for a known extension', async () => {
      const classifier = createFileClassifier(makeRulesRepository(SAMPLE_RULES));

      const result = await classifier.classify('/downloads/report.pdf');

      assert.equal(result.matched, true);
      assert.equal(result.method, 'rule');
      assert.equal(result.rule.name, 'PDF documents');
      assert.equal(result.rule.targetPath, '/docs/pdf');
    });

    it('matches case-insensitively', async () => {
      const classifier = createFileClassifier(makeRulesRepository(SAMPLE_RULES));

      const result = await classifier.classify('/downloads/photo.JPG');

      assert.equal(result.matched, true);
      assert.equal(result.rule.name, 'Images');
    });

    it('returns matched=false when no rule matches the extension', async () => {
      const classifier = createFileClassifier(makeRulesRepository(SAMPLE_RULES));

      const result = await classifier.classify('/downloads/unknown.xyz');

      assert.equal(result.matched, false);
      assert.equal(result.method, 'none');
      assert.equal(result.rule, undefined);
    });

    it('returns matched=false when the file has no extension', async () => {
      const classifier = createFileClassifier(makeRulesRepository(SAMPLE_RULES));

      const result = await classifier.classify('/downloads/Makefile');

      assert.equal(result.matched, false);
      assert.equal(result.method, 'none');
    });

    it('returns matched=false when rules list is empty', async () => {
      const classifier = createFileClassifier(makeRulesRepository([]));

      const result = await classifier.classify('/downloads/file.pdf');

      assert.equal(result.matched, false);
    });

    it('returns matched=true for .webp files using the images rule', async () => {
      const classifier = createFileClassifier(makeRulesRepository(SAMPLE_RULES));

      const result = await classifier.classify('/downloads/thumbnail.webp');

      assert.equal(result.matched, true);
      assert.equal(result.rule.name, 'Images');
    });

    it('returns matched=true for .gz archive', async () => {
      const classifier = createFileClassifier(makeRulesRepository(SAMPLE_RULES));

      const result = await classifier.classify('/downloads/backup.tar.gz');

      assert.equal(result.matched, true);
      assert.equal(result.rule.name, 'Archives');
    });
  });
});
