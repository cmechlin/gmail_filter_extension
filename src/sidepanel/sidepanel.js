const storageKeys = {
  draftFilter: "draftFilter",
  draftLabel: "draftLabel",
  lastSnapshot: "lastSnapshot"
};

const state = {
  labels: [],
  filters: [],
  loading: false,
  diagnostics: null,
  auth: null,
  apiStatus: null,
  collapsedLabelBranches: new Set(),
  initializedLabelBranches: new Set()
};

const elements = {
  loadingOverlay: document.querySelector("#loadingOverlay"),
  loadingMessage: document.querySelector("#loadingMessage"),
  statusBanner: document.querySelector("#statusBanner"),
  authStatus: document.querySelector("#authStatus"),
  authMeta: document.querySelector("#authMeta"),
  diagnosticsMeta: document.querySelector("#diagnosticsMeta"),
  diagnosticsList: document.querySelector("#diagnosticsList"),
  snapshotMeta: document.querySelector("#snapshotMeta"),
  labelCount: document.querySelector("#labelCount"),
  filterCount: document.querySelector("#filterCount"),
  labelsList: document.querySelector("#labelsList"),
  filtersList: document.querySelector("#filtersList"),
  signInButton: document.querySelector("#signInButton"),
  signOutButton: document.querySelector("#signOutButton"),
  exportButton: document.querySelector("#exportButton"),
  importButton: document.querySelector("#importButton"),
  importInput: document.querySelector("#importInput"),
  createLabelForm: document.querySelector("#createLabelForm"),
  createFilterForm: document.querySelector("#createFilterForm"),
  emptyStateTemplate: document.querySelector("#emptyStateTemplate")
};

bootstrap().catch((error) => setStatus(error.message, "error"));

async function bootstrap() {
  bindEvents();
  await restoreDrafts();
  await refreshAuthStatus();
  await initializePanel();
}

function bindEvents() {
  elements.signInButton.addEventListener("click", () => handleSignIn());
  elements.signOutButton.addEventListener("click", () => handleSignOut());
  elements.exportButton.addEventListener("click", () => exportSnapshot());
  elements.importButton.addEventListener("click", () => elements.importInput.click());
  elements.importInput.addEventListener("change", handleImportFile);
  elements.createLabelForm.addEventListener("submit", handleCreateLabel);
  elements.createFilterForm.addEventListener("submit", handleCreateFilter);
  elements.createLabelForm.addEventListener("input", persistDrafts);
  elements.createFilterForm.addEventListener("input", persistDrafts);
  elements.labelsList.addEventListener("click", handleLabelsListClick);
  elements.labelsList.addEventListener("dblclick", handleLabelsListDoubleClick);
  elements.labelsList.addEventListener("keydown", handleLabelsListKeydown);
  elements.labelsList.addEventListener("focusout", handleLabelsListFocusOut);
  elements.filtersList.addEventListener("click", handleFiltersListClick);
}

async function handleSignIn() {
  await withLoading(async () => {
    setStatus("Signing in to Google…");
    const auth = await sendAuthCommand("signIn");
    state.auth = auth;
    renderAuthStatus(auth);
    const snapshot = await loadSnapshot();
    syncApiStatusFromSnapshot(snapshot);
    setStatus(`Signed in as ${auth.email || "Google user"}.`, "success");
  });
}

async function handleSignOut() {
  await withLoading(async () => {
    setStatus("Signing out of Google…");
    const auth = await sendAuthCommand("signOut");
    state.auth = auth;
    state.apiStatus = null;
    clearSnapshot();
    await chrome.storage.local.remove(storageKeys.lastSnapshot);
    renderAuthStatus(auth);
    setStatus("Signed out of Google.", "success");
  });
}

async function initializePanel() {
  await withLoading(async () => {
    await updateDiagnostics();
    if (!state.auth?.signedIn) {
      clearSnapshot();
      renderAuthStatus(state.auth);
      setStatus("Sign in to Google to load Gmail labels and filters.");
      return;
    }

    const snapshot = await loadSnapshot();
    syncApiStatusFromSnapshot(snapshot);
    setStatus("Gmail state refreshed from Gmail API.", "success");
  });
}

