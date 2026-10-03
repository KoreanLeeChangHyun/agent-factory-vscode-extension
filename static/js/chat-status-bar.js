globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.statusBar = function (host) {
  "use strict";

  const {
    chatBot, statusBar, statusCatalog, state, uiLocale, agentsMenu, t, renderContextStatus,
    normalizeStatusItems, persist, statusAnnouncement, vscode, statusSettings, statusCatalogList,
    statusSettingsButton, safeCountOrUndefined, currentCapabilities, safePercentOrUndefined,
    safeResetsAtOrUndefined, chatWorkUnits, contextStatusLabel, contextUsedStatusLabel,
    contextRemainingTokensLabel, contextUsedPercentLabel, formatPercent, formatResetsAt,
    formatElapsed, reasoningDisplayLabel, taskModeNames, enterAction
  } = host;

  function renderStatusBar() {
    if (chatBot.botRenderKey !== chatBot.factoryBotKey()) chatBot.renderFactoryBot();
    if (host.statusDragId) { host.statusRenderPending = true; return; }
    const focusedId = statusBar.contains(document.activeElement) ? document.activeElement.dataset.itemId : undefined;
    const catalog = statusCatalog();
    const retained = new Set();
    let previous;
    for (const itemId of state.statusItems.filter(statusItemAvailable)) {
      retained.add(itemId);
      let item = host.statusElements.get(itemId);
      if (!item) {
        item = document.createElement("span");
        item.draggable = true;
        item.tabIndex = 0;
        item.dataset.itemId = itemId;
        bindStatusDrag(item, itemId, false);
        item.addEventListener("click", function () {
          if (itemId === "agents" && state.role === "main") host.chatAgents.openAgentsMenu();
        });
        item.addEventListener("keydown", function (event) {
          if (itemId === "agents" && state.role === "main" && ["Enter", " "].includes(event.key)) {
            event.preventDefault();
            host.chatAgents.openAgentsMenu();
          } else if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            moveStatus(itemId, event.key === "ArrowLeft" ? -1 : 1);
          }
        });
        host.statusElements.set(itemId, item);
      }
      const label = statusLabel(itemId);
      const renderKey = JSON.stringify([label, catalog[itemId], uiLocale(),
        itemId === "runtime" ? state.runtimeAvailable : null,
        itemId === "agents" ? [state.role, state.workUnitsKnown, state.workUnits.activeUnits, state.workUnits.totalCalled, agentsMenu.hidden] : null,
        itemId === "context" ? [state.contextUsedTokens, state.contextWindowTokens] : null]);
      const sibling = previous ? previous.nextElementSibling : statusBar.firstElementChild;
      if (sibling !== item) statusBar.insertBefore(item, sibling);
      previous = item;
      if (host.statusRenderKeys.get(item) === renderKey) continue;
      host.statusRenderKeys.set(item, renderKey);
      item.className = "status-item";
      for (const attr of ["role", "aria-haspopup", "aria-expanded", "data-active"]) item.removeAttribute(attr);
      if (itemId === "runtime" && !state.runtimeAvailable) {
        item.classList.add("runtime-offline");
      }
      item.textContent = label;
      item.title = catalog[itemId][1];
      item.setAttribute("aria-description", catalog[itemId][1]);
      item.setAttribute("aria-label", catalog[itemId][0] + ": " + item.textContent + t("ui.move.with.alt.left.right"));
      if (itemId === "agents" && state.role === "main") {
        item.classList.add("work-unit-activity");
        item.dataset.active = String(state.workUnits.activeUnits > 0);
        item.title = state.workUnitsKnown ? t("ui.active.agent.tasks") + state.workUnits.activeUnits + t("ui.total.calls") + state.workUnits.totalCalled : t("ui.agent.status.unavailable.click.to.refresh");
        item.setAttribute("role", "button");
        item.setAttribute("aria-haspopup", "listbox");
        item.setAttribute("aria-expanded", String(!agentsMenu.hidden));
      } else if (itemId === "context" && state.contextUsedTokens !== undefined && state.contextWindowTokens > 0) {
        renderContextStatus(item);
      }
      if ((itemId === "agents" && state.role === "main") || (itemId === "runtime" && !state.runtimeAvailable)) {
        const indicator = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        indicator.setAttribute("viewBox", "0 0 8 8");
        indicator.setAttribute("aria-hidden", "true");
        indicator.setAttribute("focusable", "false");
        indicator.classList.add("status-indicator");
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", "4"); circle.setAttribute("cy", "4"); circle.setAttribute("r", "3");
        circle.setAttribute("fill", "currentColor");
        indicator.append(circle);
        item.prepend(indicator);
      }
    }
    for (const [id, item] of host.statusElements) {
      if (!retained.has(id)) { item.remove(); host.statusElements.delete(id); }
    }
    if (focusedId && document.activeElement?.dataset.itemId !== focusedId) statusBar.querySelector('[data-item-id="' + focusedId + '"]')?.focus();
    refreshStatusPreview();
  }


  function setStatusItems(items, announcement) {
    state.statusItems = normalizeStatusItems(items);
    renderStatusBar();
    renderStatusCatalog();
    persist();
    statusAnnouncement.textContent = announcement || t("ui.displayed.information.updated");
    vscode.postMessage({ type: "status.reorder", items: state.statusItems });
  }

  function reorderStatus(sourceId, targetId, after = false) {
    const items = state.statusItems.slice();
    if (sourceId === targetId || !items.includes(sourceId) || !items.includes(targetId)) return;
    items.splice(items.indexOf(sourceId), 1);
    items.splice(items.indexOf(targetId) + (after ? 1 : 0), 0, sourceId);
    setStatusItems(items, statusCatalog()[sourceId][0] + t("ui.position.updated"));
  }

  function moveStatus(itemId, offset, order) {
    const visible = order || state.statusItems.filter(statusItemAvailable);
    const index = visible.indexOf(itemId);
    const target = visible[index + offset];
    if (index >= 0 && target) reorderStatus(itemId, target, offset > 0);
  }

  function clearStatusDropTargets() {
    for (const element of document.querySelectorAll(".status-drop-before, .status-drop-after")) {
      element.classList.remove("status-drop-before", "status-drop-after");
    }
  }

  function bindStatusDrag(element, itemId, vertical) {
    element.draggable = true;
    element.addEventListener("dragstart", function (event) {
      if (!state.statusItems.includes(itemId)) { event.preventDefault(); return; }
      host.statusDragId = itemId;
      event.stopPropagation();
      event.dataTransfer?.setData("text/status-item", itemId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      element.classList.add("dragging");
    });
    element.addEventListener("dragend", function () {
      host.statusDragId = undefined;
      element.classList.remove("dragging");
      clearStatusDropTargets();
      if (host.statusRenderPending) { host.statusRenderPending = false; renderStatusBar(); renderStatusCatalog(); }
    });
    function isAfter(event) {
      const rect = element.getBoundingClientRect();
      return vertical ? event.clientY > rect.top + rect.height / 2 : event.clientX > rect.left + rect.width / 2;
    }
    element.addEventListener("dragover", function (event) {
      if (!host.statusDragId || host.statusDragId === itemId || !state.statusItems.includes(itemId)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      clearStatusDropTargets();
      element.classList.add(isAfter(event) ? "status-drop-after" : "status-drop-before");
    });
    element.addEventListener("dragleave", function (event) {
      if (!element.contains(event.relatedTarget)) element.classList.remove("status-drop-before", "status-drop-after");
    });
    element.addEventListener("drop", function (event) {
      const sourceId = host.statusDragId;
      if (!sourceId || event.dataTransfer?.getData("text/status-item") !== sourceId) return;
      event.preventDefault();
      event.stopPropagation();
      host.statusDragId = undefined;
      host.statusRenderPending = false;
      clearStatusDropTargets();
      reorderStatus(sourceId, itemId, isAfter(event));
    });
  }

  function renderStatusCatalog() {
    if (host.statusDragId) { host.statusRenderPending = true; return; }
    if (statusSettings.hidden) return;
    const focusKey = statusCatalogList.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;
    statusCatalogList.replaceChildren();
    // The catalog is fixed: every item stays listed so settings do not shift with model or run state.
    // Availability only decides whether a selected item currently appears in the status bar.
    const visible = state.statusItems.slice();
    const ids = [...visible, ...Object.keys(statusCatalog()).filter(id => !state.statusItems.includes(id))];
    statusCatalogList.dataset.available = Object.keys(statusCatalog()).filter(statusItemAvailable).join(",");
    let previousGroup;
    for (const id of ids) {
      const selected = state.statusItems.includes(id);
      if (previousGroup !== selected) {
        const heading = document.createElement("h3");
        heading.className = "status-catalog-heading";
        heading.textContent = selected ? t("ui.visible") + visible.length : t("ui.available");
        statusCatalogList.append(heading);
        previousGroup = selected;
      }
      const row = document.createElement("div");
      row.className = "status-catalog-row";
      row.dataset.itemId = id;
      row.dataset.selected = String(selected);
      const available = statusItemAvailable(id);
      row.dataset.available = String(available);
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected;
      checkbox.dataset.focusKey = id + "-select";
      checkbox.addEventListener("change", function () {
        setStatusItems(checkbox.checked ? [...state.statusItems, id] : state.statusItems.filter(item => item !== id));
      });
      const name = document.createElement("span");
      name.textContent = statusCatalog()[id][0];
      const checkboxControl = document.createElement("span");
      checkboxControl.className = "status-checkbox";
      const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      check.setAttribute("viewBox", "0 0 16 16");
      check.setAttribute("aria-hidden", "true");
      check.setAttribute("focusable", "false");
      const checkPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      checkPath.setAttribute("d", "m3 8 3 3 7-7");
      check.append(checkPath);
      checkboxControl.append(checkbox, check);
      label.append(checkboxControl, name);
      label.title = statusCatalog()[id][1];
      checkbox.setAttribute("aria-description", statusCatalog()[id][1]);
      const preview = document.createElement("span");
      preview.className = "status-preview";
      preview.dataset.previewId = id;
      preview.textContent = available ? statusLabel(id) : t("ui.status.item.unavailable");
      if (!available) preview.title = t("ui.status.item.unavailable.hint");
      const actions = document.createElement("div");
      actions.className = "status-order-actions";
      for (const [offset, title] of [[-1, t("ui.earlier")], [1, t("ui.later")]]) {
        const button = document.createElement("button");
        button.type = "button";
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 16 16");
        icon.setAttribute("aria-hidden", "true");
        icon.setAttribute("focusable", "false");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", offset < 0 ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4");
        icon.append(path);
        button.append(icon);
        button.title = title + t("ui.move");
        button.dataset.focusKey = id + "-" + offset;
        button.setAttribute("aria-label", statusCatalog()[id][0] + " " + title + t("ui.move"));
        const index = visible.indexOf(id);
        button.disabled = !selected || index + offset < 0 || index + offset >= visible.length;
        button.addEventListener("click", function () { moveStatus(id, offset, visible); });
        actions.append(button);
      }
      actions.hidden = !selected;
      row.append(label, actions, preview);
      if (selected) bindStatusDrag(row, id, true);
      statusCatalogList.append(row);
    }
    if (focusKey) {
      const target = statusCatalogList.querySelector('[data-focus-key="' + focusKey + '"]');
      (target?.disabled ? target.closest(".status-catalog-row").querySelector("input") : target)?.focus();
    }
  }

  function refreshStatusPreview() {
    if (statusSettings.hidden) return;
    if (statusCatalogList.dataset.available !== Object.keys(statusCatalog()).filter(statusItemAvailable).join(",")) {
      renderStatusCatalog();
    }
    for (const preview of statusCatalogList.querySelectorAll("[data-preview-id]")) {
      if (statusItemAvailable(preview.dataset.previewId)) preview.textContent = statusLabel(preview.dataset.previewId);
    }
  }

  function closeStatusSettings() {
    statusSettings.hidden = true;
    statusSettingsButton.setAttribute("aria-expanded", "false");
    statusSettingsButton.focus();
  }
  function statusItemAvailable(id) {
    const main = state.role === "main";
    const hasUsage = safeCountOrUndefined(state.contextUsedTokens) !== undefined;
    const hasWindow = state.contextWindowTokens > 0;
    const supported = currentCapabilities();
    switch (id) {
      case "context": case "contextRemainingTokens": case "contextUsedPercent": return hasUsage && hasWindow;
      case "contextUsed": return hasUsage;
      case "contextWindow": return hasWindow;
      case "fiveHour": case "fiveHourRemaining": return safePercentOrUndefined(state.fiveHourUsedPercent) !== undefined;
      case "weekly": case "weeklyRemaining": return safePercentOrUndefined(state.weeklyUsedPercent) !== undefined;
      case "fiveHourReset": return safeResetsAtOrUndefined(state.fiveHourResetsAt) !== undefined;
      case "weeklyReset": return safeResetsAtOrUndefined(state.weeklyResetsAt) !== undefined;
      case "agents": case "agentsTotal": return main && state.workUnitsKnown;
      case "goalTokens": return main && !host.goalError && safeCountOrUndefined(host.nativeGoal?.tokensUsed) !== undefined;
      case "goalTime": return main && !host.goalError && safeCountOrUndefined(host.nativeGoal?.timeUsedSeconds) !== undefined;
      case "goalBudget": return main && !host.goalError && safeCountOrUndefined(host.nativeGoal?.tokenBudget) !== undefined;
      case "goal": return main && !host.goalError && Boolean(host.nativeGoal || supported.goal);
      case "task": return main;
      case "model": case "reasoning": case "fast": return Boolean(supported[id]);
      case "elapsed": return Boolean(state.running && state.runStartedAt);
      case "project": return Boolean(state.projectName || chatWorkUnits.conversationWorktree?.workingDirectory);
      case "branch": return Boolean(state.branch);
      case "execution": return Boolean(state.executionMode);
      default: return true;
    }
  }
  function statusLabel(itemId) {
    const main = state.role === "main";
    const count = value => safeCountOrUndefined(value) === undefined ? "—" : value.toLocaleString(uiLocale());
    const goalLabels = { active: t("ui.active.a733b8"), paused: t("ui.paused"), blocked: t("ui.awaiting.input"), usageLimited: t("ui.usage.limit"), budgetLimited: t("ui.budget.limit"), complete: t("ui.done") };
    const executionLabels = { "cli-default": t("ui.cli.default"), "workspace-write": t("ui.workspace"), "danger-full-access": t("ui.full.access"), bypass: t("ui.full.bypass"), "read-only": t("ui.read.only") };
    const supported = currentCapabilities();
    const labels = {
      agent: state.title,
      status: state.cancellationRequested ? t("ui.cancellation.requested") : state.pendingDecisionRunId ? t("ui.awaiting.input") : state.running ? t("ui.running.73989d") : state.runtimeAvailable ? t("ui.idle") : t("ui.offline"),
      role: { main: t("ui.main"), work: t("ui.work"), verification: t("ui.verify") }[state.role],
      agents: main ? state.workUnitsKnown ? t("status.agents", state.workUnits.workActive, state.workUnits.verificationActive) : t("ui.agents") : t("ui.agents.main.only"),
      agentsTotal: main ? t("ui.calls") + (state.workUnitsKnown ? count(state.workUnits.totalCalled) : "—") : t("ui.calls.main.only"),
      project: t(chatWorkUnits.conversationWorktree?.worktree && chatWorkUnits.conversationWorktree.worktree.phase !== "merged" ? "worktree.status.tree" : "worktree.status.home"),
      branch: state.branch || "—",
      context: contextStatusLabel(),
      contextUsed: contextUsedStatusLabel(),
      contextRemainingTokens: contextRemainingTokensLabel(),
      contextUsedPercent: contextUsedPercentLabel(),
      contextWindow: t("ui.ctx.window") + (state.contextWindowTokens > 0 ? count(state.contextWindowTokens) : "—") + t("ui.tokens"),
      fiveHour: t("ui.5h.used") + (state.fiveHourUsedPercent === undefined ? "—" : formatPercent(state.fiveHourUsedPercent)),
      fiveHourRemaining: t("ui.5h.left") + (state.fiveHourUsedPercent === undefined ? "—" : formatPercent(100 - state.fiveHourUsedPercent)),
      weekly: t("ui.wk.used") + (state.weeklyUsedPercent === undefined ? "—" : formatPercent(state.weeklyUsedPercent)),
      weeklyRemaining: t("ui.wk.left") + (state.weeklyUsedPercent === undefined ? "—" : formatPercent(100 - state.weeklyUsedPercent)),
      fiveHourReset: t("ui.5h.reset") + formatResetsAt(state.fiveHourResetsAt),
      weeklyReset: t("ui.wk.reset") + formatResetsAt(state.weeklyResetsAt),
      elapsed: state.running && state.runStartedAt ? t("ui.elapsed") + formatElapsed(Math.max(0, Date.now() - state.runStartedAt)) : t("ui.elapsed.54e60c"),
      queue: t("ui.queue") + Math.max(state.queueCount, (state.pendingRequests || []).length),
      runtime: state.runtimeAvailable ? t("ui.runtime.online") : t("ui.runtime.offline"),
      model: t("ui.model.b32422") + (supported.model ? host.chatAgentSettings.effectiveAgentValue("main", "model") || t("ui.default") : t("ui.unknown")),
      reasoning: t("ui.reasoning.529e9c") + (supported.reasoning ? reasoningDisplayLabel(host.chatAgentSettings.effectiveAgentValue("main", "reasoningEffort")) : t("ui.unknown")),
      fast: t("ui.fast.314aef") + (supported.fast ? state.fastMode ? t("ui.on") : t("ui.off") : t("ui.unknown")),
      task: main ? t("ui.task") + taskModeNames()[enterAction()]?.replaceAll(t("ui.verification"), t("ui.verify")) : t("ui.task.main.only"),
      execution: t("ui.perms") + (executionLabels[state.executionMode] || "—"),
      goal: !main ? t("ui.goal.main.only") : host.goalError ? t("ui.goal.0c4444") : host.nativeGoal ? t("ui.goal.8c9d70") + (goalLabels[host.nativeGoal.status] || "—") : t("ui.goal.8c9d70") + t("ui.off"),
      goalTokens: t("ui.goal.used") + (main && !host.goalError ? count(host.nativeGoal?.tokensUsed) : "—") + t("ui.tokens"),
      goalBudget: t("ui.goal.budget") + (main && !host.goalError ? count(host.nativeGoal?.tokenBudget) : "—") + t("ui.tokens"),
      goalTime: t("ui.goal.time") + (main && !host.goalError && safeCountOrUndefined(host.nativeGoal?.timeUsedSeconds) !== undefined ? formatElapsed(host.nativeGoal.timeUsedSeconds * 1000) : "—")
    };
    return labels[itemId] || itemId;
  }

  return {
    renderStatusBar, closeStatusSettings, renderStatusCatalog, statusLabel, refreshStatusPreview,
    setStatusItems
  };
};
