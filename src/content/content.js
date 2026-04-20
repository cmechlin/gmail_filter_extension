(function () {
  const QUICK_FILTER_BUTTON_ID = "gmail-filter-manager-quick-filter";
  const QUICK_FILTER_STYLE_ID = "gmail-filter-manager-style";
  const LAST_LABEL_KEY = "quickFilterLastLabel";
  const QUICK_FILTER_REFRESH_MS = 1200;
  let selectionObserver = null;
  let selectionRefreshTimer = null;

  const SYSTEM_LABELS = new Set([
    "inbox",
    "starred",
    "snoozed",
    "sent",
    "drafts",
    "important",
    "chats",
    "scheduled",
    "all mail",
    "spam",
    "trash",
    "categories",
    "social",
    "updates",
    "forums",
    "promotions",
    "more",
    "less",
    "manage labels",
    "create new"
  ]);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "gmail-command") {
      return false;
    }

    handleCommand(message.command, message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  });

  async function handleCommand(command, payload) {
    await waitForGmailShell();

    switch (command) {
      case "ping":
        return {
          title: document.title,
          url: location.href,
          ready: true
        };
      case "showTestAlert":
        return showTestAlert(payload);
      case "getSnapshot":
        return getSnapshot();
      case "listLabels":
        return listLabels();
      case "listFilters":
        return listFilters();
      case "createLabel":
        return createLabel(payload);
      case "renameLabel":
        return renameLabel(payload);
      case "deleteLabel":
        return deleteLabel(payload);
      case "createFilter":
        return createFilter(payload);
      case "deleteFilter":
        return deleteFilter(payload);
      case "bulkApplyLabel":
        return bulkApplyLabel(payload);
      case "exportConfig":
        return exportConfig();
      case "importConfig":
        return importConfig(payload);
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  }

  async function getSnapshot() {
    const [labels, filters] = await Promise.all([listLabels(), listFilters()]);

    return {
      labels,
      filters,
      exportedAt: new Date().toISOString(),
      sourceUrl: location.href
    };
  }

  initializeQuickFilterButton().catch((error) => {
    console.error("Failed to initialize Gmail Filter Manager quick filter button", error);
  });

  async function showTestAlert(payload) {
    const title = cleanText(document.title || "Gmail");
    const message = cleanText(payload?.message || `Connected to Gmail: ${title}`);

    window.alert(message);

    return {
      shown: true,
      title,
      url: location.href
    };
  }

  async function listLabels() {
    const sidebarLabels = readSidebarLabels();
    let settingsLabels = [];

    try {
      settingsLabels = await readSettingsLabels();
    } catch (error) {
      console.warn("Unable to read labels from settings", error);
    }

    const labelMap = new Map();

    [...sidebarLabels, ...settingsLabels].forEach((label) => {
      if (!label?.name) {
        return;
      }

      labelMap.set(label.name.toLowerCase(), {
        name: label.name,
        source: label.source || "unknown",
        visible: label.visible !== false
      });
    });

    return [...labelMap.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async function listFilters() {
    const rows = await getSettingsRows("Filters and Blocked Addresses");

    return rows
      .map((row) => parseFilterRow(row))
      .filter(Boolean)
      .sort((left, right) => left.summary.localeCompare(right.summary));
  }

  async function createLabel(payload) {
    const name = payload?.name?.trim();

    if (!name) {
      throw new Error("A label name is required.");
    }

    await openSettingsTab("Labels");
    const createTrigger = await findClickableByText(document, ["Create new label", "Create new"]);

    if (!createTrigger) {
      throw new Error("Could not find Gmail's label creation control.");
    }

    clickElement(createTrigger);

    const dialog = await waitFor(() => findVisibleDialog(), { timeout: 10000 });
    const input = await waitFor(() => dialog.querySelector('input[type="text"], textarea'), { timeout: 5000 });
    setInputValue(input, name);

    const submit = await findClickableByText(dialog, ["Create", "OK"]);

    if (!submit) {
      throw new Error("Could not confirm label creation.");
    }

    clickElement(submit);
    await sleep(1200);

    return {
      created: name,
      labels: await listLabels()
    };
  }

  async function renameLabel(payload) {
    const currentName = payload?.currentName?.trim();
    const nextName = payload?.nextName?.trim();

    if (!currentName || !nextName) {
      throw new Error("Current and next label names are required.");
    }

    const row = await findLabelSettingsRow(currentName);
    const editControl = await findClickableByText(row, ["Edit"]);

    if (!editControl) {
      throw new Error(`Could not find the edit action for label \"${currentName}\".`);
    }

    clickElement(editControl);

    const dialog = await waitFor(() => findVisibleDialog(), { timeout: 10000 });
    const input = await waitFor(() => dialog.querySelector('input[type="text"], textarea'), { timeout: 5000 });
    setInputValue(input, nextName);

    const submit = await findClickableByText(dialog, ["Save", "OK"]);

    if (!submit) {
      throw new Error("Could not confirm label rename.");
    }

    clickElement(submit);
    await sleep(1200);

    return {
      renamed: {
        from: currentName,
        to: nextName
      },
      labels: await listLabels()
    };
  }

  async function deleteLabel(payload) {
    const name = payload?.name?.trim();

    if (!name) {
      throw new Error("A label name is required.");
    }

    const row = await findLabelSettingsRow(name);
    const removeControl = await findClickableByText(row, ["Remove", "Delete"]);

    if (!removeControl) {
      throw new Error(`Could not find the remove action for label \"${name}\".`);
    }

    clickElement(removeControl);

    const dialog = await waitFor(() => findVisibleDialog(), { timeout: 10000 });
    const confirm = await findClickableByText(dialog, ["Delete", "Remove", "OK"]);

    if (!confirm) {
      throw new Error("Could not confirm label deletion.");
    }

    clickElement(confirm);
    await sleep(1200);

    return {
      deleted: name,
      labels: await listLabels()
    };
  }

  async function createFilter(payload) {
    await openSettingsTab("Filters and Blocked Addresses");
    const trigger = await findClickableByText(document, ["Create a new filter"]);

    if (!trigger) {
      throw new Error("Could not find Gmail's filter creation entry point.");
    }

    clickElement(trigger);

    const criteriaDialog = await waitFor(() => findVisibleDialog(), { timeout: 12000 });
    await fillFilterCriteria(criteriaDialog, payload);

    const advance = await findClickableByText(criteriaDialog, ["Create filter", "Search"]);

    if (!advance) {
      throw new Error("Could not advance the filter creation dialog.");
    }

    clickElement(advance);
    await sleep(900);

    const actionDialog = await waitFor(() => findVisibleDialog(), { timeout: 12000 });
    await fillFilterActions(actionDialog, payload);

    if (payload?.applyToMatching) {
      await setCheckboxByLabel(actionDialog, "Also apply filter to matching conversations", true);
    }

    const submit = await findClickableByText(actionDialog, ["Create filter", "Create"]);

    if (!submit) {
      throw new Error("Could not confirm filter creation.");
    }

    clickElement(submit);
    await sleep(1400);

    return {
      created: summarizeFilterPayload(payload),
      filters: await listFilters()
    };
  }

  async function initializeQuickFilterButton() {
    await waitForGmailShell();
    ensureQuickFilterStyles();
    observeMailboxSelection();
    renderQuickFilterButton();
  }

  function observeMailboxSelection() {
    if (selectionObserver) {
      selectionObserver.disconnect();
    }

    if (selectionRefreshTimer) {
      window.clearInterval(selectionRefreshTimer);
    }

    selectionObserver = new MutationObserver(() => renderQuickFilterButton());
    selectionObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-checked", "class", "style"]
    });

    document.addEventListener("click", scheduleQuickFilterRender, true);
    document.addEventListener("keyup", scheduleQuickFilterRender, true);
    selectionRefreshTimer = window.setInterval(renderQuickFilterButton, QUICK_FILTER_REFRESH_MS);
  }

  function scheduleQuickFilterRender() {
    window.requestAnimationFrame(() => renderQuickFilterButton());
  }

  function renderQuickFilterButton() {
    const toolbar = findSelectionToolbar();
    const selectedRows = getSelectedRows();
    const existingButton = document.getElementById(QUICK_FILTER_BUTTON_ID);

    if (!toolbar) {
      existingButton?.remove();
      return;
    }

    if (existingButton?.parentElement !== toolbar) {
      existingButton?.remove();
    }

    if (existingButton) {
      existingButton.textContent = `Create Label Rule (${selectedRows.length})`;
      existingButton.disabled = selectedRows.length === 0;
      existingButton.title = selectedRows.length
        ? "Create a Gmail filter from the selected messages"
        : "Select one or more Gmail messages to create a filter";
      return;
    }

    const button = document.createElement("button");
    button.id = QUICK_FILTER_BUTTON_ID;
    button.type = "button";
    button.className = "gmail-filter-manager-button";
    button.textContent = `Create Label Rule (${selectedRows.length})`;
    button.disabled = selectedRows.length === 0;
    button.title = selectedRows.length
      ? "Create a Gmail filter from the selected messages"
      : "Select one or more Gmail messages to create a filter";
    button.addEventListener("click", handleQuickFilterButtonClick);
    toolbar.appendChild(button);
  }

  async function handleQuickFilterButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;

    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const selectedRows = getSelectedRows();

    if (!selectedRows.length) {
      window.alert("Select one or more Gmail messages first.");
      renderQuickFilterButton();
      return;
    }

    button.disabled = true;

    try {
      const senders = collectSelectedSenderAddresses(selectedRows);

      if (!senders.length) {
        throw new Error("Could not determine sender addresses from the selected messages.");
      }

      const labelName = await promptForQuickFilterLabel();

      if (!labelName) {
        return;
      }

      const labels = await listLabels();
      const labelExists = labels.some((label) => normalizeText(label.name) === normalizeText(labelName));

      if (!labelExists) {
        await createLabel({ name: labelName });
      }

      const fromClause = buildFromClause(senders);

      await createFilter({
        from: fromClause,
        labelName,
        archive: true,
        neverSpam: true,
        applyToMatching: true
      });

      await chrome.storage.local.set({ [LAST_LABEL_KEY]: labelName });
      window.alert(`Created Gmail filter for ${senders.length} sender${senders.length === 1 ? "" : "s"} with label \"${labelName}\", Skip Inbox, and Never Spam.`);
    } catch (error) {
      window.alert(error.message || "Could not create the Gmail filter.");
    } finally {
      button.disabled = false;
      renderQuickFilterButton();
    }
  }

  async function promptForQuickFilterLabel() {
    const stored = await chrome.storage.local.get([LAST_LABEL_KEY]);
    const suggested = stored[LAST_LABEL_KEY] || "";
    const labelName = window.prompt("Label to apply. Use an existing label or enter a new one.", suggested);

    if (!labelName) {
      return null;
    }

    const trimmed = cleanText(labelName);

    if (!trimmed) {
      return null;
    }

    return trimmed;
  }

  function collectSelectedSenderAddresses(rows) {
    const senders = new Set();

    rows.forEach((row) => {
      readSenderCandidates(row).forEach((sender) => {
        const normalized = normalizeSender(sender);

        if (normalized) {
          senders.add(normalized);
        }
      });
    });

    return [...senders];
  }

  function readSenderCandidates(row) {
    const values = new Set();
    const candidates = row.querySelectorAll('[email], [data-hovercard-id], [data-name], span[title], div[title], span[email]');

    candidates.forEach((candidate) => {
      const possibleValues = [
        candidate.getAttribute("email"),
        candidate.getAttribute("data-hovercard-id"),
        candidate.getAttribute("title"),
        candidate.getAttribute("data-name"),
        candidate.textContent
      ];

      possibleValues.forEach((value) => {
        const cleaned = cleanText(value || "");

        if (cleaned) {
          values.add(cleaned);
        }
      });
    });

    return [...values];
  }

  function normalizeSender(value) {
    const cleaned = cleanText(value || "");

    if (!cleaned || cleaned.length < 3) {
      return "";
    }

    const emailMatch = cleaned.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

    if (emailMatch) {
      return emailMatch[0].toLowerCase();
    }

    if (/^(me|starred|important|draft|inbox)$/i.test(cleaned)) {
      return "";
    }

    return cleaned;
  }

  function buildFromClause(senders) {
    return senders
      .map((sender) => sender.includes(" ") ? `"${sender}"` : sender)
      .join(" OR ");
  }

  function getSelectedRows() {
    return [...document.querySelectorAll('[role="main"] div[role="checkbox"][aria-checked="true"], tr[role="row"], table tr')]
      .map((candidate) => candidate.matches('div[role="checkbox"]') ? candidate.closest('tr[role="row"], tr') : candidate)
      .filter(Boolean)
      .filter((row, index, rows) => rows.indexOf(row) === index)
      .filter((row) => {
        const checkbox = row.querySelector('div[role="checkbox"][aria-checked="true"]');
        return checkbox && isVisible(row);
      });
  }

  function findSelectionToolbar() {
    const scope = document.querySelector('[role="main"]') || document;
    const toolbarCandidates = [...scope.querySelectorAll('div[role="toolbar"]')].filter(isVisible);

    return toolbarCandidates.find((toolbar) => {
      const actionControls = [...toolbar.querySelectorAll('div[role="button"], button')];

      return actionControls.some((control) => {
        const text = normalizeText(control.textContent || control.getAttribute("aria-label") || control.getAttribute("title") || "");
        return text.includes("archive") || text.includes("delete") || text.includes("report spam") || text.includes("label") || text.includes("move to");
      });
    }) || null;
  }

  function ensureQuickFilterStyles() {
    if (document.getElementById(QUICK_FILTER_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = QUICK_FILTER_STYLE_ID;
    style.textContent = `
      #${QUICK_FILTER_BUTTON_ID} {
        border: 1px solid rgba(166, 75, 26, 0.35);
        background: linear-gradient(135deg, #a64b1a, #7b2f08);
        color: #fff7ef;
        border-radius: 999px;
        padding: 0 16px;
        min-height: 36px;
        margin-left: 8px;
        font: 500 13px/1 "Google Sans", Arial, sans-serif;
        cursor: pointer;
      }

      #${QUICK_FILTER_BUTTON_ID}:disabled {
        opacity: 0.65;
        cursor: not-allowed;
      }
    `;

    document.documentElement.appendChild(style);
  }

  async function deleteFilter(payload) {
    const filterId = payload?.id;
    const summary = payload?.summary?.trim();
    const rows = await getSettingsRows("Filters and Blocked Addresses");
    const row = rows.find((candidate) => {
      const parsed = parseFilterRow(candidate);

      if (!parsed) {
        return false;
      }

      if (filterId && parsed.id === filterId) {
        return true;
      }

      return summary && parsed.summary === summary;
    });

    if (!row) {
      throw new Error("The requested filter could not be found.");
    }

    const removeControl = await findClickableByText(row, ["Delete"]);

    if (!removeControl) {
      throw new Error("Could not find the delete action for that filter.");
    }

    clickElement(removeControl);
    await sleep(1200);

    return {
      deleted: filterId || summary,
      filters: await listFilters()
    };
  }

  async function bulkApplyLabel(payload) {
    const query = payload?.query?.trim();
    const labelName = payload?.labelName?.trim();
    const archive = Boolean(payload?.archive);

    if (!query || !labelName) {
      throw new Error("A Gmail search query and label name are required.");
    }

    await ensureMailboxView();
    await runSearch(query);
    await selectSearchResults();
    await applyLabelToSelection(labelName);

    if (archive) {
      await archiveSelection();
    }

    return {
      query,
      labelName,
      archive
    };
  }

  async function exportConfig() {
    return getSnapshot();
  }

  async function importConfig(payload) {
    const labels = Array.isArray(payload?.labels) ? payload.labels : [];
    const filters = Array.isArray(payload?.filters) ? payload.filters : [];
    const results = {
      labels: [],
      filters: []
    };

    for (const label of labels) {
      try {
        const currentLabels = await listLabels();
        const exists = currentLabels.some((candidate) => candidate.name.toLowerCase() === label.name.toLowerCase());

        if (!exists) {
          await createLabel({ name: label.name });
          results.labels.push({ name: label.name, status: "created" });
        } else {
          results.labels.push({ name: label.name, status: "skipped" });
        }
      } catch (error) {
        results.labels.push({ name: label.name, status: "failed", error: error.message });
      }
    }

    for (const filter of filters) {
      try {
        await createFilter(filter.raw || hydrateFilterPayload(filter));
        results.filters.push({ summary: filter.summary, status: "created" });
      } catch (error) {
        results.filters.push({ summary: filter.summary, status: "failed", error: error.message });
      }
    }

    return results;
  }

  function readSidebarLabels() {
    const navigation = document.querySelector('div[role="navigation"]');

    if (!navigation) {
      return [];
    }

    const candidates = [...navigation.querySelectorAll('a, [role="link"], [role="treeitem"], [data-tooltip]')];
    const labels = new Map();

    candidates.forEach((candidate) => {
      const name = cleanText(candidate.getAttribute("title") || candidate.getAttribute("aria-label") || candidate.textContent || "");

      if (!name || SYSTEM_LABELS.has(name.toLowerCase()) || /\d+ unread$/i.test(name)) {
        return;
      }

      labels.set(name.toLowerCase(), {
        name,
        source: "sidebar",
        visible: isVisible(candidate)
      });
    });

    return [...labels.values()];
  }

  async function readSettingsLabels() {
    const rows = await getSettingsRows("Labels");

    return rows
      .map((row) => {
        const text = cleanText(row.textContent || "");

        if (!text) {
          return null;
        }

        const nameNode = [...row.querySelectorAll('span, a, div')]
          .find((candidate) => {
            const candidateText = cleanText(candidate.textContent || "");

            if (!candidateText) {
              return false;
            }

            if (candidateText.length > 60) {
              return false;
            }

            if (/show in|hide|remove|edit/i.test(candidateText)) {
              return false;
            }

            return true;
          });

        const name = cleanText(nameNode?.textContent || text.split("\n")[0] || "");

        if (!name || SYSTEM_LABELS.has(name.toLowerCase())) {
          return null;
        }

        return {
          name,
          source: "settings",
          visible: !/hide/i.test(text)
        };
      })
      .filter(Boolean);
  }

  async function findLabelSettingsRow(labelName) {
    const rows = await getSettingsRows("Labels");
    const target = normalizeText(labelName);
    const row = rows.find((candidate) => normalizeText(candidate.textContent || "").includes(target));

    if (!row) {
      throw new Error(`Could not find label \"${labelName}\" in Gmail settings.`);
    }

    return row;
  }

  async function getSettingsRows(tabName) {
    await openSettingsTab(tabName);

    return waitFor(() => {
      const settingsRoot = getSettingsRoot();

      if (!settingsRoot) {
        return null;
      }

      const rows = [...settingsRoot.querySelectorAll('tr, [role="row"], .ae4.UI')].filter((row) => {
        const text = cleanText(row.textContent || "");
        return text.length > 2;
      });

      return rows.length ? rows : null;
    }, { timeout: 12000 });
  }

  async function openSettingsTab(tabName) {
    const normalized = normalizeText(tabName);

    if (isSettingsTabActive(normalized)) {
      return;
    }

    const settingsRoot = getSettingsRoot();

    if (!settingsRoot) {
      await openSettingsScreen();
    }

    const tab = await waitFor(async () => {
      const tabElement = await findClickableByText(document, [tabName]);

      if (!tabElement) {
        return null;
      }

      return tabElement;
    }, { timeout: 12000 });

    clickElement(tab);
    await sleep(900);
  }

  async function openSettingsScreen() {
    const settingsButton = findSettingsButton();

    if (!settingsButton) {
      throw new Error("Could not locate Gmail's settings button.");
    }

    clickElement(settingsButton);

    const fullSettings = await waitFor(() => findClickableByText(document, ["See all settings"]), { timeout: 12000 });

    if (!fullSettings) {
      throw new Error("Could not open Gmail settings.");
    }

    clickElement(fullSettings);
    await waitFor(() => getSettingsRoot(), { timeout: 15000 });
    await sleep(1200);
  }

  function getSettingsRoot() {
    return document.querySelector('div[role="main"] .nH, .nH.bkK, .nH.if, .aeJ');
  }

  function isSettingsTabActive(normalizedName) {
    const selected = [...document.querySelectorAll('[role="tab"][aria-selected="true"], .J-Ke[aria-selected="true"]')]
      .map((candidate) => normalizeText(candidate.textContent || candidate.getAttribute("aria-label") || ""));

    return selected.includes(normalizedName);
  }

  function parseFilterRow(row) {
    const text = cleanText(row.textContent || "");

    if (!text || !/edit|delete/i.test(text)) {
      return null;
    }

    const actions = [...row.querySelectorAll('a, button, [role="button"]')]
      .map((candidate) => cleanText(candidate.textContent || candidate.getAttribute("aria-label") || ""))
      .filter(Boolean);

    const summary = text
      .replace(/\b(edit|delete)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    return {
      id: hashText(summary),
      summary,
      actions,
      raw: extractFilterPayloadFromSummary(summary)
    };
  }

  async function fillFilterCriteria(dialog, payload) {
    const fieldMap = [
      ["From", payload?.from],
      ["To", payload?.to],
      ["Subject", payload?.subject],
      ["Has the words", payload?.hasWords],
      ["Doesn't have", payload?.doesNotHave],
      ["Size", payload?.size]
    ];

    for (const [label, value] of fieldMap) {
      if (!value) {
        continue;
      }

      const input = findInputForLabel(dialog, label);

      if (input) {
        setInputValue(input, value);
      }
    }

    if (payload?.hasAttachment) {
      await setCheckboxByLabel(dialog, "Has attachment", true);
    }

    if (payload?.excludeChats) {
      await setCheckboxByLabel(dialog, "Don't include chats", true);
    }
  }

  async function fillFilterActions(dialog, payload) {
    if (payload?.archive) {
      await setCheckboxByLabel(dialog, "Skip the Inbox", true);
    }

    if (payload?.markRead) {
      await setCheckboxByLabel(dialog, "Mark as read", true);
    }

    if (payload?.neverSpam) {
      await setCheckboxByLabel(dialog, "Never send it to Spam", true);
    }

    if (payload?.important) {
      await setCheckboxByLabel(dialog, "Always mark it as important", true);
    }

    if (payload?.labelName) {
      await setCheckboxByLabel(dialog, "Apply the label", true);
      const select = dialog.querySelector('select');

      if (!select) {
        throw new Error("Gmail did not expose the label selector in the filter action dialog.");
      }

      selectOptionByText(select, payload.labelName);
    }
  }

  async function ensureMailboxView() {
    const inboxLink = [...document.querySelectorAll('a[href*="#inbox"], a[title="Inbox"]')].find(isVisible);

    if (inboxLink) {
      clickElement(inboxLink);
      await sleep(1200);
    }

    await waitFor(() => document.querySelector('input[aria-label*="Search mail"], input[placeholder*="Search mail"]'), { timeout: 12000 });
  }

  async function runSearch(query) {
    const searchInput = await waitFor(() => document.querySelector('input[aria-label*="Search mail"], input[placeholder*="Search mail"]'), { timeout: 12000 });
    setInputValue(searchInput, query);
    searchInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    searchInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
    await sleep(1800);
  }

  async function selectSearchResults() {
    const checkbox = await waitFor(() => document.querySelector('div[role="checkbox"][aria-label*="Select"], div[command=""] div[role="checkbox"]'), { timeout: 12000 });
    clickElement(checkbox);
    await sleep(600);

    const selectAll = await findClickableByText(document, ["Select all conversations that match this search"]);

    if (selectAll) {
      clickElement(selectAll);
      await sleep(900);
    }
  }

  async function applyLabelToSelection(labelName) {
    const labelButton = await waitFor(() => document.querySelector('div[role="button"][aria-label*="Labels"], div[command*="label"]'), { timeout: 12000 });
    clickElement(labelButton);

    const menu = await waitFor(() => document.querySelector('div[role="menu"], div[aria-label*="Label as"]'), { timeout: 10000 });
    const target = await findClickableByText(menu, [labelName]);

    if (!target) {
      throw new Error(`Could not find label \"${labelName}\" in Gmail's label menu.`);
    }

    clickElement(target);
    await sleep(700);

    const apply = await findClickableByText(document, ["Apply", "OK"]);

    if (apply) {
      clickElement(apply);
      await sleep(1000);
    }
  }

  async function archiveSelection() {
    const archiveButton = await waitFor(() => document.querySelector('div[role="button"][aria-label*="Archive"]'), { timeout: 8000 });
    clickElement(archiveButton);
    await sleep(1000);
  }

  async function setCheckboxByLabel(root, labelText, desiredValue) {
    const label = [...root.querySelectorAll('label, span, div')].find((candidate) => normalizeText(candidate.textContent || "") === normalizeText(labelText));

    if (!label) {
      throw new Error(`Could not find checkbox label \"${labelText}\".`);
    }

    const checkbox = label.closest('label')?.querySelector('input[type="checkbox"]')
      || label.parentElement?.querySelector('input[type="checkbox"]');

    if (!checkbox) {
      throw new Error(`Could not find checkbox for \"${labelText}\".`);
    }

    if (checkbox.checked !== desiredValue) {
      clickElement(checkbox);
      await sleep(200);
    }
  }

  function findInputForLabel(root, labelText) {
    const normalizedLabel = normalizeText(labelText);
    const label = [...root.querySelectorAll('label, td, div, span')].find((candidate) => normalizeText(candidate.textContent || "") === normalizedLabel);

    if (!label) {
      return null;
    }

    return label.closest('tr, div, label')?.querySelector('input[type="text"], input:not([type]), textarea') || null;
  }

  function findSettingsButton() {
    return document.querySelector('div[role="button"][aria-label*="Settings"], button[aria-label*="Settings"], div[data-tooltip*="Settings"]');
  }

  async function findClickableByText(root, labels) {
    const normalizedLabels = labels.map(normalizeText);
    const candidates = [...root.querySelectorAll('button, a, [role="button"], [role="link"], div[tabindex], span[role="button"]')];

    return candidates.find((candidate) => {
      if (!isVisible(candidate)) {
        return false;
      }

      const text = normalizeText(candidate.textContent || candidate.getAttribute("aria-label") || candidate.getAttribute("title") || "");
      return normalizedLabels.some((label) => text === label || text.includes(label));
    }) || null;
  }

  function findVisibleDialog() {
    return [...document.querySelectorAll('[role="dialog"], .Kj-JD, .aSt')].find(isVisible) || null;
  }

  async function waitForGmailShell() {
    await waitFor(() => document.body, { timeout: 8000 });

    if (!location.hostname.includes("mail.google.com")) {
      throw new Error("This extension only works on Gmail.");
    }
  }

  async function waitFor(callback, options = {}) {
    const timeout = options.timeout || 10000;
    const interval = options.interval || 150;
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const value = await callback();

      if (value) {
        return value;
      }

      await sleep(interval);
    }

    throw new Error("Timed out waiting for Gmail to respond.");
  }

  function clickElement(element) {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.click();
  }

  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value");

    if (descriptor?.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function selectOptionByText(select, text) {
    const normalized = normalizeText(text);
    const option = [...select.options].find((candidate) => normalizeText(candidate.textContent || candidate.label || "") === normalized);

    if (!option) {
      throw new Error(`Label option \"${text}\" was not found.`);
    }

    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function summarizeFilterPayload(payload) {
    return [
      payload?.from ? `from:${payload.from}` : "",
      payload?.to ? `to:${payload.to}` : "",
      payload?.subject ? `subject:${payload.subject}` : "",
      payload?.hasWords ? `has:${payload.hasWords}` : "",
      payload?.doesNotHave ? `not:${payload.doesNotHave}` : "",
      payload?.labelName ? `label:${payload.labelName}` : "",
      payload?.archive ? "archive" : "",
      payload?.markRead ? "markRead" : ""
    ].filter(Boolean).join(" | ");
  }

  function extractFilterPayloadFromSummary(summary) {
    const payload = {};
    const normalized = summary.toLowerCase();

    if (normalized.includes("skip the inbox")) {
      payload.archive = true;
    }

    if (normalized.includes("mark as read")) {
      payload.markRead = true;
    }

    const labelMatch = summary.match(/apply label\s+([^,;]+)/i);

    if (labelMatch) {
      payload.labelName = cleanText(labelMatch[1]);
    }

    return payload;
  }

  function hydrateFilterPayload(filter) {
    return {
      from: filter.from || "",
      to: filter.to || "",
      subject: filter.subject || "",
      hasWords: filter.hasWords || "",
      doesNotHave: filter.doesNotHave || "",
      labelName: filter.labelName || filter.raw?.labelName || "",
      archive: Boolean(filter.archive || filter.raw?.archive),
      markRead: Boolean(filter.markRead || filter.raw?.markRead)
    };
  }

  function normalizeText(value) {
    return cleanText(value).toLowerCase();
  }

  function cleanText(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }

    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().height > 0;
  }

  function hashText(value) {
    let hash = 0;

    for (let index = 0; index < value.length; index += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(index);
      hash |= 0;
    }

    return `filter-${Math.abs(hash)}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
})();
