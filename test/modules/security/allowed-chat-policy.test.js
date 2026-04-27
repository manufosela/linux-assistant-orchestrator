import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAllowedChatPolicy } from '../../../src/modules/security/allowed-chat-policy.js';

/** @returns {object} */
function makeLogger() {
  const warnings = [];
  return {
    info: () => {},
    warn: (obj) => warnings.push(obj),
    error: () => {},
    debug: () => {},
    _warnings: warnings,
  };
}

describe('allowed-chat-policy', () => {
  describe('isAllowed', () => {
    it('returns true for a chat ID in the allowlist', () => {
      const logger = makeLogger();
      const policy = createAllowedChatPolicy(['123456', '789012'], logger);

      assert.equal(policy.isAllowed('123456'), true);
    });

    it('returns false for a chat ID not in the allowlist', () => {
      const logger = makeLogger();
      const policy = createAllowedChatPolicy(['123456'], logger);

      assert.equal(policy.isAllowed('999999'), false);
    });

    it('accepts numeric chat IDs by converting them to strings', () => {
      const logger = makeLogger();
      const policy = createAllowedChatPolicy(['123456'], logger);

      assert.equal(policy.isAllowed(123456), true);
    });

    it('returns false when allowlist is empty', () => {
      const logger = makeLogger();
      const policy = createAllowedChatPolicy([], logger);

      assert.equal(policy.isAllowed('123456'), false);
    });
  });

  describe('validate', () => {
    it('returns true and does not log for an authorised chat ID', () => {
      const logger = makeLogger();
      const policy = createAllowedChatPolicy(['123456'], logger);

      const result = policy.validate('123456');

      assert.equal(result, true);
      assert.equal(logger._warnings.length, 0);
    });

    it('returns false and logs a warning for an unauthorised chat ID', () => {
      const logger = makeLogger();
      const policy = createAllowedChatPolicy(['123456'], logger);

      const result = policy.validate('999999');

      assert.equal(result, false);
      assert.equal(logger._warnings.length, 1);
    });

    it('does not expose the allowlist contents in the warning log', () => {
      const logger = makeLogger();
      const policy = createAllowedChatPolicy(['secretId'], logger);

      policy.validate('attacker');

      const warning = JSON.stringify(logger._warnings[0]);
      assert.ok(!warning.includes('secretId'), 'allowlist must not be exposed in logs');
    });
  });

  describe('getAllowedCount', () => {
    it('returns the number of configured allowed chat IDs', () => {
      const logger = makeLogger();
      const policy = createAllowedChatPolicy(['a', 'b', 'c'], logger);

      assert.equal(policy.getAllowedCount(), 3);
    });

    it('returns 0 when no chat IDs are configured', () => {
      const logger = makeLogger();
      const policy = createAllowedChatPolicy([], logger);

      assert.equal(policy.getAllowedCount(), 0);
    });
  });
});
