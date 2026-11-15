/**
 * Cierra las pestañas que los agentes abren en el Chrome del usuario y se
 * quedan paradas (LUI-TSK-0138).
 *
 * La extensión Claude in Chrome agrupa sus pestañas en grupos cuyo título
 * empieza por «Claude». Una pestaña de esos grupos se cierra cuando lleva
 * IDLE_LIMIT_MS sin que el usuario la mire ni el agente navegue en ella.
 * Las pestañas del usuario, la activa y las que suenan no se tocan nunca.
 */

export const AGENT_GROUP_PREFIX = 'Claude';
export const IDLE_LIMIT_MS = 30 * 60 * 1000;
const LOG_SIZE = 100;
const ACTIVITY_PREFIX = 'tab:';

// Cada pestaña guarda su última navegación en su propia clave: dos eventos seguidos no se pisan.
export const activityKey = (tabId) => `${ACTIVITY_PREFIX}${tabId}`;

const readActivity = (stored) => Object.fromEntries(
  Object.entries(stored)
    .filter(([key]) => key.startsWith(ACTIVITY_PREFIX))
    .map(([key, at]) => [key.slice(ACTIVITY_PREFIX.length), at]),
);

const lastSeen = (tab, activity) => Math.max(tab.lastAccessed ?? 0, activity[tab.id] ?? 0);

export function pickIdleAgentTabs({ tabs, groups, activity, now, idleLimitMs = IDLE_LIMIT_MS }) {
  const agentGroups = new Set(
    groups.filter((group) => group.title?.startsWith(AGENT_GROUP_PREFIX)).map((group) => group.id),
  );
  return tabs
    .filter((tab) => agentGroups.has(tab.groupId) && !tab.active && !tab.audible)
    .filter((tab) => lastSeen(tab, activity) > 0 && now - lastSeen(tab, activity) >= idleLimitMs)
    .map((tab) => tab.id);
}

async function snapshot(chrome, now) {
  const [tabs, groups, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    chrome.storage.session.get(null),
  ]);
  return { tabs, groups, idle: pickIdleAgentTabs({ tabs, groups, activity: readActivity(stored), now }) };
}

export async function reapIdleAgentTabs(chrome, now = Date.now()) {
  const first = await snapshot(chrome, now);
  if (first.idle.length === 0) return [];

  // Segunda foto justo antes de cerrar: si entretanto la has abierto o el agente ha navegado, se queda.
  const { tabs, groups, idle: stillIdle } = await snapshot(chrome, now);
  const idle = first.idle.filter((id) => stillIdle.includes(id));
  if (idle.length === 0) return [];

  await chrome.tabs.remove(idle);
  const groupTitle = new Map(groups.map((group) => [group.id, group.title]));
  const at = new Date(now).toISOString();
  const entries = tabs
    .filter((tab) => idle.includes(tab.id))
    .map((tab) => ({ at, tabId: tab.id, group: groupTitle.get(tab.groupId) }));
  const { closedTabs = [] } = await chrome.storage.local.get('closedTabs');
  await chrome.storage.local.set({ closedTabs: [...closedTabs, ...entries].slice(-LOG_SIZE) });
  return idle;
}
