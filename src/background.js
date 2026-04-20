const OPEN_PANEL_ERRORS = new Set([
  "No active browser window.",
  "No tab with id:"
]);

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.windowId) {
    return;
  }

  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    if (!matchesKnownOpenError(error)) {
      console.error("Unable to open side panel", error);
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "gmail-command") {
    return false;
  }

  proxyToGmail(message.command, message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function proxyToGmail(command, payload = {}) {
  const tab = await getTargetGmailTab();

  if (!tab?.id) {
    throw new Error("Open Gmail in a tab before using the extension.");
  }

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "gmail-command",
    command,
    payload
  });

  if (!response?.ok) {
    throw new Error(response?.error || "The Gmail content script did not complete the request.");
  }

  return response.result;
}

async function getTargetGmailTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true, url: ["https://mail.google.com/*"] });

  if (activeTab) {
    return activeTab;
  }

  const [gmailTab] = await chrome.tabs.query({ url: ["https://mail.google.com/*"] });
  return gmailTab || null;
}

function matchesKnownOpenError(error) {
  if (!error?.message) {
    return false;
  }

  for (const fragment of OPEN_PANEL_ERRORS) {
    if (error.message.includes(fragment)) {
      return true;
    }
  }

  return false;
}
