const OPEN_PANEL_ERRORS = new Set([
  "No active browser window.",
  "No tab with id:"
]);

const GMAIL_URL_PREFIX = "https://mail.google.com/";
const GOOGLE_API_BASE = "https://www.googleapis.com";
const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_SYSTEM_LABEL_NAMES = new Set(["INBOX", "SPAM", "TRASH", "UNREAD", "IMPORTANT"]);
const LABEL_CACHE_TTL_MS = 60_000;
const LABEL_DETAIL_CONCURRENCY = 4;

const labelCache = {
  token: "",
  expiresAt: 0,
  value: null,
  inFlight: null
};

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await syncAllTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncAllTabs();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.windowId || !tab?.id || !isGmailTab(tab)) {
    return;
  }

  try {
    await syncTabState(tab);
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    if (!matchesKnownOpenError(error)) {
      console.error("Unable to open side panel", error);
    }
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await safelyGetTab(tabId);

  if (tab) {
    await syncTabState(tab);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!shouldSyncUpdatedTab(changeInfo, tab)) {
    return;
  }

  const resolvedTab = tab?.id ? tab : await safelyGetTab(tabId);

  if (resolvedTab) {
    await syncTabState(resolvedTab);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "gmail-api") {
    handleApiMessage(message)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "gmail-auth") {
    handleAuthMessage(message)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "extension-diagnostics") {
    collectDiagnostics()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type !== "gmail-command") {
    return false;
  }

  proxyToGmail(message.command, message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function handleAuthMessage(message) {
  switch (message?.command) {
    case "getAuthStatus":
      return getAuthStatus();
    case "getApiStatus":
      return getApiStatus();
    case "signIn":
      return signIn();
    case "signOut":
      return signOut();
    default:
      throw new Error(`Unsupported auth command: ${message?.command}`);
  }
}

async function handleApiMessage(message) {
  switch (message?.command) {
    case "getSnapshot":
      return getApiSnapshot();
    case "navigateToLabel":
      return navigateToLabel(message.payload);
    case "createLabel":
      return createApiLabel(message.payload);
    case "renameLabel":
      return renameApiLabel(message.payload);
    case "deleteLabel":
      return deleteApiLabel(message.payload);
    case "createFilter":
      return createApiFilter(message.payload);
    case "deleteFilter":
      return deleteApiFilter(message.payload);
    case "exportConfig":
      return getApiSnapshot();
    case "importConfig":
      return importApiConfig(message.payload);
    default:
      throw new Error(`Unsupported Gmail API command: ${message?.command}`);
  }
}

async function getAuthStatus() {
  const token = await tryGetAuthToken(false);

  if (!token) {
    return {
      signedIn: false,
      email: "",
      extensionId: chrome.runtime.id
    };
  }

  const profile = await fetchGoogleJson("/oauth2/v2/userinfo", token);

  return {
    signedIn: true,
    email: profile.email || "",
    extensionId: chrome.runtime.id
  };
}

async function signIn() {
  const token = await getAuthToken(true);
  const profile = await fetchGoogleJson("/oauth2/v2/userinfo", token);

  return {
    signedIn: true,
    email: profile.email || "",
    extensionId: chrome.runtime.id
  };
}

async function signOut() {
  const token = await tryGetAuthToken(false);

  if (!token) {
    return {
      signedIn: false,
      email: "",
      extensionId: chrome.runtime.id
    };
  }

  await fetch(`${GOOGLE_OAUTH_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  await removeCachedAuthToken(token);

  return {
    signedIn: false,
    email: "",
    extensionId: chrome.runtime.id
  };
}

async function getApiStatus() {
  const token = await tryGetAuthToken(false);

  if (!token) {
    return {
      ok: false,
      signedIn: false,
      email: "",
      labelCount: 0,
      userLabelCount: 0,
      filterCount: 0,
      message: "Not signed in to Google."
    };
  }

  const profile = await fetchGoogleJson("/oauth2/v2/userinfo", token);
  const labels = await fetchLabels(token);
  const filters = await fetchFilters(token, labels);
  const userLabels = labels.filter((label) => label.type === "user");

  return {
    ok: true,
    signedIn: true,
    email: profile.email || "",
    labelCount: labels.length,
    userLabelCount: userLabels.length,
    filterCount: filters.length,
    message: `Gmail API ready. ${userLabels.length} user labels, ${filters.length} filters.`
  };
}

async function getApiSnapshot() {
  const token = await requireAuthToken();
  const labels = await fetchLabels(token);
  const filters = await fetchFilters(token, labels);

  return {
    labels,
    filters,
    exportedAt: new Date().toISOString(),
    sourceUrl: "gmail-api"
  };
}

async function createApiLabel(payload) {
  const name = payload?.name?.trim();

  if (!name) {
    throw new Error("A label name is required.");
  }

  const token = await requireAuthToken();
  const labels = await fetchLabels(token);
  const existing = labels.find((label) => normalizeLabelName(label.name) === normalizeLabelName(name));

  if (!existing) {
    await fetchGoogleJson("/gmail/v1/users/me/labels", token, {
      method: "POST",
      body: JSON.stringify({
        name,
        labelListVisibility: "labelShow",
        messageListVisibility: "show"
      })
    });
  }

  invalidateLabelCache();

  return {
    created: name,
    labels: await fetchLabels(token, { forceRefresh: true })
  };
}

async function renameApiLabel(payload) {
  const currentName = payload?.currentName?.trim();
  const nextName = payload?.nextName?.trim();

  if (!currentName || !nextName) {
    throw new Error("Current and next label names are required.");
  }

  const token = await requireAuthToken();
  const labels = await fetchLabels(token);
  const label = labels.find((candidate) => normalizeLabelName(candidate.name) === normalizeLabelName(currentName));

  if (!label?.id) {
    throw new Error(`Could not find label \"${currentName}\".`);
  }

  const renamePlan = buildLabelRenamePlan(labels, label.name, nextName);
  assertRenamePlanHasNoConflicts(labels, renamePlan);

  for (const entry of renamePlan) {
    await fetchGoogleJson(`/gmail/v1/users/me/labels/${encodeURIComponent(entry.id)}`, token, {
      method: "PATCH",
      body: JSON.stringify({ name: entry.to })
    });
  }

  invalidateLabelCache();
  const refreshedLabels = await fetchLabels(token, { forceRefresh: true });
  const mergedLabels = mergeLabelsWithPreviousCounts(refreshedLabels, labels, renamePlan);

  labelCache.token = token;
  labelCache.value = cloneLabels(mergedLabels);
  labelCache.expiresAt = Date.now() + LABEL_CACHE_TTL_MS;

  return {
    renamed: {
      from: currentName,
      to: nextName,
      count: renamePlan.length
    },
    labels: mergedLabels
  };
}

async function deleteApiLabel(payload) {
  const name = payload?.name?.trim();

  if (!name) {
    throw new Error("A label name is required.");
  }

  const token = await requireAuthToken();
  const labels = await fetchLabels(token);
  const label = labels.find((candidate) => normalizeLabelName(candidate.name) === normalizeLabelName(name));

  if (!label?.id) {
    throw new Error(`Could not find label \"${name}\".`);
  }

  await fetchGoogleJson(`/gmail/v1/users/me/labels/${encodeURIComponent(label.id)}`, token, {
    method: "DELETE"
  });

  invalidateLabelCache();

  return {
    deleted: name,
    labels: await fetchLabels(token, { forceRefresh: true })
  };
}

async function createApiFilter(payload) {
  const token = await requireAuthToken();
  const labels = await fetchLabels(token);
  const labelId = resolveLabelId(payload?.labelName, labels);
  const criteria = buildApiFilterCriteria(payload);
  const action = buildApiFilterAction(payload, labelId);

  if (!Object.keys(criteria).length) {
    throw new Error("At least one filter criterion is required.");
  }

  await fetchGoogleJson("/gmail/v1/users/me/settings/filters", token, {
    method: "POST",
    body: JSON.stringify({ criteria, action })
  });

  return {
    created: summarizeApiFilterParts(criteria, action, labels),
    filters: await fetchFilters(token, labels)
  };
}

async function deleteApiFilter(payload) {
  const filterId = payload?.id?.trim();

  if (!filterId) {
    throw new Error("A filter id is required.");
  }

  const token = await requireAuthToken();
  await fetchGoogleJson(`/gmail/v1/users/me/settings/filters/${encodeURIComponent(filterId)}`, token, {
    method: "DELETE"
  });

  return {
    deleted: filterId,
    filters: await fetchFilters(token)
  };
}

async function importApiConfig(payload) {
  const token = await requireAuthToken();
  const labelsToImport = Array.isArray(payload?.labels) ? payload.labels : [];
  const filtersToImport = Array.isArray(payload?.filters) ? payload.filters : [];
  const results = { labels: [], filters: [] };
  let labels = await fetchLabels(token);

  for (const label of labelsToImport) {
    const name = label?.name?.trim();

    if (!name) {
      continue;
    }

    const exists = labels.some((candidate) => normalizeLabelName(candidate.name) === normalizeLabelName(name));

    if (exists) {
      results.labels.push({ name, status: "skipped" });
      continue;
    }

    try {
      await fetchGoogleJson("/gmail/v1/users/me/labels", token, {
        method: "POST",
        body: JSON.stringify({
          name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show"
        })
      });
      invalidateLabelCache();
      labels = await fetchLabels(token, { forceRefresh: true });
      results.labels.push({ name, status: "created" });
    } catch (error) {
      results.labels.push({ name, status: "failed", error: error.message });
    }
  }

  for (const filter of filtersToImport) {
    try {
      const filterPayload = filter.raw || filter;
      const criteria = buildApiFilterCriteria(filterPayload);
      const action = buildApiFilterAction(filterPayload, resolveLabelId(filterPayload.labelName, labels));
      await fetchGoogleJson("/gmail/v1/users/me/settings/filters", token, {
        method: "POST",
        body: JSON.stringify({ criteria, action })
      });
      results.filters.push({ summary: filter.summary || summarizeApiFilterParts(criteria, action, labels), status: "created" });
    } catch (error) {
      results.filters.push({ summary: filter.summary || "Unnamed filter", status: "failed", error: error.message });
    }
  }

  return results;
}

async function fetchGoogleJson(path, token, options = {}) {
  const method = options.method || "GET";
  const maxRetries = options.maxRetries ?? (method === "GET" ? 2 : 0);
  let attempt = 0;
  let response;

  while (attempt <= maxRetries) {
    response = await fetch(`${GOOGLE_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {})
      },
      body: options.body
    });

    if (response.ok) {
      break;
    }

    if (response.status === 429 && attempt < maxRetries) {
      await wait(getRetryDelayMs(response, attempt));
      attempt += 1;
      continue;
    }

    if (response.status === 401) {
      await removeCachedAuthToken(token);
    }

    const errorText = await response.text();
    throw new Error(`Google API request failed (${response.status}): ${errorText || response.statusText}`);
  }

  const responseText = await response.text();

  if (!responseText.trim()) {
    return {};
  }

  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new Error(`Google API returned invalid JSON for ${path}: ${error.message}`);
  }
}

async function tryGetAuthToken(interactive) {
  try {
    return await getAuthToken(interactive);
  } catch {
    return null;
  }
}

async function requireAuthToken() {
  const token = await tryGetAuthToken(false);

  if (!token) {
    throw new Error("Sign in to Google before using Gmail API actions.");
  }

  return token;
}

async function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!token) {
        reject(new Error("No OAuth token was returned by Chrome identity."));
        return;
      }

      resolve(token);
    });
  });
}

async function removeCachedAuthToken(token) {
  return new Promise((resolve, reject) => {
    chrome.identity.removeCachedAuthToken({ token }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}

async function fetchLabels(token, options = {}) {
  return fetchLabelsWithCache(token, options);
}

async function fetchLabelsWithCache(token, options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const now = Date.now();

  if (!forceRefresh && labelCache.token === token && labelCache.value && labelCache.expiresAt > now) {
    return cloneLabels(labelCache.value);
  }

  if (!forceRefresh && labelCache.token === token && labelCache.inFlight) {
    return labelCache.inFlight;
  }

  labelCache.token = token;
  labelCache.inFlight = fetchLabelsUncached(token)
    .then((labels) => {
      labelCache.value = labels;
      labelCache.expiresAt = Date.now() + LABEL_CACHE_TTL_MS;
      return cloneLabels(labels);
    })
    .finally(() => {
      labelCache.inFlight = null;
    });

  return labelCache.inFlight;
}

async function fetchLabelsUncached(token) {
  const labelsPayload = await fetchGoogleJson("/gmail/v1/users/me/labels", token);
  const userLabels = (labelsPayload?.labels || []).filter((label) => label.type === "user");
  const needsCountHydration = userLabels.some(
    (label) => typeof label.messagesTotal !== "number" || typeof label.messagesUnread !== "number"
  );

  if (!needsCountHydration) {
    return normalizeApiLabels(userLabels);
  }

  const hydratedLabels = await mapWithConcurrency(
    userLabels,
    LABEL_DETAIL_CONCURRENCY,
    async (label) => {
      const details = await fetchGoogleJson(`/gmail/v1/users/me/labels/${encodeURIComponent(label.id)}`, token);
      return {
        ...label,
        ...details
      };
    }
  );

  return normalizeApiLabels(hydratedLabels);
}

async function fetchFilters(token, labels) {
  const effectiveLabels = labels || await fetchLabels(token);
  const filtersPayload = await fetchGoogleJson("/gmail/v1/users/me/settings/filters", token);
  return normalizeApiFilters(filtersPayload?.filter, effectiveLabels);
}

function normalizeApiLabels(labels = []) {
  return labels
    .map((label) => ({
      id: label.id,
      name: label.name,
      type: label.type,
      visible: label.labelListVisibility !== "labelHide",
      messageCount: Number.isFinite(label.messagesTotal)
        ? label.messagesTotal
        : (Number.isFinite(label.threadsTotal) ? label.threadsTotal : 0),
      unreadMessageCount: Number.isFinite(label.messagesUnread)
        ? label.messagesUnread
        : (Number.isFinite(label.threadsUnread) ? label.threadsUnread : 0)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeApiFilters(filters = [], labels = []) {
  return filters
    .map((filter) => normalizeApiFilter(filter, labels))
    .sort((left, right) => left.summary.localeCompare(right.summary));
}

function normalizeApiFilter(filter, labels = []) {
  const summary = summarizeApiFilterParts(filter.criteria || {}, filter.action || {}, labels);

  return {
    id: filter.id,
    summary,
    actions: describeApiFilterActions(filter.action || {}, labels),
    raw: hydrateFilterFromApi(filter, labels)
  };
}

function hydrateFilterFromApi(filter, labels) {
  const criteria = filter.criteria || {};
  const action = filter.action || {};
  const labelNames = getUserLabelNames(action.addLabelIds || [], labels);

  return {
    from: criteria.from || "",
    to: criteria.to || "",
    subject: criteria.subject || "",
    hasWords: criteria.query || "",
    doesNotHave: criteria.negatedQuery || "",
    hasAttachment: Boolean(criteria.hasAttachment),
    excludeChats: Boolean(criteria.excludeChats),
    labelName: labelNames[0] || "",
    archive: (action.removeLabelIds || []).includes("INBOX"),
    neverSpam: (action.removeLabelIds || []).includes("SPAM"),
    markRead: (action.removeLabelIds || []).includes("UNREAD"),
    important: (action.addLabelIds || []).includes("IMPORTANT")
  };
}

function summarizeApiFilterParts(criteria, action, labels) {
  const criteriaParts = [];

  if (criteria.from) {
    criteriaParts.push(`from:${criteria.from}`);
  }

  if (criteria.to) {
    criteriaParts.push(`to:${criteria.to}`);
  }

  if (criteria.subject) {
    criteriaParts.push(`subject:${criteria.subject}`);
  }

  if (criteria.query) {
    criteriaParts.push(`has:${criteria.query}`);
  }

  if (criteria.negatedQuery) {
    criteriaParts.push(`not:${criteria.negatedQuery}`);
  }

  if (criteria.hasAttachment) {
    criteriaParts.push("attachment");
  }

  if (criteria.excludeChats) {
    criteriaParts.push("excludeChats");
  }

  return [...criteriaParts, ...describeApiFilterActions(action, labels)].join(" | ") || "Unnamed filter";
}

function describeApiFilterActions(action, labels) {
  const actions = [];
  const addLabelIds = action.addLabelIds || [];
  const removeLabelIds = action.removeLabelIds || [];
  const labelNames = getUserLabelNames(addLabelIds, labels);

  if (labelNames.length) {
    actions.push(`Apply label ${labelNames.join(", ")}`);
  }

  if (removeLabelIds.includes("INBOX")) {
    actions.push("Skip Inbox");
  }

  if (removeLabelIds.includes("SPAM")) {
    actions.push("Never spam");
  }

  if (removeLabelIds.includes("UNREAD")) {
    actions.push("Mark read");
  }

  if (addLabelIds.includes("IMPORTANT")) {
    actions.push("Mark important");
  }

  return actions;
}

function getUserLabelNames(labelIds, labels) {
  const labelMap = new Map((labels || []).map((label) => [label.id, label.name]));

  return (labelIds || [])
    .filter((labelId) => !GMAIL_SYSTEM_LABEL_NAMES.has(labelId))
    .map((labelId) => labelMap.get(labelId))
    .filter(Boolean);
}

function buildApiFilterCriteria(payload = {}) {
  const criteria = {};

  if (payload.from) {
    criteria.from = payload.from.trim();
  }

  if (payload.to) {
    criteria.to = payload.to.trim();
  }

  if (payload.subject) {
    criteria.subject = payload.subject.trim();
  }

  if (payload.hasWords) {
    criteria.query = payload.hasWords.trim();
  }

  if (payload.doesNotHave) {
    criteria.negatedQuery = payload.doesNotHave.trim();
  }

  if (payload.hasAttachment) {
    criteria.hasAttachment = true;
  }

  if (payload.excludeChats) {
    criteria.excludeChats = true;
  }

  return criteria;
}

function buildApiFilterAction(payload = {}, labelId = "") {
  const addLabelIds = [];
  const removeLabelIds = [];

  if (labelId) {
    addLabelIds.push(labelId);
  }

  if (payload.archive) {
    removeLabelIds.push("INBOX");
  }

  if (payload.neverSpam) {
    removeLabelIds.push("SPAM");
  }

  if (payload.markRead) {
    removeLabelIds.push("UNREAD");
  }

  if (payload.important) {
    addLabelIds.push("IMPORTANT");
  }

  return {
    ...(addLabelIds.length ? { addLabelIds } : {}),
    ...(removeLabelIds.length ? { removeLabelIds } : {})
  };
}

function resolveLabelId(labelName, labels) {
  if (!labelName) {
    return "";
  }

  const label = (labels || []).find((candidate) => normalizeLabelName(candidate.name) === normalizeLabelName(labelName));

  if (!label?.id) {
    throw new Error(`Could not find label \"${labelName}\" in Gmail.`);
  }

  return label.id;
}

function normalizeLabelName(value) {
  return String(value || "").trim().toLowerCase();
}

function buildLabelRenamePlan(labels, currentName, nextName) {
  const subtree = (labels || [])
    .filter((candidate) => isSameLabelOrDescendant(candidate.name, currentName))
    .sort((left, right) => left.name.length - right.name.length);

  return subtree.map((candidate) => ({
    id: candidate.id,
    from: candidate.name,
    to: renameLabelPath(candidate.name, currentName, nextName)
  }));
}

function assertRenamePlanHasNoConflicts(labels, renamePlan) {
  const subtreeNames = new Set(renamePlan.map((entry) => normalizeLabelName(entry.from)));
  const outsideNames = new Set(
    (labels || [])
      .map((label) => label.name)
      .filter((name) => !subtreeNames.has(normalizeLabelName(name)))
      .map((name) => normalizeLabelName(name))
  );
  const targetNames = renamePlan.map((entry) => normalizeLabelName(entry.to));
  const uniqueTargetNames = new Set(targetNames);

  if (uniqueTargetNames.size !== targetNames.length) {
    throw new Error("Renaming this label branch would create duplicate label names.");
  }

  const conflictingTarget = targetNames.find((name) => outsideNames.has(name));

  if (conflictingTarget) {
    throw new Error(`Renaming this label branch would conflict with an existing label: \"${conflictingTarget}\".`);
  }
}

function isSameLabelOrDescendant(candidateName, rootName) {
  return candidateName === rootName || candidateName.startsWith(`${rootName}/`);
}

function renameLabelPath(candidateName, currentName, nextName) {
  if (candidateName === currentName) {
    return nextName;
  }

  const suffix = candidateName.slice(currentName.length + 1);
  return `${nextName}/${suffix}`;
}

function mergeLabelsWithPreviousCounts(refreshedLabels, previousLabels, renamePlan = []) {
  const previousById = new Map((previousLabels || []).map((label) => [label.id, label]));
  const renameById = new Map(renamePlan.map((entry) => [entry.id, entry]));

  return (refreshedLabels || []).map((label) => {
    const previous = previousById.get(label.id);
    const rename = renameById.get(label.id);

    return {
      ...label,
      name: rename?.to || label.name,
      messageCount: resolveLabelCount(label.messageCount, previous?.messageCount),
      unreadMessageCount: resolveLabelCount(label.unreadMessageCount, previous?.unreadMessageCount)
    };
  });
}

function resolveLabelCount(nextCount, fallbackCount) {
  if (Number.isFinite(nextCount) && nextCount > 0) {
    return nextCount;
  }

  if (Number.isFinite(fallbackCount)) {
    return fallbackCount;
  }

  return Number.isFinite(nextCount) ? nextCount : 0;
}

function invalidateLabelCache() {
  labelCache.token = "";
  labelCache.expiresAt = 0;
  labelCache.value = null;
  labelCache.inFlight = null;
}

function cloneLabels(labels = []) {
  return labels.map((label) => ({ ...label }));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function getRetryDelayMs(response, attempt) {
  const retryAfterHeader = response.headers.get("Retry-After");
  const retryAfterSeconds = Number(retryAfterHeader);

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  return 400 * (attempt + 1);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function navigateToLabel(payload) {
  const labelName = payload?.name?.trim();

  if (!labelName) {
    throw new Error("A label name is required.");
  }

  const tab = await getTargetGmailTab();

  if (!tab?.id) {
    throw new Error("Open Gmail in a tab before using the extension.");
  }

  const destinationUrl = buildGmailLabelUrl(tab.url, labelName);
  await chrome.tabs.update(tab.id, { url: destinationUrl, active: true });

  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  return {
    labelName,
    url: destinationUrl
  };
}

async function getTargetGmailTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true, url: ["https://mail.google.com/*"] });

  if (activeTab) {
    return activeTab;
  }

  const [gmailTab] = await chrome.tabs.query({ url: ["https://mail.google.com/*"] });
  return gmailTab || null;
}

function buildGmailLabelUrl(currentUrl, labelName) {
  const url = new URL(currentUrl || `${GMAIL_URL_PREFIX}mail/u/0/`);
  const basePath = url.pathname && url.pathname !== "/" ? url.pathname : "/mail/u/0/";
  url.pathname = basePath.endsWith("/") ? basePath : `${basePath}/`;
  url.hash = `#label/${encodeURIComponent(labelName)}`;
  url.search = "";
  return url.toString();
}

async function collectDiagnostics() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const gmailTabs = await chrome.tabs.query({ url: ["https://mail.google.com/*"] });
  const targetTab = await getTargetGmailTab();
  const ping = await pingGmailTab(targetTab);

  return {
    generatedAt: new Date().toISOString(),
    activeTab: summarizeTab(activeTab),
    targetTab: summarizeTab(targetTab),
    gmailTabCount: gmailTabs.length,
    ping,
    summary: buildDiagnosticSummary(activeTab, targetTab, ping)
  };
}

async function pingGmailTab(tab) {
  if (!tab?.id) {
    return {
      ok: false,
      error: "No Gmail tab was found. Open mail.google.com in Chrome first."
    };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "gmail-command",
      command: "ping",
      payload: {}
    });

    if (!response?.ok) {
      return {
        ok: false,
        error: response?.error || "The Gmail content script responded with an error."
      };
    }

    return {
      ok: true,
      title: response.result?.title || "Gmail",
      url: response.result?.url || tab.url || ""
    };
  } catch (error) {
    return {
      ok: false,
      error: normalizeDiagnosticError(error)
    };
  }
}

