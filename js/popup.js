const $ = id => document.getElementById(id);
const viewer = chrome.runtime.getURL('viewer.html');
chrome.runtime.sendMessage({ type: 'getIntercept' }, r => { $('intercept').checked = !!(r && r.enabled); });
$('intercept').onchange = e => chrome.runtime.sendMessage({ type: 'setIntercept', enabled: e.target.checked });
$('openViewer').onclick = () => chrome.tabs.create({ url: viewer });
$('openCurrent').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url || '';
  if (!/^(https?|file):/.test(url)) { chrome.tabs.create({ url: viewer }); return; }
  chrome.tabs.update(tab.id, { url: viewer + '?file=' + encodeURIComponent(url) });
};
