const $ = id => document.getElementById(id);
const viewer = chrome.runtime.getURL('viewer.html');
(async () => { await i18n.load(); i18n.apply(); $('lang').value = i18n.lang; })();
$('lang').onchange = async e => { await i18n.save(e.target.value); i18n.apply(); chrome.runtime.sendMessage({ type: 'langChanged' }); };
chrome.runtime.sendMessage({ type: 'getIntercept' }, r => { $('intercept').checked = !!(r && r.enabled); });
$('intercept').onchange = e => chrome.runtime.sendMessage({ type: 'setIntercept', enabled: e.target.checked });
$('openViewer').onclick = () => chrome.tabs.create({ url: viewer });
$('openCurrent').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url || '';
  if (!/^(https?|file):/.test(url)) { chrome.tabs.create({ url: viewer }); return; }
  chrome.tabs.update(tab.id, { url: viewer + '?file=' + encodeURIComponent(url) });
};
