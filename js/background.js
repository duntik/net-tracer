// Schematic Net Tracer — service worker: .pdf interception (toggle), context menus, one-shot bypass.
const RULE_ID = 1;
const viewerUrl = (url) => chrome.runtime.getURL('viewer.html') + '?file=' + encodeURIComponent(url);

async function setIntercept(enabled) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map(r => r.id) });
  if (enabled) {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{
      id: RULE_ID, priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: chrome.runtime.getURL('viewer.html') + '#\\0' } },
      condition: { regexFilter: '^https?://.+\\.pdf(\\?.*)?$', isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame'] }
    }]});
  }
}
async function getIntercept() { const { intercept } = await chrome.storage.local.get({ intercept: true }); return intercept; }

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({ id: 'nt-link', title: 'Открыть ссылку в Net Tracer', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'nt-page', title: 'Открыть эту страницу (PDF) в Net Tracer', contexts: ['page', 'frame'] });
  await setIntercept(await getIntercept());
});
chrome.runtime.onStartup.addListener(async () => setIntercept(await getIntercept()));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'nt-link' ? info.linkUrl : (info.frameUrl || info.pageUrl);
  if (url) chrome.tabs.create({ url: viewerUrl(url), index: tab ? tab.index + 1 : undefined });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'setIntercept') { await chrome.storage.local.set({ intercept: !!msg.enabled }); await setIntercept(!!msg.enabled); sendResponse({ ok: true }); }
    else if (msg.type === 'getIntercept') { sendResponse({ enabled: await getIntercept() }); }
    else if (msg.type === 'openNative') { // one-shot bypass: lift the redirect, navigate, restore
      await setIntercept(false);
      await chrome.tabs.update(sender.tab.id, { url: msg.url });
      setTimeout(async () => setIntercept(await getIntercept()), 4000);
      sendResponse({ ok: true });
    }
  })();
  return true;
});
