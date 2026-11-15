// Service worker: apunta cuándo navega cada pestaña y cada 5 minutos cierra las de agentes paradas.
import { activityKey, reapIdleAgentTabs } from './tab-reaper.js';

const ALARM = 'reap-idle-agent-tabs';

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 5 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 5 }));

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status) chrome.storage.session.set({ [activityKey(tabId)]: Date.now() });
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(activityKey(tabId)));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const closed = await reapIdleAgentTabs(chrome);
  if (closed.length > 0) console.info(`Cerradas ${closed.length} pestañas de agentes paradas`, closed);
});
