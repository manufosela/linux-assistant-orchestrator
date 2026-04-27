import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createFileMover } from '../../../src/modules/downloads/file-mover.js';

/** @returns {object} */
function makeLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe('file-mover', () => {
  describe('moveToDirectory', () => {
    it('moves a file to the target directory', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'assistant-test-'));
      const targetDir = join(tmpDir, 'target');
      const sourcePath = join(tmpDir, 'document.pdf');

      await writeFile(sourcePath, 'pdf content');

      const mover = createFileMover(makeLogger());

      try {
        const result = await mover.moveToDirectory(sourcePath, targetDir);

        assert.equal(result.success, true);
        assert.equal(result.sourcePath, sourcePath);
        assert.equal(result.targetPath, join(targetDir, 'document.pdf'));
        assert.equal(result.skipped, undefined);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('skips the move when target file already exists', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'assistant-test-'));
      const targetDir = join(tmpDir, 'target');

      // Create source and a pre-existing target
      await writeFile(join(tmpDir, 'file.txt'), 'original');
      const { mkdir, writeFile: wf } = await import('node:fs/promises');
      await mkdir(targetDir, { recursive: true });
      await wf(join(targetDir, 'file.txt'), 'existing');

      const mover = createFileMover(makeLogger());

      try {
        const result = await mover.moveToDirectory(join(tmpDir, 'file.txt'), targetDir);

        assert.equal(result.success, false);
        assert.equal(result.skipped, true);
        assert.ok(result.skipReason.includes('already exists'));
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns skipped when source file does not exist', async () => {
      const mover = createFileMover(makeLogger());

      const result = await mover.moveToDirectory('/nonexistent/path/file.pdf', '/some/target');

      assert.equal(result.success, false);
      assert.equal(result.skipped, true);
      assert.ok(result.skipReason.includes('does not exist'));
    });

    it('creates intermediate directories in the target path', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'assistant-test-'));
      const deepTargetDir = join(tmpDir, 'a', 'b', 'c', 'deep');
      const sourcePath = join(tmpDir, 'file.pdf');

      await writeFile(sourcePath, 'data');

      const mover = createFileMover(makeLogger());

      try {
        const result = await mover.moveToDirectory(sourcePath, deepTargetDir);
        assert.equal(result.success, true);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('move', () => {
    it('moves a file to an explicit target path', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'assistant-test-'));
      const sourcePath = join(tmpDir, 'source.txt');
      const targetPath = join(tmpDir, 'target', 'renamed.txt');

      await writeFile(sourcePath, 'hello');

      const mover = createFileMover(makeLogger());

      try {
        const result = await mover.move(sourcePath, targetPath);
        assert.equal(result.success, true);
        assert.equal(result.targetPath, targetPath);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
