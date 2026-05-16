// Bridge service worker — currently no background tasks.
chrome.runtime.onInstalled.addListener(() => {
  console.log('[bridge] service worker installed');
});