async function exportSnapshot() {
  await withLoading(async () => {
    setStatus("Exporting configuration…");
    const snapshot = await sendApiCommand("exportConfig");
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    try {
      await chrome.downloads.download({
        url,
        filename: `gmail-filter-manager-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        saveAs: true
      });
    } finally {
      URL.revokeObjectURL(url);
    }

    setStatus("Export complete.", "success");
  });
}

async function handleImportFile(event) {
  const [file] = event.target.files || [];

  if (!file) {
    return;
  }

  await withLoading(async () => {
    const payload = JSON.parse(await file.text());
    setStatus("Importing configuration into Gmail…");
    const result = await sendApiCommand("importConfig", payload);
    await reloadSnapshotAfterMutation();
    const createdLabels = result.labels.filter((item) => item.status === "created").length;
    const skippedLabels = result.labels.filter((item) => item.status === "skipped").length;
    const failedLabels = result.labels.filter((item) => item.status === "failed").length;
    const createdFilters = result.filters.filter((item) => item.status === "created").length;
    const skippedFilters = result.filters.filter((item) => item.status === "skipped").length;
    const failedFilters = result.filters.filter((item) => item.status === "failed").length;
    const tone = failedLabels || failedFilters ? "error" : "success";
    setStatus(`Import finished. Labels: ${createdLabels} created, ${skippedLabels} skipped, ${failedLabels} failed. Filters: ${createdFilters} created, ${skippedFilters} skipped, ${failedFilters} failed.`, tone);
  });

  event.target.value = "";
}

async function handleCreateLabel(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = formToObject(form);

  await withLoading(async () => {
    await sendApiCommand("createLabel", payload);
    form.reset();
    await persistDrafts();
    await reloadSnapshotAfterMutation();
    setStatus(`Label created: ${payload.name}`, "success");
  });
}

async function handleCreateFilter(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = formToObject(form);
  payload.neverSpam = true;

  await withLoading(async () => {
    await sendApiCommand("createFilter", payload);
    form.reset();
    form.elements.archive.checked = true;
    await persistDrafts();
    await reloadSnapshotAfterMutation();
    setStatus("Filter created.", "success");
  });
}

async function handleLabelsListClick(event) {
  const branchToggle = event.target.closest("[data-label-trigger='branch']");

  if (branchToggle) {
    toggleLabelBranch(branchToggle.closest("[data-label-node]"));
    return;
  }

  const renameTrigger = event.target.closest("[data-label-trigger='rename']");

  if (renameTrigger) {
    startInlineLabelRename(renameTrigger.closest("[data-label-node]"));
    return;
  }

  const button = event.target.closest("button[data-action]");

  if (!button) {
    return;
  }

  const name = button.dataset.name;
  const action = button.dataset.action;

  if (!name || !action) {
    return;
  }

  if (action === "delete") {
    const confirmed = window.confirm(`Delete label \"${name}\" in Gmail?`);

    if (!confirmed) {
      return;
    }

    await withLoading(async () => {
      await sendApiCommand("deleteLabel", { name });
      await reloadSnapshotAfterMutation();
      setStatus(`Label deleted: ${name}.`, "success");
    });
  }
}

async function handleLabelsListDoubleClick(event) {
  if (
    event.target.closest("[data-label-trigger='rename']") ||
    event.target.closest("button[data-action]") ||
    event.target.closest("input[data-label-editor='true']")
  ) {
    return;
  }

  const row = event.target.closest(".label-node.is-label");

  if (!row) {
    return;
  }

  const labelName = row.dataset.labelName;

  if (!labelName) {
    return;
  }

  await withLoading(async () => {
    await sendApiCommand("navigateToLabel", { name: labelName });
    setStatus(`Opened Gmail label: ${labelName}`, "success");
  });
}

function handleLabelsListKeydown(event) {
  const input = event.target.closest("input[data-label-editor='true']");

  if (!input) {
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    void commitInlineLabelRename(input);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    cancelInlineLabelRename(input);
  }
}

function handleLabelsListFocusOut(event) {
  const input = event.target.closest("input[data-label-editor='true']");

  if (!input || input.dataset.cancelled === "true") {
    return;
  }

  if (event.relatedTarget === input) {
    return;
  }

  void commitInlineLabelRename(input);
}

async function handleFiltersListClick(event) {
  const button = event.target.closest("button[data-action='delete-filter']");

  if (!button) {
    return;
  }

  const summary = button.dataset.summary;
  const id = button.dataset.id;
  const confirmed = window.confirm("Delete this Gmail filter?");

  if (!confirmed) {
    return;
  }

  await withLoading(async () => {
    await sendApiCommand("deleteFilter", { id, summary });
    await reloadSnapshotAfterMutation();
    setStatus("Filter deleted.", "success");
  });
}

function render(snapshot) {
  elements.labelCount.textContent = String(snapshot.labels?.length || 0);
  elements.filterCount.textContent = String(snapshot.filters?.length || 0);
  elements.snapshotMeta.textContent = snapshot.exportedAt
    ? `Last sync ${new Date(snapshot.exportedAt).toLocaleString()}`
    : "No snapshot yet";

  renderLabels(snapshot.labels || []);
  renderFilters(snapshot.filters || []);
}

function renderLabels(labels) {
  elements.labelsList.replaceChildren();

  if (!labels.length) {
    elements.labelsList.appendChild(elements.emptyStateTemplate.content.firstElementChild.cloneNode(true));
    return;
  }

  const tree = buildLabelTree(labels);
  elements.labelsList.appendChild(renderLabelTreeLevel(tree));
}

function renderFilters(filters) {
  elements.filtersList.replaceChildren();

  if (!filters.length) {
    elements.filtersList.appendChild(elements.emptyStateTemplate.content.firstElementChild.cloneNode(true));
    return;
  }

  filters.forEach((filter) => {
    const item = document.createElement("article");
    item.className = "item";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(filter.summary || "Unnamed filter")}</strong>
        <p>${escapeHtml((filter.actions || []).join(" • ") || "No parsed actions")}</p>
      </div>
      <div class="item-actions">
        <button class="pill danger" data-action="delete-filter" data-id="${escapeAttribute(filter.id)}" data-summary="${escapeAttribute(filter.summary || "")}">Delete</button>
      </div>
    `;
    elements.filtersList.appendChild(item);
  });
}

async function restoreDrafts() {
  const stored = await chrome.storage.local.get(Object.values(storageKeys));
  fillForm(elements.createLabelForm, stored[storageKeys.draftLabel]);
  fillForm(elements.createFilterForm, stored[storageKeys.draftFilter]);

  if (stored[storageKeys.lastSnapshot]) {
    render(stored[storageKeys.lastSnapshot]);
  }
}

async function updateDiagnostics() {
  const diagnostics = await requestDiagnostics();
  state.diagnostics = diagnostics;
  renderDiagnostics(diagnostics);
  return diagnostics;
}

async function refreshAuthStatus() {
  const auth = await sendAuthCommand("getAuthStatus");
  state.auth = auth;
  renderAuthStatus(auth);
  return auth;
}

async function requestDiagnostics() {
  const response = await chrome.runtime.sendMessage({ type: "extension-diagnostics" });

  if (!response?.ok) {
    throw new Error(response?.error || "The extension diagnostics request failed.");
  }

  return response.result;
}

async function sendAuthCommand(command) {
  const response = await chrome.runtime.sendMessage({
    type: "gmail-auth",
    command
  });

  if (!response?.ok) {
    throw new Error(response?.error || "The Google auth request failed.");
  }

  return response.result;
}

async function sendApiCommand(command, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    type: "gmail-api",
    command,
    payload
  });

  if (!response?.ok) {
    throw new Error(response?.error || "The Gmail API request failed.");
  }

  return response.result;
}

async function loadSnapshot() {
  setStatus("Reading Gmail…");
  const snapshot = await sendApiCommand("getSnapshot");
  await applySnapshot(snapshot);
  return snapshot;
}

async function reloadSnapshotAfterMutation() {
  const snapshot = await loadSnapshot();
  syncApiStatusFromSnapshot(snapshot);
}

async function applySnapshot(snapshot, overrides = {}) {
  const nextSnapshot = {
    ...snapshot,
    ...overrides,
    labels: overrides.labels || snapshot.labels || [],
    filters: overrides.filters || snapshot.filters || []
  };

  state.labels = nextSnapshot.labels;
  state.filters = nextSnapshot.filters;
  await chrome.storage.local.set({ [storageKeys.lastSnapshot]: nextSnapshot });
  render(nextSnapshot);
  return nextSnapshot;
}

async function reloadSnapshotAfterLabelRename(labels) {
  setStatus("Reading Gmail…");
  const snapshot = await sendApiCommand("getSnapshot");
  const mergedSnapshot = await applySnapshot(snapshot, { labels });
  syncApiStatusFromSnapshot(mergedSnapshot);
  return mergedSnapshot;
}

function clearSnapshot() {
  state.labels = [];
  state.filters = [];
  render({ labels: [], filters: [], exportedAt: "" });
}

function syncApiStatusFromSnapshot(snapshot) {
  state.apiStatus = {
    ok: true,
    signedIn: Boolean(state.auth?.signedIn),
    email: state.auth?.email || "",
    labelCount: snapshot.labels?.length || 0,
    userLabelCount: snapshot.labels?.length || 0,
    filterCount: snapshot.filters?.length || 0,
    message: "Gmail API ready."
  };
  renderAuthStatus(state.auth);
}

function renderDiagnostics(diagnostics) {
  elements.diagnosticsMeta.textContent = diagnostics?.generatedAt
    ? `Last check ${new Date(diagnostics.generatedAt).toLocaleString()}`
    : "Not checked yet";

  elements.diagnosticsList.replaceChildren();

  const rows = [
    {
      label: "Active tab",
      tone: diagnostics?.activeTab?.isGmail ? "success" : "error",
      details: [
        diagnostics?.activeTab?.title || "No active tab detected",
        diagnostics?.activeTab?.url || ""
      ]
    },
    {
      label: "Target Gmail tab",
      tone: diagnostics?.targetTab ? "success" : "error",
      details: [
        diagnostics?.targetTab?.title || "No Gmail tab selected",
        diagnostics?.targetTab?.url || ""
      ]
    },
    {
      label: "Content script ping",
      tone: diagnostics?.ping?.ok ? "success" : "error",
      details: [
        diagnostics?.ping?.ok ? `Connected: ${diagnostics.ping.title}` : diagnostics?.ping?.error || "No ping result",
        diagnostics?.summary || ""
      ]
    },
    {
      label: "Open Gmail tabs",
      tone: diagnostics?.gmailTabCount ? "success" : "error",
      details: [String(diagnostics?.gmailTabCount || 0)]
    }
  ];

  rows.forEach((row) => {
    const item = document.createElement("article");
    item.className = "item";

    const detailLines = row.details
      .filter(Boolean)
      .map((detail) => `<p>${escapeHtml(detail)}</p>`)
      .join("");

    item.innerHTML = `
      <div>
        <strong data-tone="${row.tone}">${escapeHtml(row.label)}</strong>
        ${detailLines}
      </div>
    `;

    elements.diagnosticsList.appendChild(item);
  });
}

async function persistDrafts() {
  await chrome.storage.local.set({
    [storageKeys.draftLabel]: formToObject(elements.createLabelForm),
    [storageKeys.draftFilter]: formToObject(elements.createFilterForm)
  });
}

async function withLoading(work) {
  if (state.loading) {
    return;
  }

  state.loading = true;
  renderLoadingState(true);
  setControlsDisabled(true);

  try {
    await work();
  } catch (error) {
    setStatus(error.message, "error");
    throw error;
  } finally {
    state.loading = false;
    renderLoadingState(false);
    setControlsDisabled(false);
  }
}

function setControlsDisabled(disabled) {
  document.querySelectorAll("button, input, textarea").forEach((control) => {
    if (control.id === "importInput") {
      return;
    }

    control.disabled = disabled;
  });
}

function setStatus(message, tone = "neutral") {
  elements.statusBanner.textContent = message;
  elements.statusBanner.dataset.tone = tone;

  if (state.loading) {
    elements.loadingMessage.textContent = message || "Working…";
  }
}

function renderLoadingState(isBusy) {
  elements.loadingOverlay.hidden = !isBusy;
  elements.loadingMessage.textContent = elements.statusBanner.textContent || "Working…";
  document.body.classList.toggle("is-busy", isBusy);
}

function fillForm(form, values = {}) {
  if (!form || !values) {
    return;
  }

  [...form.elements].forEach((field) => {
    if (!field.name || !(field.name in values)) {
      return;
    }

    if (field.type === "checkbox") {
      field.checked = Boolean(values[field.name]);
      return;
    }

    field.value = values[field.name];
  });
}

function formToObject(form) {
  const formData = new FormData(form);
  const object = {};

  [...form.elements].forEach((field) => {
    if (!field.name) {
      return;
    }

    if (field.type === "checkbox") {
      object[field.name] = field.checked;
      return;
    }

    object[field.name] = String(formData.get(field.name) || "").trim();
  });

  return object;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function buildLabelTree(labels) {
  const root = [];
  const index = new Map();

  labels
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
    .forEach((label) => {
      const parts = label.name.split("/").map((part) => part.trim()).filter(Boolean);
      let branch = root;
      let path = "";

      parts.forEach((part, partIndex) => {
        path = path ? `${path}/${part}` : part;
        const key = path.toLowerCase();
        let node = index.get(key);

        if (!node) {
          node = {
            key,
            segment: part,
            fullName: path,
            label: null,
            children: []
          };
          index.set(key, node);
          branch.push(node);
        }

        if (partIndex === parts.length - 1) {
          node.label = label;
        }

        branch = node.children;
      });
    });

  annotateNestedLabelCounts(root);
  return root;
}

function annotateNestedLabelCounts(nodes) {
  nodes.forEach((node) => {
    annotateNestedLabelCount(node);
  });
}

function annotateNestedLabelCount(node) {
  let descendantMessageCount = 0;

  node.children.forEach((child) => {
    annotateNestedLabelCount(child);
    const childOwnCount = Number.isFinite(Number(child.label?.messageCount)) ? Number(child.label.messageCount) : 0;
    descendantMessageCount += childOwnCount + (child.nestedMessageCount || 0);
  });

  node.nestedMessageCount = descendantMessageCount;
}

function renderLabelTreeLevel(nodes, depth = 0) {
  const container = document.createElement("div");
  container.className = depth === 0 ? "label-tree" : "label-children";

  nodes.forEach((node) => {
    const branch = document.createElement("div");
    branch.className = "label-branch";

    const row = document.createElement("article");
    row.className = `label-node${node.label ? " is-label" : " is-branch"}`;
    row.dataset.labelNode = node.fullName;
    row.dataset.branchKey = node.key;

    if (node.label) {
      row.dataset.labelName = node.label.name;
    }

    const info = document.createElement("div");
    info.className = "label-node-main";

    const head = document.createElement("div");
    head.className = "label-node-head";

    if (node.children.length) {
      row.classList.add("is-collapsible");

      if (!state.initializedLabelBranches.has(node.key)) {
        state.initializedLabelBranches.add(node.key);
        state.collapsedLabelBranches.add(node.key);
      }

      if (state.collapsedLabelBranches.has(node.key)) {
        row.classList.add("is-collapsed");
      }

      const branchToggle = document.createElement("span");
      branchToggle.className = "branch-toggle";
      branchToggle.dataset.labelTrigger = "branch";
      branchToggle.setAttribute("aria-hidden", "true");
      head.appendChild(branchToggle);
    }

    const title = document.createElement(node.label ? "button" : "span");
    title.className = `label-display${node.label ? " can-rename" : ""}`;
    title.textContent = node.segment;
    title.setAttribute("data-label-trigger", node.label ? "rename" : "branch");

    if (node.label) {
      title.type = "button";
      title.dataset.fullName = node.label.name;
      title.title = "Click to rename this label";
    }

    head.appendChild(title);
    info.appendChild(head);

    if (node.label || node.nestedMessageCount) {
      const meta = document.createElement("p");
      meta.className = "label-meta";
      meta.textContent = formatLabelMessageCounts(
        node.label?.messageCount,
        node.label?.unreadMessageCount,
        node.nestedMessageCount
      );
      info.appendChild(meta);
    }

    row.appendChild(info);

    if (node.label) {
      const actions = document.createElement("div");
      actions.className = "label-actions";
      actions.innerHTML = `
        <button
          type="button"
          class="delete-chip"
          aria-label="Delete ${escapeAttribute(node.label.name)}"
          title="Delete ${escapeAttribute(node.label.name)}"
          data-action="delete"
          data-name="${escapeAttribute(node.label.name)}"
        >X</button>
      `;
      row.appendChild(actions);
    }

    branch.appendChild(row);

    if (node.children.length) {
      branch.appendChild(renderLabelTreeLevel(node.children, depth + 1));
    }

    container.appendChild(branch);
  });

  return container;
}

function startInlineLabelRename(nodeElement) {
  if (!nodeElement || nodeElement.dataset.editing === "true") {
    return;
  }

  const trigger = nodeElement.querySelector("[data-label-trigger='rename']");

  if (!trigger) {
    return;
  }

  const fullName = trigger.dataset.fullName;

  if (!fullName) {
    return;
  }

  nodeElement.dataset.editing = "true";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "label-editor";
  input.value = fullName;
  input.dataset.labelEditor = "true";
  input.dataset.originalName = fullName;
  input.setAttribute("aria-label", `Rename ${fullName}`);
  trigger.replaceWith(input);
  input.focus();
  input.select();
}

async function commitInlineLabelRename(input) {
  if (!input || input.dataset.committing === "true" || input.dataset.cancelled === "true") {
    return;
  }

  const currentName = input.dataset.originalName || "";
  const nextName = input.value.trim();

  if (!nextName || nextName === currentName) {
    restoreInlineLabelName(input, currentName);
    return;
  }

  input.dataset.committing = "true";

  try {
    await withLoading(async () => {
      setStatus("Renaming labels…");
      const result = await sendApiCommand("renameLabel", { currentName, nextName });
      setStatus("Refreshing Gmail state…");
      await reloadSnapshotAfterLabelRename(result.labels || []);
      const renamedCount = result?.renamed?.count || 1;

      if (renamedCount > 1) {
        setStatus(`Renamed ${renamedCount} labels from ${currentName} to ${nextName}.`, "success");
        return;
      }

      setStatus(`Label renamed to ${nextName}.`, "success");
    });
  } catch (error) {
    restoreInlineLabelName(input, currentName);
  }
}

function cancelInlineLabelRename(input) {
  if (!input) {
    return;
  }

  input.dataset.cancelled = "true";
  restoreInlineLabelName(input, input.dataset.originalName || input.value);
}

function restoreInlineLabelName(input, fullName) {
  const nodeElement = input.closest("[data-label-node]");

  if (!nodeElement) {
    return;
  }

  const segment = String(fullName).split("/").filter(Boolean).pop() || String(fullName);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "label-display can-rename";
  button.textContent = segment;
  button.dataset.labelTrigger = "rename";
  button.dataset.fullName = fullName;
  button.title = "Click to rename this label";
  input.replaceWith(button);
  delete nodeElement.dataset.editing;
}

function toggleLabelBranch(nodeElement) {
  if (!nodeElement?.dataset.branchKey) {
    return;
  }

  const branchKey = nodeElement.dataset.branchKey;

  if (state.collapsedLabelBranches.has(branchKey)) {
    state.collapsedLabelBranches.delete(branchKey);
    nodeElement.classList.remove("is-collapsed");
    return;
  }

  state.collapsedLabelBranches.add(branchKey);
  nodeElement.classList.add("is-collapsed");
}

function formatLabelMessageCounts(totalCount, unreadCount, nestedCount = 0) {
  const total = Number.isFinite(Number(totalCount)) ? Number(totalCount) : 0;
  const unread = Number.isFinite(Number(unreadCount)) ? Number(unreadCount) : 0;
  const nested = Number.isFinite(Number(nestedCount)) ? Number(nestedCount) : 0;
  const hasChildren = nestedCount !== undefined && nestedCount !== null;
  const totalLabel = total === 1 ? "message" : "messages";
  const unreadLabel = unread === 1 ? "unread message" : "unread messages";
  const parts = [
    `${total.toLocaleString()} ${totalLabel}`,
    `${unread.toLocaleString()} ${unreadLabel}`
  ];

  if (hasChildren) {
    parts.push(`${nested.toLocaleString()} nested messages`);
  }

  return parts.join(", ");
}

function renderAuthStatus(auth) {
  const signedIn = Boolean(auth?.signedIn);
  const apiStatus = state.apiStatus;
  const authText = signedIn
    ? `Signed in: ${auth.email || "Google user"}`
    : "Not signed in to Google";
  const apiText = apiStatus?.signedIn
    ? apiStatus.ok
      ? `Gmail API ready: ${apiStatus.userLabelCount} user labels, ${apiStatus.filterCount} filters`
      : `Gmail API error: ${apiStatus.message}`
    : "Gmail API not connected";

  elements.authStatus.textContent = `${authText} | ${apiText}`;
  elements.authMeta.textContent = auth?.extensionId
    ? `Extension ID ${auth.extensionId}`
    : "";
  elements.signInButton.hidden = signedIn;
  elements.signOutButton.hidden = !signedIn;
}