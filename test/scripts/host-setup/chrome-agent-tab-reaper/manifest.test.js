import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const DIR = new URL('../../../../scripts/host-setup/chrome-agent-tab-reaper/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', DIR), 'utf8'));

describe('chrome-agent-tab-reaper manifest', () => {
  it('asks only for alarms, storage and tab groups (no access to URLs or titles)', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions.toSorted(), ['alarms', 'storage', 'tabGroups']);
    assert.equal(manifest.host_permissions, undefined);
  });

  it('runs a module service worker that exists', async () => {
    assert.equal(manifest.background.type, 'module');
    await access(new URL(manifest.background.service_worker, DIR));
  });
});
