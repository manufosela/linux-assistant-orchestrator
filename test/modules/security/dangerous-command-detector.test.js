import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDangerousCommandDetector } from '../../../src/modules/security/dangerous-command-detector.js';

describe('dangerous-command-detector', () => {
  describe('check', () => {
    const detector = createDangerousCommandDetector();

    const dangerousCases = [
      ['rm -rf /home/user', 'Recursive delete'],
      ['rm -rf /', 'Recursive root delete'],
      ['sudo apt-get install vim', 'sudo'],
      ['sudo rm -rf /var', 'sudo with rm'],
      ['mkfs.ext4 /dev/sda', 'filesystem format'],
      ['dd if=/dev/zero of=/dev/sda', 'dd write to device'],
      ['chmod -R 777 /var/www', 'chmod -R 777'],
      ['chown -R www-data /var', 'chown -R'],
      ['docker system prune -af', 'docker system prune'],
      ['git push --force origin main', 'git force push'],
      ['git push -f origin main', 'git push -f'],
      [':(){ :|:& };:', 'fork bomb'],
    ];

    for (const [command, description] of dangerousCases) {
      it(`blocks dangerous command: ${description}`, () => {
        const result = detector.check(command);
        assert.equal(result.dangerous, true, `Expected "${command}" to be detected as dangerous`);
        assert.ok(typeof result.reason === 'string', 'Should provide a reason');
        assert.ok(result.reason.length > 0, 'Reason should not be empty');
      });
    }

    const safeCases = [
      'ls -la',
      'git status',
      'git commit -m "feat: add feature"',
      'git push origin feature/my-branch',
      'npm install',
      'pnpm test',
      'cat README.md',
      'echo hello',
      'node src/main.js',
    ];

    for (const command of safeCases) {
      it(`allows safe command: ${command}`, () => {
        const result = detector.check(command);
        assert.equal(result.dangerous, false, `Expected "${command}" to be allowed`);
      });
    }

    it('listPatterns returns a non-empty array of patterns', () => {
      const patterns = detector.listPatterns();
      assert.ok(Array.isArray(patterns));
      assert.ok(patterns.length > 0);
      assert.ok(patterns[0].pattern instanceof RegExp);
      assert.ok(typeof patterns[0].reason === 'string');
    });
  });
});
