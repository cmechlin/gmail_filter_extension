const storageKeys = {
  draftFilter: "draftFilter",
  draftBulk: "draftBulk",
  draftLabel: "draftLabel",
  lastSnapshot: "lastSnapshot"
};

const state = {
  labels: [],
  filters: [],
  loading: false
};

const elements = {
  statusBanner: document.querySelector("#statusBanner"),
  snapshotMeta: document.querySelector("#snapshotMeta"),
  labelCount: document.querySelector("#labelCount"),
  filterCount: document.querySelector("#filterCount"),
  labelsList: document.querySelector("#labelsList"),
  filtersList: document.querySelector("#filtersList"),
  refreshButton: document.querySelector("#refreshButton"),
  exportButton: document.querySelector("#exportButton"),
  importButton: document.querySelector("#importButton"),
  importInput: document.querySelector("#importInput"),
  createLabelForm: document.querySelector("#createLabelForm"),
  createFilterForm: document.querySelector("#createFilterForm"),
  bulkApplyForm: document.querySelector("#bulkApplyForm"),
  emptyStateTemplate: document.querySelector("#emptyStateTemplate")
};

bootstrap().catch((error) => setStatus(error.message, "error"));

async function bootstrap() {
  bindEvents();
  await restoreDrafts();
  await refreshSnapshot();
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => refreshSnapshot());
  elements.exportButton.addEventListener("click", () => exportSnapshot());
  elements.importButton.addEventListener("click", () => elements.importInput.click());
  elements.importInput.addEventListener("change", handleImportFile);
  elements.createLabelForm.addEventListener("submit", handleCreateLabel);
  elements.createFilterForm.addEventListener("submit", handleCreateFilter);
  elements.bulkApplyForm.addEventListener("submit", handleBulkApply);
  elements.createLabelForm.addEventListener("input", persistDrafts);
  elements.createFilterForm.addEventListener("input", persistDrafts);
  elements.bulkApplyForm.addEventListener("input", persistDrafts);
  elements.labelsList.addEventListener("click", handleLabelsListClick);
  elements.filtersList.addEventListener("click", handleFiltersListClick);
}

async function refreshSnapshot() {
  await withLoading(async () => {
    setStatus("Reading Gmail…");
    const snapshot = await sendCommand("getSnapshot");
    state.labels = snapshot.labels || [];
    state.filters = snapshot.filters || [];
    await chrome.storage.local.set({ [storageKeys.lastSnapshot]: snapshot });
    render(snapshot);
    setStatus("Gmail state refreshed.", "success");
  });
}

async function exportSnapshot() {
  await withLoading(async () => {
    setStatus("Exporting configuration…");
    const snapshot = await sendCommand("exportConfig");
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
    const result = await sendCommand("importConfig", payload);
    await refreshSnapshot();
    const failedLabels = result.labels.filter((item) => item.status === "failed").length;
    const failedFilters = result.filters.filter((item) => item.status === "failed").length;
    const tone = failedLabels || failedFilters ? "error" : "success";
    setStatus(`Import finished. Label failures: ${failedLabels}. Filter failures: ${failedFilters}.`, tone);
  });

  event.target.value = "";
}

async function handleCreateLabel(event) {
  event.preventDefault();
  const payload = formToObject(event.currentTarget);

  await withLoading(async () => {
    await sendCommand("createLabel", payload);
    event.currentTarget.reset();
    await persistDrafts();
    await refreshSnapshot();
    setStatus(`Label created: ${payload.name}`, "success");
  });
}

async function handleCreateFilter(event) {
  event.preventDefault();
  const payload = formToObject(event.currentTarget);

  await withLoading(async () => {
    await sendCommand("createFilter", payload);
    event.currentTarget.reset();
    await persistDrafts();
    await refreshSnapshot();
    setStatus("Filter created.", "success");
  });
}

async function handleBulkApply(event) {
  event.preventDefault();
  const payload = formToObject(event.currentTarget);

  await withLoading(async () => {
    await sendCommand("bulkApplyLabel", payload);
    setStatus("Bulk label operation sent to Gmail.", "success");
  });
}

async function handleLabelsListClick(event) {
  const button = event.target.closest("button[data-action]");

  if (!button) {
    return;
  }

  const name = button.dataset.name;
  const action = button.dataset.action;

  if (!name || !action) {
    return;
  }

  if (action === "rename") {
    const nextName = window.prompt("Rename label", name);

    if (!nextName || nextName.trim() === name) {
      return;
    }

    await withLoading(async () => {
      await sendCommand("renameLabel", { currentName: name, nextName });
      await refreshSnapshot();
      setStatus(`Label renamed to ${nextName}.`, "success");
    });
  }

  if (action === "delete") {
    const confirmed = window.confirm(`Delete label \"${name}\" in Gmail?`);

    if (!confirmed) {
      return;
    }

    await withLoading(async () => {
      await sendCommand("deleteLabel", { name });
      await refreshSnapshot();
      setStatus(`Label deleted: ${name}.`, "success");
    });
  }
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
    await sendCommand("deleteFilter", { id, summary });
    await refreshSnapshot();
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

  labels.forEach((label) => {
    const item = document.createElement("article");
    item.className = "item";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(label.name)}</strong>
        <p>Source: ${escapeHtml(label.source || "unknown")}${label.visible === false ? " • hidden" : ""}</p>
      </div>
      <div class="item-actions">
        <button class="pill" data-action="rename" data-name="${escapeAttribute(label.name)}">Rename</button>
        <button class="pill danger" data-action="delete" data-name="${escapeAttribute(label.name)}">Delete</button>
      </div>
    `;
    elements.labelsList.appendChild(item);
  });
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
  fillForm(elements.bulkApplyForm, stored[storageKeys.draftBulk]);

  if (stored[storageKeys.lastSnapshot]) {
    render(stored[storageKeys.lastSnapshot]);
  }
}

async function persistDrafts() {
  await chrome.storage.local.set({
    [storageKeys.draftLabel]: formToObject(elements.createLabelForm),
    [storageKeys.draftFilter]: formToObject(elements.createFilterForm),
    [storageKeys.draftBulk]: formToObject(elements.bulkApplyForm)
  });
}

async function sendCommand(command, payload = {}) {
  const response = await chrome.runtime.sendMessage({
    type: "gmail-command",
    command,
    payload
  });

  if (!response?.ok) {
    throw new Error(response?.error || "The extension could not complete the Gmail command.");
  }

  return response.result;
}

async function withLoading(work) {
  if (state.loading) {
    return;
  }

  state.loading = true;
  setControlsDisabled(true);

  try {
    await work();
  } catch (error) {
    setStatus(error.message, "error");
    throw error;
  } finally {
    state.loading = false;
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