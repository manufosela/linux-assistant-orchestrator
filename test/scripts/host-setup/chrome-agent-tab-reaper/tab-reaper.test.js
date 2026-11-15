import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE_LIMIT_MS,
  activityKey,
  pickIdleAgentTabs,
  reapIdleAgentTabs,
} from '../../../../scripts/host-setup/chrome-agent-tab-reaper/tab-reaper.js';

const NOW = Date.parse('2026-11-15T10:00:00Z');
const MINUTE = 60_000;
const groups = [
  { id: 1, title: 'Claude' },
  { id: 2, title: 'Claude (MCP)' },
  { id: 3, title: 'Trabajo' },
];
const tab = (id, groupId, minutesAgo, extra = {}) => ({
  id, groupId, active: false, audible: false, lastAccessed: NOW - minutesAgo * MINUTE, ...extra,
});

describe('pickIdleAgentTabs', () => {
  it('picks agent tabs idle for 30 minutes or more', () => {
    const tabs = [tab(10, 1, 31), tab(11, 2, 45), tab(12, 1, 5)];

    assert.deepEqual(pickIdleAgentTabs({ tabs, groups, activity: {}, now: NOW }), [10, 11]);
  });

  it('never picks tabs outside agent groups, ungrouped, active or playing sound', () => {
    const tabs = [
      tab(20, 3, 120),
      tab(21, -1, 120),
      tab(22, 1, 120, { active: true }),
      tab(23, 1, 120, { audible: true }),
    ];

    assert.deepEqual(pickIdleAgentTabs({ tabs, groups, activity: {}, now: NOW }), []);
  });

  it('counts recent navigation by the agent as activity', () => {
    const tabs = [tab(30, 1, 90)];
    const activity = { 30: NOW - 2 * MINUTE };

    assert.deepEqual(pickIdleAgentTabs({ tabs, groups, activity, now: NOW }), []);
  });

  it('keeps a tab when it is unknown when it was last used', () => {
    const tabs = [tab(31, 1, 0, { lastAccessed: undefined })];

    assert.deepEqual(pickIdleAgentTabs({ tabs, groups, activity: {}, now: NOW }), []);
  });

  it('uses a 30 minute limit by default', () => {
    assert.equal(IDLE_LIMIT_MS, 30 * MINUTE);
  });
});

function fakeChrome({ tabs, session = {} }) {
  const store = { session, local: { closedTabs: [] } };
  const removed = [];
  const area = (name) => ({
    get: async (key) => (key === null ? { ...store[name] } : { [key]: store[name][key] }),
    set: async (values) => { Object.assign(store[name], values); },
  });
  return {
    removed,
    store,
    api: {
      tabs: { query: async () => tabs, remove: async (ids) => { removed.push(...ids); } },
      tabGroups: { query: async () => groups },
      storage: { session: area('session'), local: area('local') },
    },
  };
}

describe('reapIdleAgentTabs', () => {
  it('closes the idle agent tabs and logs each one', async () => {
    const chrome = fakeChrome({ tabs: [tab(40, 2, 50), tab(41, 3, 50)] });

    const closed = await reapIdleAgentTabs(chrome.api, NOW);

    assert.deepEqual(closed, [40]);
    assert.deepEqual(chrome.removed, [40]);
    assert.deepEqual(chrome.store.local.closedTabs, [
      { at: '2026-11-15T10:00:00.000Z', tabId: 40, group: 'Claude (MCP)' },
    ]);
  });

  it('keeps every tab whose recent activity was stored under its own key', async () => {
    const session = { [activityKey(60)]: NOW - MINUTE, [activityKey(61)]: NOW - 2 * MINUTE };
    const chrome = fakeChrome({ tabs: [tab(60, 1, 90), tab(61, 1, 90), tab(62, 1, 90)], session });

    assert.deepEqual(await reapIdleAgentTabs(chrome.api, NOW), [62]);
  });

  it('checks again right before closing and spares a tab that became active', async () => {
    const chrome = fakeChrome({ tabs: [tab(70, 1, 90), tab(71, 1, 90)] });
    const snapshots = [[tab(70, 1, 90), tab(71, 1, 90)], [tab(70, 1, 90, { active: true }), tab(71, 1, 90)]];
    chrome.api.tabs.query = async () => snapshots.shift();

    assert.deepEqual(await reapIdleAgentTabs(chrome.api, NOW), [71]);
    assert.deepEqual(chrome.removed, [71]);
  });

  it('does nothing when no agent tab is idle', async () => {
    const chrome = fakeChrome({ tabs: [tab(50, 1, 1)] });

    assert.deepEqual(await reapIdleAgentTabs(chrome.api, NOW), []);
    assert.deepEqual(chrome.removed, []);
  });
});
