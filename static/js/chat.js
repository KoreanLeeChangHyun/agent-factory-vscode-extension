(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const timeline = document.getElementById("timeline");
  const emptyState = document.getElementById("empty-state");
  const prompt = document.getElementById("prompt");
  const sendButton = document.getElementById("send-button");
  const stopButton = document.getElementById("stop-button");
  const attachButton = document.getElementById("attach-button");
  const modelReasoningButton = document.getElementById("model-reasoning-button");
  const modelReasoningLabel = document.getElementById("model-reasoning-label");
  const fastModeButton = document.getElementById("fast-mode-button");
  const goalModeButton = document.getElementById("goal-mode-button");
  const resumeButton = document.getElementById("resume-button");
  const attachmentList = document.getElementById("attachment-list");
  const statusBar = document.getElementById("status-bar");
  const dropOverlay = document.getElementById("drop-overlay");

  const saved = vscode.getState();
  const state = {
    panelId: typeof saved?.panelId === "string" ? saved.panelId : undefined,
    title: typeof saved?.title === "string" ? saved.title : "Main Agent",
    draft: typeof saved?.draft === "string" ? saved.draft : "",
    attachments: Array.isArray(saved?.attachments) ? saved.attachments : [],
    timeline: Array.isArray(saved?.timeline) ? saved.timeline : [],
    statusItems: Array.isArray(saved?.statusItems) ? saved.statusItems : [],
    projectName: typeof saved?.projectName === "string" ? saved.projectName : "",
    runtimeAvailable: saved?.runtimeAvailable === true,
    running: saved?.running === true,
    model: normalizeSettingValue(saved?.model),
    reasoning: normalizeSettingValue(saved?.reasoning),
    fastMode: saved?.fastMode === true,
    goalMode: saved?.goalMode === true,
    workUnits: {
      activeUnits: Number.isInteger(saved?.workUnits?.activeUnits) ? saved.workUnits.activeUnits : 0,
      workActive: Number.isInteger(saved?.workUnits?.workActive) ? saved.workUnits.workActive : 0,
      verificationActive: Number.isInteger(saved?.workUnits?.verificationActive) ? saved.workUnits.verificationActive : 0,
      totalCalled: Number.isInteger(saved?.workUnits?.totalCalled) ? saved.workUnits.totalCalled : 0
    }
  };

  prompt.value = state.draft;
  renderAll();
  resizePrompt();
  vscode.postMessage({ type: "client.ready" });

  prompt.addEventListener("input", function () {
    state.draft = prompt.value;
    persist();
    resizePrompt();
    updateSendButton();
  });

  prompt.addEventListener("keydown", function (event) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      !event.nativeEvent?.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  });

  sendButton.addEventListener("click", submit);
  stopButton.addEventListener("click", cancelRun);
  attachButton.addEventListener("click", function () {
    vscode.postMessage({ type: "attachments.pick" });
  });
  modelReasoningButton.addEventListener("click", function () {
    vscode.postMessage({ type: "settings.open" });
  });
  fastModeButton.addEventListener("click", function () {
    toggleMode("fastMode");
  });
  goalModeButton.addEventListener("click", function () {
    toggleMode("goalMode");
  });
  resumeButton.addEventListener("click", function () {
    vscode.postMessage({ type: "resume.request" });
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRun();
    }
  });

  document.addEventListener("paste", function (event) {
    if (!event.clipboardData) {
      return;
    }
    const images = Array.from(event.clipboardData.files).filter(function (file) {
      return file.type.startsWith("image/");
    });
    if (!images.length) {
      return;
    }
    event.preventDefault();
    addAttachments(images.map(fileToAttachment));
  });

  let dragDepth = 0;
  document.addEventListener("dragenter", function (event) {
    if (!hasAttachmentData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    dropOverlay.hidden = false;
  });
  document.addEventListener("dragover", function (event) {
    if (!hasAttachmentData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  });
  document.addEventListener("dragleave", function (event) {
    if (!hasAttachmentData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropOverlay.hidden = true;
    }
  });
  document.addEventListener("drop", function (event) {
    if (!hasAttachmentData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    addDroppedData(event.dataTransfer);
  });

  window.addEventListener("message", function (event) {
    const message = event.data;
    if (!message || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "host.initialize":
        state.panelId = message.panelId;
        state.title = message.title;
        state.projectName = message.projectName;
        state.runtimeAvailable = message.runtimeAvailable === true;
        state.running = message.running === true;
        if (!state.statusItems.length) {
          state.statusItems = Array.isArray(message.statusItems) ? message.statusItems : [];
        }
        renderStatusBar();
        updateRunControls();
        persist();
        break;
      case "attachments.add":
        if (Array.isArray(message.attachments)) {
          addAttachments(message.attachments);
        }
        break;
      case "host.notice":
        appendNotice(message.level, message.text);
        break;
      case "status.updated":
        if (Array.isArray(message.items)) {
          state.statusItems = message.items;
          renderStatusBar();
          persist();
        }
        break;
      case "chat.renamed":
        if (typeof message.title === "string" && message.title) {
          state.title = message.title;
          document.title = message.title;
          renderStatusBar();
          persist();
        }
        break;
      case "run.state":
        state.running = message.running === true;
        updateRunControls();
        renderStatusBar();
        persist();
        break;
      case "workUnits.summary":
        state.workUnits = {
          activeUnits: safeCount(message.activeUnits),
          workActive: safeCount(message.workActive),
          verificationActive: safeCount(message.verificationActive),
          totalCalled: safeCount(message.totalCalled)
        };
        renderStatusBar();
        persist();
        break;
    }
  });

  function submit() {
    const text = prompt.value.trim();
    if (!text) {
      return;
    }
    const message = {
      id: createId(),
      text,
      attachments: state.attachments.slice(),
      execution: {
        fast: state.fastMode,
        goal: state.goalMode
      }
    };
    state.timeline.push({ type: "user", id: message.id, text: message.text });
    state.draft = "";
    state.attachments = [];
    prompt.value = "";
    renderAll();
    resizePrompt();
    persist();
    vscode.postMessage({ type: "chat.send", ...message });
    if (state.goalMode) {
      state.goalMode = false;
      updateModeControls();
      renderStatusBar();
      persist();
    }
  }

  function cancelRun() {
    if (!state.running) {
      return;
    }
    vscode.postMessage({ type: "run.cancel" });
  }

  function appendNotice(level, text) {
    if (typeof text !== "string" || !text) {
      return;
    }
    state.timeline.push({ type: "notice", id: createId(), level, text });
    renderTimeline();
    persist();
  }

  function addAttachments(attachments) {
    const existing = new Set(state.attachments.map(function (item) {
      return item.uri || item.name + ":" + item.size;
    }));
    for (const attachment of attachments) {
      const key = attachment.uri || attachment.name + ":" + attachment.size;
      if (!existing.has(key) && state.attachments.length < 100) {
        state.attachments.push(attachment);
        existing.add(key);
      }
    }
    renderAttachments();
    persist();
  }

  function addDroppedData(dataTransfer) {
    if (!dataTransfer) {
      return;
    }
    const files = Array.from(dataTransfer.files || []);
    const attachments = files.map(function (file, index) {
      const item = dataTransfer.items?.[index];
      const entry = item?.webkitGetAsEntry?.();
      return fileToAttachment(file, entry?.isDirectory === true ? "folder" : undefined);
    });

    const uriList = dataTransfer.getData("text/uri-list");
    for (const uri of uriList.split(/\r?\n/)) {
      if (!uri || uri.startsWith("#")) {
        continue;
      }
      attachments.push({
        id: createId(),
        name: decodeURIComponent(uri.split("/").filter(Boolean).at(-1) || uri),
        kind: "file",
        uri
      });
    }
    addAttachments(attachments);
  }

  function hasAttachmentData(dataTransfer) {
    if (!dataTransfer) {
      return false;
    }
    const types = Array.from(dataTransfer.types || []);
    return types.includes("Files") || types.includes("text/uri-list");
  }

  function fileToAttachment(file, forcedKind) {
    return {
      id: createId(),
      name: file.name || "attachment",
      kind: forcedKind || (file.type.startsWith("image/") ? "image" : "file"),
      mediaType: file.type || undefined,
      size: Number.isFinite(file.size) ? file.size : undefined
    };
  }

  function renderAll() {
    renderTimeline();
    renderAttachments();
    renderStatusBar();
    updateSendButton();
    updateRunControls();
    updateModeControls();
  }

  function renderTimeline() {
    timeline.querySelectorAll(".message").forEach(function (element) {
      element.remove();
    });
    emptyState.hidden = state.timeline.length > 0;
    for (const event of state.timeline) {
      const message = document.createElement("article");
      message.className = "message message-" + event.type;
      message.dataset.id = event.id;
      const content = document.createElement("div");
      content.className = "message-content";
      if (event.type === "notice") {
        message.dataset.level = event.level || "info";
        const mark = document.createElement("span");
        mark.className = "notice-mark";
        mark.textContent = event.level === "error" ? "×" : event.level === "warning" ? "!" : "i";
        const text = document.createElement("span");
        text.textContent = event.text;
        content.append(mark, text);
      } else {
        content.textContent = event.text;
      }
      message.append(content);
      timeline.append(message);
    }
    requestAnimationFrame(function () {
      timeline.scrollTop = timeline.scrollHeight;
    });
  }

  function renderAttachments() {
    attachmentList.replaceChildren();
    for (const attachment of state.attachments) {
      const chip = document.createElement("div");
      chip.className = "attachment-chip";
      chip.title = attachment.uri || attachment.name;
      const name = document.createElement("span");
      name.className = "attachment-chip-name";
      name.textContent = attachment.name;
      const remove = document.createElement("button");
      remove.className = "attachment-remove";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", attachment.name + " 첨부 제거");
      remove.addEventListener("click", function () {
        state.attachments = state.attachments.filter(function (item) {
          return item.id !== attachment.id;
        });
        renderAttachments();
        persist();
      });
      chip.append(name, remove);
      attachmentList.append(chip);
    }
  }

  function renderStatusBar() {
    statusBar.replaceChildren();
    for (const itemId of state.statusItems) {
      const item = document.createElement("span");
      item.className = "status-item";
      if (itemId === "runtime" && !state.runtimeAvailable) {
        item.classList.add("runtime-offline");
      }
      item.draggable = true;
      item.tabIndex = 0;
      item.dataset.itemId = itemId;
      item.textContent = statusLabel(itemId);
      if (itemId === "agents") {
        item.classList.add("work-unit-activity");
        item.dataset.active = String(state.workUnits.activeUnits > 0);
        item.title = "활성 Work Unit " + state.workUnits.activeUnits + " · 누적 " + state.workUnits.totalCalled;
      }
      if (itemId === "model" || itemId === "reasoning") {
        item.classList.add("selectable");
        item.addEventListener("click", function () {
          vscode.postMessage({ type: "settings.open" });
        });
      }
      if (itemId === "fast" || itemId === "goal") {
        item.classList.add("selectable");
        item.addEventListener("click", function () {
          toggleMode(itemId === "fast" ? "fastMode" : "goalMode");
        });
      }
      item.addEventListener("dragstart", function (event) {
        item.classList.add("dragging");
        event.dataTransfer?.setData("text/status-item", itemId);
      });
      item.addEventListener("dragend", function () {
        item.classList.remove("dragging");
      });
      item.addEventListener("dragover", function (event) {
        if (event.dataTransfer?.types.includes("text/status-item")) {
          event.preventDefault();
        }
      });
      item.addEventListener("drop", function (event) {
        const sourceId = event.dataTransfer?.getData("text/status-item");
        if (!sourceId || sourceId === itemId) {
          return;
        }
        event.preventDefault();
        reorderStatus(sourceId, itemId);
      });
      statusBar.append(item);
    }
  }

  function reorderStatus(sourceId, targetId) {
    const items = state.statusItems.slice();
    const sourceIndex = items.indexOf(sourceId);
    const targetIndex = items.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) {
      return;
    }
    items.splice(sourceIndex, 1);
    items.splice(targetIndex, 0, sourceId);
    state.statusItems = items;
    renderStatusBar();
    persist();
    vscode.postMessage({ type: "status.reorder", items });
  }

  function statusLabel(itemId) {
    const labels = {
      agent: state.title,
      status: state.runtimeAvailable ? "대기 중" : "연결 대기",
      agents: "Units " + state.workUnits.activeUnits + " · Work " + state.workUnits.workActive + " · Verify " + state.workUnits.verificationActive,
      model: "Model " + (state.model || "기본값"),
      reasoning: "Reasoning " + (state.reasoning || "기본값"),
      fast: "Fast " + (state.fastMode ? "On" : "Off"),
      goal: "Goal " + (state.goalMode ? "On" : "Off"),
      project: state.projectName || "Project —",
      branch: "Branch —",
      context: "Context —",
      elapsed: "00:00",
      queue: "Queue 0",
      runtime: state.runtimeAvailable ? "Runtime 연결됨" : "Runtime 미연결"
    };
    return labels[itemId] || itemId;
  }

  function updateSendButton() {
    sendButton.disabled = prompt.value.trim().length === 0;
  }

  function updateRunControls() {
    stopButton.hidden = !state.running;
  }

  function toggleMode(key) {
    state[key] = !state[key];
    updateModeControls();
    renderStatusBar();
    persist();
  }

  function updateModeControls() {
    fastModeButton.setAttribute("aria-pressed", String(state.fastMode));
    fastModeButton.setAttribute("aria-label", state.fastMode ? "Fast mode on" : "Fast mode off");
    fastModeButton.title = state.fastMode ? "Fast mode on" : "Fast mode off";
    goalModeButton.setAttribute("aria-pressed", String(state.goalMode));
    goalModeButton.setAttribute("aria-label", state.goalMode ? "Goal mode on" : "Goal mode off");
    goalModeButton.title = state.goalMode ? "Goal mode on" : "Goal mode off";
    modelReasoningLabel.textContent = state.model || state.reasoning
      ? (state.model || "Default") + " · " + (state.reasoning || "Default")
      : "Model · Reasoning";
  }

  function resizePrompt() {
    prompt.style.height = "auto";
    prompt.style.height = Math.min(prompt.scrollHeight, 280) + "px";
  }

  function persist() {
    vscode.setState({
      panelId: state.panelId,
      title: state.title,
      draft: state.draft,
      attachments: state.attachments,
      timeline: state.timeline.slice(-200),
      statusItems: state.statusItems,
      projectName: state.projectName,
      runtimeAvailable: state.runtimeAvailable,
      running: state.running,
      model: state.model,
      reasoning: state.reasoning,
      fastMode: state.fastMode,
      goalMode: state.goalMode,
      workUnits: state.workUnits
    });
  }

  function safeCount(value) {
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  function normalizeSettingValue(value) {
    return typeof value === "string" && value !== "—" ? value : "";
  }

  function createId() {
    return globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
})();