function summarizeTab(tab) {
  if (!tab?.id) {
    return null;
  }

  return {
    id: tab.id,
    title: tab.title || "",
    url: tab.url || "",
    isGmail: isGmailTab(tab),
    active: Boolean(tab.active)
  };
}

function buildDiagnosticSummary(activeTab, targetTab, ping) {
  if (!isGmailTab(activeTab)) {
    return "Active tab is not Gmail. Switch to mail.google.com and reload that tab after extension changes.";
  }

  if (!targetTab?.id) {
    return "No Gmail tab was found. Open mail.google.com and try again.";
  }

  if (!ping.ok) {
    return ping.error;
  }

  return `Connected to Gmail tab ${targetTab.id}: ${ping.title}`;
}

function normalizeDiagnosticError(error) {
  const message = error?.message || String(error || "Unknown error");

  if (message.includes("Receiving end does not exist")) {
    return "Gmail tab found, but the content script is not connected. Reload the extension, then refresh the Gmail tab.";
  }

  return message;
}

async function syncAllTabs() {
  const tabs = await chrome.tabs.query({});

  await Promise.all(tabs.map((tab) => syncTabState(tab)));
}

async function syncTabState(tab) {
  if (!tab?.id) {
    return;
  }

  const enabled = isGmailTab(tab);

  await chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: "src/sidepanel/sidepanel.html",
    enabled
  });

  if (enabled) {
    await chrome.action.enable(tab.id);
    await chrome.action.setTitle({ tabId: tab.id, title: "Open Gmail Filter Manager" });
    return;
  }

  await chrome.action.disable(tab.id);
  await chrome.action.setTitle({
    tabId: tab.id,
    title: "Gmail Filter Manager is available only on mail.google.com"
  });
}

function shouldSyncUpdatedTab(changeInfo, tab) {
  return Boolean(changeInfo.url || changeInfo.status === "complete" || tab?.url);
}

function isGmailTab(tab) {
  return isGmailUrl(tab?.url);
}

function isGmailUrl(url) {
  return typeof url === "string" && url.startsWith(GMAIL_URL_PREFIX);
}

async function safelyGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
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
