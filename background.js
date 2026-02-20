const DEFAULT_SETTINGS = {
  enabled: true,
  lastInjectedContext: "",
  lastInjectedAt: "",
  lastInjectedSite: ""
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    const nextSettings = {
      ...DEFAULT_SETTINGS,
      ...stored
    };
    chrome.storage.sync.set(nextSettings);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TIMECONTEXT_GET_STATUS") {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
      sendResponse({
        ok: true,
        settings: {
          ...DEFAULT_SETTINGS,
          ...stored
        }
      });
    });
    return true;
  }

  return false;
});
