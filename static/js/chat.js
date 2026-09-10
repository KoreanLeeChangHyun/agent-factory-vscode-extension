(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const markdown = typeof globalThis.markdownit === "function"
    ? globalThis.markdownit({ html: false, linkify: true, typographer: false })
    : undefined;
  const timeline = document.getElementById("timeline");
  let commandOutputObserver;
  let commandOutputFrame;
  const emptyState = document.getElementById("empty-state");
  const prompt = document.getElementById("prompt");
  const sendButton = document.getElementById("send-button");
  const sendIcon = document.getElementById("send-icon");
  const stopIcon = document.getElementById("stop-icon");
  const attachButton = document.getElementById("attach-button");
  const modelButton = document.getElementById("model-button");
  const modelLabel = document.getElementById("model-label");
  const modelMenu = document.getElementById("model-menu");
  const reasoningButton = document.getElementById("reasoning-button");
  const reasoningLabel = document.getElementById("reasoning-label");
  const reasoningMenu = document.getElementById("reasoning-menu");
  const executionModeButton = document.getElementById("execution-mode-button");
  const executionModeLabel = document.getElementById("execution-mode-label");
  const executionModeMenu = document.getElementById("execution-mode-menu");
  const fastModeButton = document.getElementById("fast-mode-button");
  const goalModeButton = document.getElementById("goal-mode-button");
  const goalPanel = document.getElementById("goal-panel");
  const goalObjective = document.getElementById("goal-objective");
  const goalStatus = document.getElementById("goal-status");
  let nativeGoal = null;
  let goalError;
  goalPanel.addEventListener("click", function (event) {
    const action = event.target.closest("[data-goal-action]")?.dataset.goalAction;
    if (action && state.agentId) vscode.postMessage({ type: "goal.control", action });
  });
  const sessionButton = document.getElementById("session-button");
  const sessionMenu = document.getElementById("session-menu");
  const sessionList = document.getElementById("session-list");
  const questionButton = document.getElementById("question-button");
  const questionMenu = document.getElementById("question-menu");
  const questionList = document.getElementById("question-list");
  const runStatus = document.getElementById("run-status");
  const runStatusLabel = document.getElementById("run-status-label");
  const runElapsed = document.getElementById("run-elapsed");
  const attachmentList = document.getElementById("attachment-list");
  const statusBar = document.getElementById("status-bar");
  const agentsMenu = document.getElementById("agents-menu");
  const agentsList = document.getElementById("agents-list");
  const dropOverlay = document.getElementById("drop-overlay");
  const settingOptions = {
    model: [""],
    reasoning: ["", "none", "low", "medium", "high", "xhigh", "max"],
    execution: ["cli-default", "workspace-write", "danger-full-access", "bypass"]
  };
  const composerStatusItems = new Set(["model", "reasoning", "fast", "goal"]);
  const longPasteThreshold = 8_000;
  let openSettingId;

  const saved = vscode.getState();
  const state = {
    panelId: typeof saved?.panelId === "string" ? saved.panelId : undefined,
    agentId: typeof saved?.agentId === "string" ? saved.agentId : undefined,
    title: typeof saved?.title === "string" ? saved.title : "Main Agent",
    role: ["main", "work", "verification"].includes(saved?.role) ? saved.role : "main",
    verifiedWorkRunId: typeof saved?.verifiedWorkRunId === "string" ? saved.verifiedWorkRunId : undefined,
    draft: typeof saved?.draft === "string" ? saved.draft : "",
    attachments: Array.isArray(saved?.attachments) ? saved.attachments : [],
    timeline: collapseAdjacentReads(Array.isArray(saved?.timeline) ? saved.timeline : []),
    statusItems: normalizeStatusItems(saved?.statusItems),
    projectName: typeof saved?.projectName === "string" ? saved.projectName : "",
    pendingDecisionRunId: undefined,
    decisionSubmitting: false,
    executionMode: saved?.agentId ? undefined : "danger-full-access",
    runtimeAvailable: false,
    branch: undefined,
    capabilities: undefined,
    running: saved?.running === true,
    model: normalizeModel(saved?.model),
    reasoning: normalizeSettingValue(saved?.reasoning, settingOptions.reasoning),
    fastMode: saved?.fastMode === true,
    goalMode: saved?.goalMode === true,
    contextUsedTokens: safeCountOrUndefined(saved?.contextUsedTokens),
    contextWindowTokens: safeCountOrUndefined(saved?.contextWindowTokens),
    runProgress: typeof saved?.runProgress === "string" ? saved.runProgress : "",
    runStartedAt: Number.isFinite(saved?.runStartedAt) ? saved.runStartedAt : undefined,
    sessions: [],
    sessionsLoading: false,
    childAgents: Array.isArray(saved?.childAgents) ? saved.childAgents : [],
    agentsLoading: false,
    workUnits: {
      activeUnits: Number.isInteger(saved?.workUnits?.activeUnits) ? saved.workUnits.activeUnits : 0,
      workActive: Number.isInteger(saved?.workUnits?.workActive) ? saved.workUnits.workActive : 0,
      verificationActive: Number.isInteger(saved?.workUnits?.verificationActive) ? saved.workUnits.verificationActive : 0,
      totalCalled: Number.isInteger(saved?.workUnits?.totalCalled) ? saved.workUnits.totalCalled : 0
    }
  };
  let syntaxRevision = 0;
  let themeUpdate = 0;
  let elapsedTimerId;
  let followLatest = true;

  prompt.value = state.draft;
  renderAll();
  resizePrompt();
  vscode.postMessage({ type: "client.ready" });

  let syntaxThemeClass = document.body.className;
  new MutationObserver(function () {
    const nextThemeClass = document.body.className;
    if (nextThemeClass === syntaxThemeClass) return;
    syntaxThemeClass = nextThemeClass;
    syntaxRevision += 1;
    renderTimeline();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

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

  sendButton.addEventListener("click", function () {
    if (state.running) {
      cancelRun();
    } else {
      submit();
    }
  });
  attachButton.addEventListener("click", function () {
    vscode.postMessage({ type: "attachments.pick" });
  });
  modelButton.addEventListener("click", function () {
    openSetting("model");
  });
  reasoningButton.addEventListener("click", function () {
    openSetting("reasoning");
  });
  executionModeButton?.addEventListener("click", function () {
    openSetting("execution");
  });
  fastModeButton.addEventListener("click", function () {
    toggleMode("fastMode");
  });
  goalModeButton.addEventListener("click", function () {
    toggleMode("goalMode");
    if (!state.goalMode && nativeGoal && state.agentId) {
      vscode.postMessage({ type: "goal.control", action: "disable" });
    }
  });
  sessionButton.addEventListener("click", function () {
    if (sessionMenu.hidden) {
      openSessionMenu();
    } else {
      closeSessionMenu(true);
    }
  });
  questionButton.addEventListener("click", function () {
    if (questionMenu.hidden) {
      openQuestionMenu();
    } else {
      closeQuestionMenu(true);
    }
  });

  timeline.addEventListener("scroll", function () {
    followLatest = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 24;
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      if (!sessionMenu.hidden) {
        event.preventDefault();
        closeSessionMenu(true);
        return;
      }
      if (!questionMenu.hidden) {
        event.preventDefault();
        closeQuestionMenu(true);
        return;
      }
      if (openSettingId) {
        event.preventDefault();
        closeSettingMenu(true);
        return;
      }
      if (!agentsMenu.hidden) {
        event.preventDefault();
        closeAgentsMenu();
        return;
      }
      event.preventDefault();
      cancelRun();
    }
  });

  document.addEventListener("click", function (event) {
    if (openSettingId && !event.target.closest(".setting-control")) {
      closeSettingMenu(false);
    }
    if (!sessionMenu.hidden && !event.target.closest(".session-picker")) {
      closeSessionMenu(false);
    }
    if (!questionMenu.hidden && !event.target.closest(".question-picker")) {
      closeQuestionMenu(false);
    }
    if (!agentsMenu.hidden && !event.target.closest(".agents-menu") && !event.target.closest(".work-unit-activity")) {
      closeAgentsMenu();
    }
  });

  document.addEventListener("paste", function (event) {
    if (!event.clipboardData) {
      return;
    }
    const images = Array.from(event.clipboardData.files).filter(function (file) {
      return file.type.startsWith("image/");
    });
    if (images.length) {
      event.preventDefault();
      addAttachments(images.map(fileToAttachment));
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (event.target === prompt && text.length >= longPasteThreshold) {
      event.preventDefault();
      vscode.postMessage({ type: "attachments.createText", text });
    }
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
        state.role = ["main", "work", "verification"].includes(message.role) ? message.role : "main";
        state.verifiedWorkRunId = typeof message.verifiedWorkRunId === "string" ? message.verifiedWorkRunId : undefined;
        document.body.dataset.agentRole = state.role;
        state.projectName = message.projectName;
        state.runtimeAvailable = message.runtimeAvailable === true;
        state.capabilities = message.capabilities;
        if (currentCapabilities().diagnostic) appendNotice("warning", currentCapabilities().diagnostic);
        state.running = message.running === true;
        state.model = normalizeModel(message.model);
        state.reasoning = normalizeSettingValue(message.reasoning, settingOptions.reasoning);
        state.fastMode = message.fastMode === true;
        state.goalMode = message.goalMode === true;
        state.contextUsedTokens = safeCountOrUndefined(message.contextUsedTokens);
        state.contextWindowTokens = safeCountOrUndefined(message.contextWindowTokens);
        if (state.running && !state.runStartedAt) {
          state.runStartedAt = Date.now();
        } else if (!state.running) {
          state.runStartedAt = undefined;
        }
        if (!state.statusItems.length) {
          state.statusItems = normalizeStatusItems(message.statusItems);
        }
        updateModeControls();
        if (state.agentId && state.role === "main") vscode.postMessage({ type: "goal.control", action: "get" });
        renderTimeline();
        renderStatusBar();
        updateRunControls();
        persist();
        break;
      case "syntax.theme":
        void updateSyntaxTheme(message.selection || {});
        break;
      case "branch.updated":
        state.branch = typeof message.branch === "string" ? message.branch : undefined;
        renderStatusBar();
        break;
      case "goal.updated":
        nativeGoal = message.goal || null;
        goalError = message.error;
        if (nativeGoal) state.goalMode = true;
        else if (!goalError) state.goalMode = false;
        renderGoal();
        updateModeControls();
        persist();
        break;
      case "capabilities.updated":
        state.capabilities = message.capabilities;
        updateModeControls();
        break;
      case "models.list":
        if (Array.isArray(message.models)) {
          settingOptions.model = ["", ...new Set(message.models.map(normalizeModel).filter(Boolean))];
          if (openSettingId === "model") {
            const focused = modelMenu.contains(document.activeElement) ? document.activeElement.dataset.value : undefined;
            renderSettingMenu("model", modelMenu);
            if (focused !== undefined) {
              const options = Array.from(modelMenu.querySelectorAll("button"));
              (options.find((option) => option.dataset.value === focused) || options[0])?.focus();
            }
          }
        }
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
          state.statusItems = normalizeStatusItems(message.items);
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
      case "session.bound":
        if (typeof message.agentId === "string" && message.agentId) {
          state.agentId = message.agentId;
          if (message.reset === true) {
            state.pendingDecisionRunId = undefined;
            state.decisionSubmitting = false;
            state.timeline = [];
            followLatest = true;
            renderTimeline();
          }
          updateSessionControl();
          updateModeControls();
          closeSessionMenu(false);
          persist();
        }
        break;
      case "sessions.open":
        openSessionMenu();
        break;
      case "sessions.list":
        state.sessionsLoading = false;
        state.sessions = Array.isArray(message.sessions) ? message.sessions.filter(function (session) {
          return session && typeof session.agentId === "string" && session.agentId;
        }) : [];
        renderSessionList();
        break;
      case "agents.list":
        state.agentsLoading = false;
        state.childAgents = Array.isArray(message.agents) ? message.agents.filter(isChildAgent) : [];
        state.workUnits = summarizeChildAgents(state.childAgents);
        renderAgentsList();
        renderTimeline();
        renderStatusBar();
        persist();
        break;
      case "decision.pending":
        state.pendingDecisionRunId = typeof message.runId === "string" ? message.runId : undefined;
        state.decisionSubmitting = false;
        renderTimeline();
        break;
      case "chat.human-decision":
        if (typeof message.text === "string" && message.text) {
          state.timeline.push({ type: "user", id: createId(), text: message.text });
          followLatest = true;
          renderTimeline();
          persist();
        }
        break;
      case "execution.updated":
        state.executionMode = message.mode;
        updateExecutionControl();
        break;
      case "chat.assistant":
        if (typeof message.text === "string" && message.text) {
          state.timeline.push({ type: "assistant", id: createId(), text: message.text, runId: message.runId, phase: message.phase === "commentary" ? "commentary" : "final" });
          renderTimeline();
          persist();
        }
        break;
      case "run.state":
        state.running = message.running === true;
        state.runProgress = state.running ? (state.runProgress || "Main Agent 시작 중") : "";
        if (state.running && !state.runStartedAt) {
          state.runStartedAt = Date.now();
        } else if (!state.running) {
          state.runStartedAt = undefined;
        }
        updateRunControls();
        renderTimeline();
        renderStatusBar();
        persist();
        break;
      case "run.progress":
        if (typeof message.text === "string" && message.text) {
          state.runProgress = message.text;
          renderRunStatus();
          persist();
        }
        break;
      case "context.usage":
        if (Number.isSafeInteger(message.usedTokens) && Number.isSafeInteger(message.contextWindowTokens)) {
          state.contextUsedTokens = Math.max(0, message.usedTokens);
          state.contextWindowTokens = Math.max(0, message.contextWindowTokens);
          renderStatusBar();
          persist();
        }
        break;
      case "run.activity":
        if (
          typeof message.id === "string" &&
          typeof message.text === "string" &&
          (message.title === undefined || (typeof message.title === "string" && message.title.length <= 200)) &&
          (message.output === undefined || (typeof message.output === "string" && message.output.length <= 32768)) &&
          (message.diff === undefined || (typeof message.diff === "string" && message.diff.length <= 262144)) &&
          ["command", "file", "tool"].includes(message.category) &&
          ["started", "completed", "failed"].includes(message.phase)
        ) {
          upsertActivity(message.id, message.category, message.phase, message.text, message.diff, message.title, message.output);
          persist();
        }
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
    if ((!text && state.attachments.length === 0) || state.running || !state.capabilities || !state.runtimeAvailable) {
      return;
    }
    const message = {
      id: createId(),
      text,
      attachments: state.attachments.slice(),
      execution: {
        model: currentCapabilities().model ? state.model || undefined : undefined,
        reasoningEffort: currentCapabilities().reasoning ? state.reasoning || undefined : undefined,
        fast: currentCapabilities().fast === true && state.fastMode,
        goal: state.role === "main" && currentCapabilities().goal === true && state.goalMode,
        ...(state.role === "main" && state.goalMode && goalObjective.value.trim() ? { goalObjective: goalObjective.value.trim() } : {})
      }
    };
    if (message.execution.goal && !nativeGoal && !message.execution.goalObjective && text.length > 4000) {
      appendNotice("error", "긴 요청에는 4,000자 이내의 목표를 입력하세요.");
      return;
    }
    goalObjective.value = "";
    state.pendingDecisionRunId = undefined;
    state.decisionSubmitting = false;
    state.timeline.push({
      type: "user",
      id: message.id,
      text: message.text || state.attachments.map(function (attachment) { return "첨부: " + attachment.name; }).join("\n")
    });
    state.draft = "";
    state.attachments = [];
    state.running = true;
    state.runProgress = "Main Agent 시작 중";
    state.runStartedAt = Date.now();
    followLatest = true;
    prompt.value = "";
    renderAll();
    resizePrompt();
    persist();
    vscode.postMessage({ type: "chat.send", ...message });
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

  function upsertActivity(id, category, phase, text, diff, title, output) {
    let existing = state.timeline.find(function (event) {
      return event.type === "activity" && event.id === id;
    });
    if (!existing) {
      const previous = state.timeline[state.timeline.length - 1];
      const incoming = { type: "activity", category, title };
      if (sameReadActivity(previous, incoming)) {
        existing = previous;
      }
    }
    if (existing) {
      existing.category = category;
      existing.phase = phase;
      existing.text = text;
      existing.diff = diff;
      existing.title = title;
      existing.output = output;
    } else {
      state.timeline.push({ type: "activity", id, category, phase, text, diff, title, output });
    }
    renderTimeline();
  }

  function collapseAdjacentReads(events) {
    const collapsed = [];
    for (const savedEvent of events) {
      const event = normalizeSavedReadActivity(savedEvent);
      if (event?.title === "실행 요청 읽기") continue;
      const previous = collapsed[collapsed.length - 1];
      if (sameReadActivity(previous, event)) {
        collapsed[collapsed.length - 1] = { ...event, id: previous.id };
      } else {
        collapsed.push(event);
      }
    }
    return collapsed;
  }

  function normalizeSavedReadActivity(event) {
    if (event?.type !== "activity" || event.category !== "command" || event.title) return event;
    const text = event.text || "";
    if (!/\b(?:cat|head|tail|sed|awk)\b/.test(text)) return event;
    const runDocument = text.match(/\.agent-factory\/agent\/[^/\s'\"]+\/runs\/[^/\s'\"]+\/(request|result)\.md\b/);
    if (runDocument?.[1] === "request") return { ...event, title: "실행 요청 읽기" };
    if (runDocument?.[1] === "result") return { ...event, title: "실행 결과 읽기" };
    return event;
  }

  function sameReadActivity(left, right) {
    return left?.type === "activity" &&
      right?.type === "activity" &&
      left.category === "command" &&
      right.category === "command" &&
      typeof left.title === "string" &&
      isReadActivityTitle(left.title) &&
      left.title === right.title;
  }

  function isReadActivityTitle(title) {
    return title.startsWith("Skill 읽기 · ") ||
      title === "실행 결과 읽기";
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
      } else if (attachment.previewUri?.startsWith("blob:")) {
        URL.revokeObjectURL(attachment.previewUri);
      }
    }
    renderAttachments();
    updateSendButton();
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
    const kind = forcedKind || (file.type.startsWith("image/") ? "image" : "file");
    return {
      id: createId(),
      name: file.name || "attachment",
      kind,
      ...(kind === "image" ? { previewUri: URL.createObjectURL(file) } : {}),
      mediaType: file.type || undefined,
      size: Number.isFinite(file.size) ? file.size : undefined
    };
  }

  function renderAll() {
    renderTimeline();
    renderAttachments();
    renderStatusBar();
    renderRunStatus();
    updateSendButton();
    updateRunControls();
    updateModeControls();
    updateSessionControl();
    updateQuestionControl();
  }

  function renderDecisionActions(content, runId) {
    const actions = document.createElement("div");
    actions.className = "decision-actions";
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "위 제안에 답변");
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "제안대로 진행";
    approve.disabled = state.running || state.decisionSubmitting || !state.runtimeAvailable;
    approve.addEventListener("click", function () {
      if (state.running || state.decisionSubmitting || state.pendingDecisionRunId !== runId) return;
      state.decisionSubmitting = true;
      approve.disabled = true;
      vscode.postMessage({ type: "decision.approve", runId });
    });
    const reply = document.createElement("button");
    reply.type = "button";
    reply.className = "decision-reply";
    reply.textContent = "직접 답변";
    reply.addEventListener("click", function () { prompt.focus(); });
    actions.append(approve, reply);
    content.append(actions);
  }

  function renderTimeline() {
    const shouldFollowLatest = followLatest;
    const previousScroll = timeline.scrollTop;
    const displayStates = new Map();
    let focusedControl;
    for (const element of timeline.querySelectorAll(".message")) {
      const controls = Array.from(element.querySelectorAll(".bash-command-toggle, summary, .execution-reference button"));
      const focusIndex = controls.indexOf(document.activeElement);
      if (focusIndex >= 0) focusedControl = { id: element.dataset.id, index: focusIndex };
      displayStates.set(element.dataset.id, {
        expanded: element.querySelector(".bash-command-toggle")?.getAttribute("aria-expanded") === "true",
        details: Array.from(element.querySelectorAll("details")).map(function (details) { return { className: details.className, open: details.open }; }),
        scroll: Array.from(element.querySelectorAll("pre")).map(function (pre) { return { top: pre.scrollTop, left: pre.scrollLeft }; })
      });
    }
    timeline.querySelectorAll(".message").forEach(function (element) {
      element.remove();
    });
    emptyState.hidden = state.timeline.length > 0;
    for (const event of state.timeline) {
      const message = document.createElement("article");
      message.className = "message message-" + event.type;
      message.dataset.id = event.id;
      if (event.type === "assistant") {
        message.classList.add(event.phase === "commentary" ? "message-commentary" : "message-final");
      }
      if (event.type === "user") {
        message.tabIndex = -1;
      }
      if (event.type === "activity") {
        message.classList.add("message-activity-" + (event.category || "tool"));
        message.dataset.category = event.category || "tool";
        message.dataset.phase = event.phase || "started";
      }
      if (event.type === "user" || event.type === "assistant") {
        const marker = event.type === "user" ? document.createElement("span") : createTranscriptDot();
        marker.classList.add("transcript-marker");
        marker.setAttribute("aria-hidden", "true");
        if (event.type === "user") marker.textContent = "›";
        message.append(marker);
      }
      if (event.type === "activity" && event.category !== "command" && !(event.category === "file" && event.diff)) {
        const heading = document.createElement("div");
        heading.className = "message-heading";
        const kind = document.createElement("span");
        kind.className = "message-kind";
        kind.textContent = event.title || activityKindLabel(event.category);
        heading.append(createActivityPhase(event.phase), kind);
        message.append(heading);
      }
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
      } else if (event.type === "assistant") {
        const extracted = event.phase !== "commentary" && globalThis.agentFactoryExecutionReferences
          ? globalThis.agentFactoryExecutionReferences.extract(event.text, markdown)
          : { text: event.text, references: [] };
        if (extracted.references.length) {
          renderAssistantMarkdown(content, extracted.before);
          renderExecutionReferences(content, extracted.references);
          appendAssistantMarkdown(content, extracted.after);
        } else {
          renderAssistantMarkdown(content, extracted.text);
        }
        if (event.runId && event.runId === state.pendingDecisionRunId && event.phase !== "commentary") {
          renderDecisionActions(content, event.runId);
        }
      } else if (event.type === "activity" && event.category === "command") {
        renderTerminalCommand(content, event.text, event.phase, event.title);
        renderCommandOutput(content, event.output, Boolean(event.title));
      } else if (event.type === "activity" && event.category === "file" && event.diff) {
        renderGitDiff(content, event.diff, event.text, event.phase);
      } else {
        content.textContent = event.text;
      }
      message.append(content);
      timeline.append(message);
      const display = displayStates.get(event.id);
      if (display) {
        const toggle = message.querySelector(".bash-command-toggle");
        const command = message.querySelector(".bash-command-text");
        if (toggle && command && display.expanded) setCommandExpanded(command, toggle, true);
        for (const details of message.querySelectorAll("details")) {
          const previous = display.details.find(function (item) { return item.className === details.className; });
          if (previous) details.open = previous.open;
        }
        message.querySelectorAll("pre").forEach(function (pre, index) {
          if (display.scroll[index]) {
            pre.scrollTop = display.scroll[index].top;
            pre.scrollLeft = display.scroll[index].left;
          }
        });
      }
      if (focusedControl?.id === event.id) {
        const control = message.querySelectorAll(".bash-command-toggle, summary, .execution-reference button")[focusedControl.index];
        if (control) {
          if (control.classList.contains("bash-command-toggle")) control.hidden = false;
          control.focus({ preventScroll: true });
        }
      }
    }
    if (!shouldFollowLatest) timeline.scrollTop = previousScroll;
    updateQuestionControl();
    timeline.setAttribute("aria-busy", String(state.running));
    if (shouldFollowLatest) {
      requestAnimationFrame(function () {
        timeline.scrollTop = timeline.scrollHeight;
      });
    }
  }

  function activityKindLabel(category) {
    if (category === "file") return "Git 변경";
    return "도구 실행";
  }

  function createTranscriptDot() {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    dot.setAttribute("viewBox", "0 0 16 24");
    dot.setAttribute("focusable", "false");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "4");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "2");
    circle.setAttribute("fill", "currentColor");
    dot.append(circle);
    return dot;
  }

  function createActivityPhase(phaseValue) {
    const phase = createTranscriptDot();
    phase.setAttribute("class", "message-phase message-phase-" + (phaseValue || "started"));
    phase.setAttribute("role", "img");
    phase.setAttribute("aria-label", activityPhaseAccessibleLabel(phaseValue));
    return phase;
  }

  function activityPhaseAccessibleLabel(phase) {
    if (phase === "completed") return "성공";
    if (phase === "failed") return "실패";
    return "진행 중";
  }

  function renderTerminalCommand(container, command, phaseValue, title) {
    container.classList.add("terminal-command-content");
    const row = document.createElement("div");
    row.className = "terminal-command-row";
    const prompt = document.createElement("span");
    prompt.className = "terminal-command-prompt";
    prompt.textContent = phaseValue === "failed" ? "Failed " : phaseValue === "completed" ? "Ran " : "Running ";
    const text = document.createElement("div");
    text.className = "bash-command-text";
    if (title) {
      const context = document.createElement("span");
      context.className = "terminal-command-context";
      context.textContent = readActivityDisplayTitle(title, phaseValue);
      context.title = command;
      text.append(context);
      row.append(createActivityPhase(phaseValue), text);
      container.append(row);
      return;
    }
    const commandCode = document.createElement("span");
    commandCode.className = "syntax-code";
    commandCode.textContent = command;
    text.append(prompt, commandCode);
    row.append(createActivityPhase(phaseValue), text);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "bash-command-toggle";
    toggle.textContent = "펼치기";
    toggle.setAttribute("aria-label", "전체 명령 펼치기");
    toggle.setAttribute("aria-expanded", "false");
    toggle.hidden = true;
    toggle.addEventListener("click", function () {
      setCommandExpanded(text, toggle, !text.classList.contains("is-expanded"));
    });
    const commandBlock = document.createElement("div");
    commandBlock.className = "terminal-command-block";
    commandBlock.append(row, toggle);
    container.append(commandBlock);
    requestAnimationFrame(function () {
      toggle.hidden = !text.classList.contains("is-expanded") && text.scrollHeight <= text.clientHeight + 1;
    });
    void applySyntaxHighlighting(commandCode, command, "bash").then(function () {
      requestAnimationFrame(function () {
        toggle.hidden = !text.classList.contains("is-expanded") && text.scrollHeight <= text.clientHeight + 1;
      });
    });
  }

  function setCommandExpanded(text, toggle, expanded) {
    text.classList.toggle("is-expanded", expanded);
    toggle.classList.toggle("is-expanded", expanded);
    toggle.textContent = expanded ? "접기" : "펼치기";
    toggle.setAttribute("aria-label", expanded ? "명령 접기" : "전체 명령 펼치기");
    toggle.setAttribute("aria-expanded", String(expanded));
    if (expanded) toggle.hidden = false;
  }

  function readActivityDisplayTitle(title, phase) {
    if (phase !== "started") return title;
    if (title.startsWith("Skill 읽기 · ")) return title.replace("Skill 읽기 · ", "Skill 읽는 중 · ");
    if (title === "실행 결과 읽기") return "실행 결과 읽는 중";
    return title;
  }

  function createCommandOutput(text) {
    const output = document.createElement("pre");
    output.className = "terminal-command-output";
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    marker.setAttribute("viewBox", "0 0 16 24");
    marker.setAttribute("aria-hidden", "true");
    marker.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M4 3v9h7");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    marker.append(path);
    output.append(marker, globalThis.agentFactoryAnsi
      ? globalThis.agentFactoryAnsi.render(text, document)
      : document.createTextNode(text));
    return output;
  }

  function renderCommandOutput(container, output, collapsed) {
    if (typeof output !== "string") return;
    const block = document.createElement("div");
    block.className = "terminal-output-block";
    block.classList.toggle("terminal-output-collapsed", collapsed);
    const preview = createCommandOutput(output || "(no output)");
    preview.classList.add("terminal-output-preview");
    const details = document.createElement("details");
    details.className = "terminal-output-details";
    const summary = document.createElement("summary");
    summary.textContent = "실행 결과 보기";
    details.append(summary, createCommandOutput(output || "(no output)"));
    details.addEventListener("toggle", scheduleCommandOutputMeasurement);
    block.append(preview, details);
    container.append(block);
    if (!commandOutputObserver) {
      commandOutputObserver = new ResizeObserver(scheduleCommandOutputMeasurement);
      commandOutputObserver.observe(timeline);
    }
    scheduleCommandOutputMeasurement();
  }

  function scheduleCommandOutputMeasurement() {
    if (commandOutputFrame) return;
    commandOutputFrame = requestAnimationFrame(function () {
      commandOutputFrame = undefined;
      for (const block of timeline.querySelectorAll(".terminal-output-block")) {
        const preview = block.querySelector(".terminal-output-preview");
        const details = block.querySelector(".terminal-output-details");
        details.hidden = !details.open && !block.classList.contains("terminal-output-collapsed") && preview.scrollHeight <= preview.clientHeight + 1;
      }
    });
  }

  function renderGitDiff(container, diff, fallbackText, phaseValue) {
    container.classList.add("git-diff-content");
    const files = parseGitDiff(diff);
    const additions = files.reduce(function (sum, file) { return sum + file.additions; }, 0);
    const deletions = files.reduce(function (sum, file) { return sum + file.deletions; }, 0);
    const overview = document.createElement("div");
    overview.className = "git-diff-overview";
    overview.append(createActivityPhase(phaseValue));
    const label = document.createElement("span");
    label.append(document.createTextNode("Edited " + (files.length === 1 ? files[0].path : (files.length || 1) + " files") + " "));
    const stats = document.createElement("span");
    stats.className = "git-diff-stats";
    stats.append("(", createDiffCount("+" + additions, "addition"), " ", createDiffCount("−" + deletions, "deletion"), ")");
    label.append(stats);
    overview.append(label);
    container.append(overview);

    const list = document.createElement("div");
    list.className = "git-diff-files";
    if (files.length === 0) {
      list.textContent = fallbackText;
    } else {
      files.forEach(function (file) {
        const row = document.createElement("div");
        row.className = "git-diff-file";
        const path = document.createElement("span");
        path.textContent = file.path;
        const count = document.createElement("span");
        count.className = "git-diff-file-stats";
        count.append(createDiffCount("+" + file.additions, "addition"), " ", createDiffCount("−" + file.deletions, "deletion"));
        row.append(path, count);
        list.append(row);
      });
    }
    if (files.length !== 1) container.append(list);
    renderInlineDiff(container, diff);

    const details = document.createElement("details");
    details.className = "git-diff-preview";
    details.open = false;
    const summary = document.createElement("summary");
    summary.textContent = "Git diff 보기";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    diff.split("\n").forEach(function (line) {
      const span = document.createElement("span");
      span.className = gitDiffLineClass(line);
      span.textContent = line || " ";
      code.append(span);
    });
    pre.append(code);
    details.append(summary, pre);
    container.append(details);
    void applyDiffSyntaxHighlighting(code, diff);
  }

  function createDiffCount(text, kind) {
    const count = document.createElement("span");
    count.className = "git-diff-count-" + kind;
    count.textContent = text;
    return count;
  }

  function renderInlineDiff(container, diff) {
    const preview = document.createElement("pre");
    preview.className = "git-diff-inline";
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    let shown = 0;
    const multipleFiles = parseGitDiff(diff).length > 1;
    for (const [lineIndex, line] of diff.split("\n").entries()) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        continue;
      }
      if (line.startsWith("diff --git ")) {
        inHunk = false;
        if (multipleFiles && shown < 12) {
          const file = document.createElement("span");
          file.className = "git-diff-inline-file";
          const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
          file.textContent = match ? match[2] : line.slice(11);
          preview.append(file);
        }
        continue;
      }
      if (!inHunk || !/^[ +\-]/.test(line)) continue;
      const number = line.startsWith("-") ? oldLine : newLine;
      if (!line.startsWith("+")) oldLine++;
      if (!line.startsWith("-")) newLine++;
      if (shown++ >= 12) continue;
      const row = document.createElement("span");
      row.className = "git-diff-line" + (line.startsWith("+") ? " git-diff-addition" : line.startsWith("-") ? " git-diff-deletion" : "");
      const gutter = document.createElement("span");
      gutter.className = "git-diff-line-number";
      gutter.textContent = String(number);
      const sign = document.createElement("span");
      sign.className = "git-diff-sign";
      sign.textContent = line.slice(0, 1);
      const source = document.createElement("span");
      source.className = "git-diff-source";
      source.textContent = line.slice(1);
      row.append(gutter, sign, source);
      source.dataset.diffIndex = String(lineIndex);
      preview.append(row);
    }
    if (shown > 12) {
      const more = document.createElement("span");
      more.className = "git-diff-more";
      more.textContent = "… " + (shown - 12) + " more lines";
      preview.append(more);
    }
    if (shown > 0) {
      container.append(preview);
      void applyDiffSyntaxHighlighting(preview, diff, true);
    }
  }

  async function applyDiffSyntaxHighlighting(code, diff, inline) {
    const highlighter = globalThis.agentFactorySyntaxHighlighter;
    if (!highlighter) return;
    const revision = syntaxRevision;
    const elements = inline
      ? new Map(Array.from(code.querySelectorAll("[data-diff-index]")).map(function (element) { return [Number(element.dataset.diffIndex), element]; }))
      : new Map(Array.from(code.children).map(function (element, index) { return [index, element]; }));
    const sections = [];
    let path = "";
    let section;
    diff.split("\n").forEach(function (line, index) {
      if (line.startsWith("diff --git ")) {
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        path = match ? match[2] : "";
        section = undefined;
      } else if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
        section = { path, entries: [] };
        sections.push(section);
      } else if (section && /^[ +\-]/.test(line)) {
        section.entries.push({ index, prefix: line.slice(0, 1), text: line.slice(1) });
      }
    });
    await Promise.all(sections.map(async function (item) {
      const language = highlighter.languageForPath(item.path);
      if (!language || !item.entries.some(function (entry) { return elements.has(entry.index); })) return;
      const lastVisible = inline ? Math.max(...item.entries.filter(function (entry) { return elements.has(entry.index); }).map(function (entry) { return entry.index; })) : Infinity;
      await Promise.all(["old", "new"].map(async function (side) {
        const entries = item.entries.filter(function (entry) {
          return entry.index <= lastVisible && entry.prefix !== (side === "old" ? "+" : "-");
        });
        if (entries.length === 0) return;
        try {
          const highlighted = await highlighter.highlight(entries.map(function (entry) { return entry.text; }).join("\n"), language, currentSyntaxThemeClass() !== "light", isHighContrast());
          if (revision !== syntaxRevision) return;
          entries.forEach(function (entry, index) {
            const element = elements.get(entry.index);
            const tokens = highlighted[index];
            if (element && tokens && (side === "new" || entry.prefix === "-")) renderHighlightedTokens(element, tokens, inline ? "" : entry.prefix);
          });
        } catch {
        }
      }));
    }));
  }

  async function applySyntaxHighlighting(element, code, language) {
    const highlighter = globalThis.agentFactorySyntaxHighlighter;
    if (!highlighter) return;
    const revision = syntaxRevision;
    try {
      const highlighted = await highlighter.highlight(
        code,
        language,
        currentSyntaxThemeClass() !== "light",
        isHighContrast()
      );
      if (revision !== syntaxRevision || highlighted.length === 0) return;
      const fragment = document.createDocumentFragment();
      highlighted.forEach(function (tokens, index) {
        if (index > 0) fragment.append(document.createTextNode("\n"));
        appendHighlightedTokens(fragment, tokens);
      });
      element.replaceChildren(fragment);
    } catch {
      // The original text is the progressive fallback when highlighting fails.
    }
  }

  function renderHighlightedTokens(element, tokens, prefix) {
    element.replaceChildren(document.createTextNode(prefix));
    appendHighlightedTokens(element, tokens);
  }

  function appendHighlightedTokens(container, tokens) {
    tokens.forEach(function (token) {
      const span = document.createElement("span");
      span.textContent = token.content;
      if (token.color) span.style.color = token.color;
      if (token.fontStyle & 1) span.style.fontStyle = "italic";
      if (token.fontStyle & 2) span.style.fontWeight = "bold";
      if (token.fontStyle & 4) span.style.textDecoration = "underline";
      container.append(span);
    });
  }

  async function updateSyntaxTheme(selection) {
    const update = ++themeUpdate;
    syntaxRevision += 1;
    try {
      if (globalThis.agentFactorySyntaxHighlighter) {
        await globalThis.agentFactorySyntaxHighlighter.configureTheme(selection);
      }
      if (update !== themeUpdate) return;
      if (selection.error) upsertThemeWarning(selection.error);
      else state.timeline = state.timeline.filter(function (event) { return event.id !== "syntax-theme-warning"; });
    } catch (error) {
      if (update !== themeUpdate) return;
      try { await globalThis.agentFactorySyntaxHighlighter?.configureTheme({}); } catch {}
      if (update !== themeUpdate) return;
      upsertThemeWarning(String(error));
    }
    if (update === themeUpdate) renderTimeline();
  }

  function upsertThemeWarning(message) {
    const existing = state.timeline.find(function (event) { return event.id === "syntax-theme-warning"; });
    if (existing) existing.text = message;
    else state.timeline.push({ type: "notice", id: "syntax-theme-warning", level: "warning", text: message });
  }

  function isHighContrast() {
    return document.body.classList.contains("vscode-high-contrast") ||
      document.body.classList.contains("vscode-high-contrast-light");
  }

  function currentSyntaxThemeClass() {
    return document.body.classList.contains("vscode-light") ||
      document.body.classList.contains("vscode-high-contrast-light")
      ? "light"
      : "dark";
  }

  function parseGitDiff(diff) {
    const files = [];
    let current;
    diff.split("\n").forEach(function (line) {
      if (line.startsWith("diff --git ")) {
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        current = { path: match ? match[2] : line.slice(11), additions: 0, deletions: 0 };
        files.push(current);
      } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
        current.additions += 1;
      } else if (current && line.startsWith("-") && !line.startsWith("---")) {
        current.deletions += 1;
      }
    });
    return files;
  }

  function gitDiffLineClass(line) {
    if (line.startsWith("+") && !line.startsWith("+++")) return "git-diff-line git-diff-addition";
    if (line.startsWith("-") && !line.startsWith("---")) return "git-diff-line git-diff-deletion";
    if (line.startsWith("@@")) return "git-diff-line git-diff-hunk";
    return "git-diff-line";
  }

  function renderExecutionReferences(container, references) {
    const list = document.createElement("ul");
    list.className = "execution-references agents-list";
    list.setAttribute("aria-label", "실행 식별자");
    for (const reference of references) {
      const row = document.createElement("li");
      row.className = "execution-reference";
      const expectedRole = reference.label === "Work Agent" ? "work" : reference.label === "예약된 Verification Agent" ? "verification" : undefined;
      const canOpen = expectedRole && state.role === "main" && state.childAgents.some(function (agent) {
        return agent.agentId === reference.id && agent.role === expectedRole;
      });
      const main = document.createElement(canOpen ? "button" : "div");
      main.className = "agent-item execution-reference-main";
      if (canOpen) {
        main.type = "button";
        main.title = reference.id + " 세션과 대화하기";
        main.addEventListener("click", function () {
          if (state.childAgents.some(function (agent) { return agent.agentId === reference.id && agent.role === expectedRole; })) {
            vscode.postMessage({ type: "agent.open", agentId: reference.id });
          }
        });
      }
      const label = document.createElement("span");
      label.className = "agent-role";
      label.textContent = reference.label;
      const id = document.createElement("span");
      id.className = "execution-reference-id";
      id.textContent = reference.id;
      main.append(label, id);
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "execution-reference-copy setting-button";
      copy.textContent = "복사";
      copy.setAttribute("aria-label", reference.label + " " + reference.id + " 복사");
      copy.addEventListener("click", function () { vscode.postMessage({ type: "reference.copy", id: reference.id }); });
      row.append(main, copy);
      list.append(row);
    }
    container.append(list);
  }

  function renderAssistantMarkdown(container, text) {
    if (!markdown) {
      container.textContent = text;
      return;
    }
    container.classList.add("markdown-body");
    container.innerHTML = markdown.render(text);
    finishAssistantMarkdown(container);
  }

  function appendAssistantMarkdown(container, text) {
    if (!text) return;
    if (!markdown) {
      container.append(document.createTextNode(text));
      return;
    }
    const fragment = document.createElement("template");
    fragment.innerHTML = markdown.render(text);
    container.append(fragment.content);
    finishAssistantMarkdown(container);
  }

  function finishAssistantMarkdown(container) {
    for (const code of container.querySelectorAll("pre > code")) {
      if (code.dataset.highlighted === "true") continue;
      code.dataset.highlighted = "true";
      const languageClass = Array.from(code.classList).find(function (name) { return name.startsWith("language-"); });
      void applySyntaxHighlighting(code, code.textContent, languageClass ? languageClass.slice(9) : "");
    }
    for (const link of container.querySelectorAll("a")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }

  function renderRunStatus() {
    runStatus.hidden = !state.running;
    if (!state.running) {
      stopElapsedTimer();
      runStatusLabel.textContent = "";
      runElapsed.textContent = "0s";
      return;
    }
    if (!state.runStartedAt) {
      state.runStartedAt = Date.now();
    }
    const elapsed = Math.max(0, Date.now() - state.runStartedAt);
    runStatusLabel.textContent = state.runProgress || "작업 중";
    runStatusLabel.title = state.runProgress || "작업 중";
    runElapsed.textContent = formatElapsed(elapsed);
    if (!elapsedTimerId) {
      elapsedTimerId = window.setInterval(renderRunStatus, 1000);
    }
  }

  function stopElapsedTimer() {
    if (elapsedTimerId) {
      window.clearInterval(elapsedTimerId);
      elapsedTimerId = undefined;
    }
  }

  function formatElapsed(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes === 0) {
      return seconds + "s";
    }
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    return (hours ? hours + "h " : "") + minutes + "m " + seconds + "s";
  }

  function renderAttachments() {
    attachmentList.replaceChildren();
    for (const attachment of state.attachments) {
      const chip = document.createElement("div");
      chip.className = "attachment-chip" + (attachment.kind === "image" ? " attachment-image" : "");
      chip.title = attachment.uri || attachment.name;
      const name = document.createElement("span");
      name.className = "attachment-chip-name";
      name.textContent = attachment.name;
      if (attachment.kind === "image" && attachment.previewUri) {
        chip.classList.add("is-loading");
        const preview = document.createElement("img");
        preview.className = "attachment-preview";
        preview.src = attachment.previewUri;
        preview.alt = attachment.name;
        preview.addEventListener("load", function () {
          chip.classList.remove("is-loading");
        });
        preview.addEventListener("error", function () {
          chip.classList.remove("is-loading");
          chip.classList.add("preview-failed");
        });
        chip.append(preview);
      }
      const remove = document.createElement("button");
      remove.className = "attachment-remove";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", attachment.name + " 첨부 제거");
      remove.addEventListener("click", function () {
        if (attachment.previewUri?.startsWith("blob:")) {
          URL.revokeObjectURL(attachment.previewUri);
        }
        state.attachments = state.attachments.filter(function (item) {
          return item.id !== attachment.id;
        });
        renderAttachments();
        updateSendButton();
        persist();
      });
      chip.append(name, remove);
      attachmentList.append(chip);
    }
  }

  function openSessionMenu() {
    closeSettingMenu(false);
    closeQuestionMenu(false);
    sessionMenu.hidden = false;
    sessionButton.setAttribute("aria-expanded", "true");
    state.sessionsLoading = true;
    renderSessionList();
    vscode.postMessage({ type: "sessions.request" });
  }

  function closeSessionMenu(restoreFocus) {
    sessionMenu.hidden = true;
    sessionButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) {
      sessionButton.focus();
    }
  }

  function openQuestionMenu() {
    closeSettingMenu(false);
    closeSessionMenu(false);
    renderQuestionList();
    questionMenu.hidden = false;
    questionButton.setAttribute("aria-expanded", "true");
    questionList.querySelector("button")?.focus();
  }

  function closeQuestionMenu(restoreFocus) {
    questionMenu.hidden = true;
    questionButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) {
      questionButton.focus();
    }
  }

  function renderQuestionList() {
    questionList.replaceChildren();
    const questions = state.timeline.filter(function (event) {
      return event.type === "user";
    });
    if (questions.length === 0) {
      questionList.append(sessionEmpty("아직 사용자 질문이 없습니다."));
      return;
    }
    questions.forEach(function (question, index) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "question-item";
      item.setAttribute("role", "option");
      const number = document.createElement("span");
      number.className = "question-item-index";
      number.textContent = "질문 " + (index + 1);
      const text = document.createElement("span");
      text.className = "question-item-text";
      text.textContent = question.text;
      item.append(number, text);
      item.addEventListener("click", function () {
        closeQuestionMenu(false);
        jumpToQuestion(question.id);
      });
      item.addEventListener("keydown", handleSessionListKeydown);
      questionList.append(item);
    });
  }

  function jumpToQuestion(id) {
    const target = Array.from(timeline.querySelectorAll(".message-user")).find(function (message) {
      return message.dataset.id === id;
    });
    if (!target) {
      return;
    }
    followLatest = false;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
    target.classList.add("message-jump-target");
    window.setTimeout(function () {
      target.classList.remove("message-jump-target");
    }, 1200);
  }

  function renderSessionList() {
    sessionList.replaceChildren();
    if (state.sessionsLoading) {
      sessionList.append(sessionEmpty("세션 목록을 불러오는 중…"));
      return;
    }
    if (state.sessions.length === 0) {
      sessionList.append(sessionEmpty("불러올 Main Agent 세션이 없습니다."));
      return;
    }
    for (const session of state.sessions) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "session-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(session.agentId === state.agentId));
      const name = document.createElement("span");
      name.className = "session-item-name";
      name.textContent = session.agentId;
      const meta = document.createElement("span");
      meta.className = "session-item-meta";
      meta.textContent = [session.model, formatSessionDate(session.updatedAt)].filter(Boolean).join(" · ") || "Main Agent";
      item.append(name, meta);
      item.addEventListener("click", function () {
        vscode.postMessage({ type: "session.select", agentId: session.agentId });
      });
      item.addEventListener("keydown", handleSessionListKeydown);
      sessionList.append(item);
    }
  }

  function sessionEmpty(text) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = text;
    return empty;
  }

  function formatSessionDate(value) {
    if (typeof value !== "string") {
      return "";
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  }

  function handleSessionListKeydown(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const items = Array.from(event.currentTarget.parentElement.querySelectorAll('[role="option"]'));
    const index = items.indexOf(event.currentTarget);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    event.preventDefault();
    items[(index + offset + items.length) % items.length]?.focus();
  }

  function updateSessionControl() {
    sessionButton.hidden = state.role !== "main";
    sessionButton.title = state.agentId ? "현재 세션: " + state.agentId : "기존 Main Agent 세션 불러오기";
    sessionButton.setAttribute("aria-label", sessionButton.title);
    sessionButton.disabled = state.running;
  }

  function updateQuestionControl() {
    const count = state.timeline.filter(function (event) {
      return event.type === "user";
    }).length;
    questionButton.title = "사용자 질문 목록 (" + count + ")";
    questionButton.setAttribute("aria-label", questionButton.title);
  }

  function renderStatusBar() {
    statusBar.replaceChildren();
    for (const itemId of state.statusItems) {
      if (itemId === "agents" && state.role !== "main") {
        continue;
      }
      if (itemId === "status") {
        continue;
      }
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
        item.title = "현재 진행 중인 Agent 작업 " + state.workUnits.activeUnits + " · 누적 호출 " + state.workUnits.totalCalled;
        item.setAttribute("role", "button");
        item.setAttribute("aria-haspopup", "listbox");
        item.setAttribute("aria-expanded", String(!agentsMenu.hidden));
        item.addEventListener("click", openAgentsMenu);
        item.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openAgentsMenu();
          }
        });
      } else if (itemId === "context" && state.contextUsedTokens !== undefined && state.contextWindowTokens !== undefined) {
        renderContextStatus(item);
        item.title = "최근 turn 기준 사용 " + state.contextUsedTokens.toLocaleString("ko-KR") +
          " / 자동 컴팩트 기준 " + state.contextWindowTokens.toLocaleString("ko-KR") + " tokens";
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

  function openAgentsMenu() {
    if (!agentsMenu.hidden) {
      closeAgentsMenu();
      return;
    }
    state.agentsLoading = true;
    agentsMenu.hidden = false;
    renderAgentsList();
    renderStatusBar();
    vscode.postMessage({ type: "agents.request" });
  }

  function closeAgentsMenu() {
    agentsMenu.hidden = true;
    renderStatusBar();
  }

  function renderAgentsList() {
    agentsList.replaceChildren();
    if (state.agentsLoading) {
      agentsList.append(emptyAgentItem("호출된 Agent를 불러오는 중…"));
      return;
    }
    if (state.childAgents.length === 0) {
      agentsList.append(emptyAgentItem("아직 호출된 작업자나 검증자가 없습니다."));
      return;
    }
    for (const agent of state.childAgents) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "agent-item";
      item.setAttribute("role", "option");
      item.title = agent.agentId + " 세션과 대화하기";
      const main = document.createElement("span");
      main.className = "agent-item-main";
      const role = document.createElement("span");
      role.className = "agent-role";
      role.textContent = agent.role === "work" ? "작업" : "검증";
      const id = document.createElement("span");
      id.className = "agent-id";
      id.textContent = agent.agentId;
      const status = document.createElement("span");
      status.className = "agent-status";
      status.textContent = childAgentStatusLabel(agent.status) + " · 클릭하여 대화";
      main.append(role, id);
      item.append(main, status);
      item.addEventListener("click", function () {
        closeAgentsMenu();
        vscode.postMessage({ type: "agent.open", agentId: agent.agentId });
      });
      agentsList.append(item);
    }
  }

  function emptyAgentItem(text) {
    const item = document.createElement("div");
    item.className = "session-empty";
    item.textContent = text;
    return item;
  }

  function isChildAgent(agent) {
    return agent && typeof agent.agentId === "string" &&
      ["work", "verification"].includes(agent.role) && typeof agent.status === "string";
  }

  function summarizeChildAgents(agents) {
    const activeStatuses = new Set(["accepted", "starting", "running", "cancelling"]);
    return {
      activeUnits: agents.filter(function (agent) { return activeStatuses.has(agent.status); }).length,
      workActive: agents.filter(function (agent) { return agent.role === "work" && activeStatuses.has(agent.status); }).length,
      verificationActive: agents.filter(function (agent) { return agent.role === "verification" && activeStatuses.has(agent.status); }).length,
      totalCalled: agents.length
    };
  }

  function childAgentStatusLabel(status) {
    const labels = {
      accepted: "대기 중",
      starting: "시작 중",
      running: "실행 중",
      cancelling: "취소 중",
      completed: "완료",
      failed: "실패",
      cancelled: "취소됨",
      "needs-human-decision": "사용자 결정 필요",
      unknown: "상태 미확인"
    };
    return labels[status] || status;
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
      agents: "작업 " + state.workUnits.workActive + " · 검증 " + state.workUnits.verificationActive,
      project: state.projectName || "Project —",
      branch: "Branch " + (state.branch || "—"),
      context: contextStatusLabel(),
      elapsed: "00:00",
      queue: "Queue 0",
      runtime: state.runtimeAvailable ? "Runtime 연결됨" : "Runtime 미연결"
    };
    return labels[itemId] || itemId;
  }

  function updateSendButton() {
    sendButton.disabled = !state.running && (!state.runtimeAvailable || !state.capabilities || (prompt.value.trim().length === 0 && state.attachments.length === 0));
  }

  function updateRunControls() {
    updateExecutionControl();
    sendButton.classList.toggle("is-running", state.running);
    sendButton.setAttribute("aria-label", state.running ? "현재 실행 중지" : "메시지 전송");
    sendButton.title = state.running ? "현재 실행 중지 (Esc)" : "전송 (Enter)";
    sendIcon.hidden = state.running;
    stopIcon.hidden = !state.running;
    updateSessionControl();
    renderRunStatus();
    updateSendButton();
    renderGoal();
  }

  function toggleMode(key) {
    state[key] = !state[key];
    updateModeControls();
    renderStatusBar();
    persist();
    saveComposerSettings();
  }

  function currentCapabilities() {
    return state.capabilities?.[state.agentId ? "send" : "submit"] || {};
  }

  function updateExecutionControl() {
    if (!executionModeButton) return;
    executionModeButton.parentElement.hidden = state.role !== "main";
    executionModeButton.disabled = state.running;
    executionModeLabel.textContent = state.executionMode === undefined ? "권한: 현재 세션" : "권한: " + executionModeName(state.executionMode);
    executionModeButton.title = state.running ? "실행이 끝나면 다음 메시지의 권한을 변경할 수 있습니다." : "다음 메시지에 적용할 실행 권한 선택";
    if (state.running && openSettingId === "execution") closeSettingMenu(false);
  }

  function updateModeControls() {
    updateExecutionControl();
    const supported = currentCapabilities();
    modelButton.parentElement.hidden = supported.model !== true;
    reasoningButton.parentElement.hidden = supported.reasoning !== true;
    fastModeButton.hidden = supported.fast !== true;
    goalModeButton.hidden = supported.goal !== true || (state.role && state.role !== "main");
    if (openSettingId && openSettingId !== "execution" && supported[openSettingId] !== true) closeSettingMenu(false);
    fastModeButton.setAttribute("aria-pressed", String(state.fastMode));
    fastModeButton.setAttribute("aria-label", state.fastMode ? "Fast mode on" : "Fast mode off");
    fastModeButton.title = state.fastMode ? "Fast mode on" : "Fast mode off";
    goalModeButton.setAttribute("aria-pressed", String(state.goalMode));
    goalModeButton.setAttribute("aria-label", state.goalMode ? "Goal mode on" : "Goal mode off");
    goalModeButton.title = state.goalMode ? "Goal mode on" : "Goal mode off";
    modelLabel.textContent = state.model || "Default";
    reasoningLabel.textContent = state.reasoning || "Default";
    renderGoal();
  }

  function renderGoal() {
    goalPanel.hidden = state.role !== "main" || (!state.goalMode && !nativeGoal && !goalError);
    const labels = { active: "진행 중", paused: "일시 정지", blocked: "입력 필요", usageLimited: "사용량 한도", budgetLimited: "목표 예산 한도", complete: "목표 완료" };
    goalStatus.textContent = goalError || (nativeGoal
      ? `${labels[nativeGoal.status] || nativeGoal.status} · ${nativeGoal.tokensUsed.toLocaleString()} tokens · ${nativeGoal.timeUsedSeconds}초\n${nativeGoal.objective}`
      : "목표를 켜고 메시지를 보내세요.");
    for (const button of goalPanel.querySelectorAll("[data-goal-action]")) {
      const action = button.dataset.goalAction;
      button.disabled = !state.agentId || (action !== "refresh" && !nativeGoal) || (["reopen"].includes(action) && state.running);
    }
  }

  function openSetting(setting) {
    if (openSettingId === setting) {
      closeSettingMenu(true);
      return;
    }
    closeSettingMenu(false);
    closeSessionMenu(false);
    closeQuestionMenu(false);
    openSettingId = setting;
    if (setting === "model") vscode.postMessage({ type: "models.request" });
    const button = settingButton(setting);
    const menu = settingMenu(setting);
    renderSettingMenu(setting, menu);
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const selected = menu.querySelector('[aria-checked="true"]');
    (selected || menu.querySelector("button"))?.focus();
  }

  function renderSettingMenu(setting, menu) {
    const current = setting === "model" ? state.model : setting === "reasoning" ? state.reasoning : state.executionMode ?? "cli-default";
    menu.replaceChildren();
    const values = setting === "model" ? [...new Set([...settingOptions.model, state.model])] : settingOptions[setting];
    for (const value of values) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "setting-option";
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", String(value === current));
      option.dataset.value = value;
      const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      check.classList.add("setting-check");
      check.setAttribute("viewBox", "0 0 16 16");
      check.setAttribute("aria-hidden", "true");
      check.setAttribute("focusable", "false");
      const checkPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      checkPath.setAttribute("d", "m3 8 3 3 7-7");
      check.append(checkPath);
      const label = document.createElement("span");
      label.textContent = setting === "execution" ? executionModeName(value) : value || "Default";
      option.append(check, label);
      option.addEventListener("click", function () {
        if (setting === "model") {
          state.model = value;
        } else if (setting === "reasoning") {
          state.reasoning = value;
        } else {
          state.executionMode = value;
          vscode.postMessage({ type: "execution.select", mode: value });
        }
        updateModeControls();
        renderStatusBar();
        persist();
        saveComposerSettings();
        closeSettingMenu(true);
      });
      option.addEventListener("keydown", handleSettingMenuKeydown);
      menu.append(option);
    }
  }

  function handleSettingMenuKeydown(event) {
    const options = Array.from(event.currentTarget.parentElement.querySelectorAll(".setting-option"));
    const index = options.indexOf(event.currentTarget);
    let target;
    if (event.key === "ArrowDown") {
      target = options[(index + 1) % options.length];
    } else if (event.key === "ArrowUp") {
      target = options[(index - 1 + options.length) % options.length];
    } else if (event.key === "Home") {
      target = options[0];
    } else if (event.key === "End") {
      target = options.at(-1);
    } else {
      return;
    }
    event.preventDefault();
    target?.focus();
  }

  function closeSettingMenu(restoreFocus) {
    if (!openSettingId) {
      return;
    }
    const button = settingButton(openSettingId);
    const menu = settingMenu(openSettingId);
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    openSettingId = undefined;
    if (restoreFocus) {
      button.focus();
    }
  }

  function settingButton(setting) {
    return setting === "model" ? modelButton : setting === "reasoning" ? reasoningButton : executionModeButton;
  }

  function settingMenu(setting) {
    return setting === "model" ? modelMenu : setting === "reasoning" ? reasoningMenu : executionModeMenu;
  }

  function executionModeName(mode) {
    return ({
      "read-only": "읽기 전용",
      "cli-default": state.agentId ? "현재 정책 유지" : "CLI 기본값",
      "workspace-write": "작업 공간 쓰기",
      "danger-full-access": "전체 접근",
      "bypass": "바이패스"
    })[mode] || (state.agentId ? "현재 정책 유지" : "CLI 기본값");
  }

  function resizePrompt() {
    prompt.style.height = "auto";
    prompt.style.height = Math.min(prompt.scrollHeight, 280) + "px";
  }

  function persist() {
    vscode.setState({
      panelId: state.panelId,
      agentId: state.agentId,
      title: state.title,
      role: state.role,
      verifiedWorkRunId: state.verifiedWorkRunId,
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
      contextUsedTokens: state.contextUsedTokens,
      contextWindowTokens: state.contextWindowTokens,
      runProgress: state.runProgress,
      runStartedAt: state.runStartedAt,
      workUnits: state.workUnits,
      childAgents: state.childAgents
    });
  }

  function safeCount(value) {
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  function safeCountOrUndefined(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }

  function normalizeStatusItems(value) {
    if (!Array.isArray(value)) return [];
    const items = value.filter(function (item) { return !composerStatusItems.has(item); });
    if (!items.includes("branch")) {
      const projectIndex = items.indexOf("project");
      items.splice(projectIndex < 0 ? 0 : projectIndex + 1, 0, "branch");
    }
    if (!items.includes("context")) {
      const queueIndex = items.indexOf("queue");
      items.splice(queueIndex < 0 ? items.length : queueIndex, 0, "context");
    }
    return items;
  }

  function saveComposerSettings() {
    vscode.postMessage({
      type: "composer.settings",
      model: state.model || undefined,
      reasoning: state.reasoning || undefined,
      fastMode: state.fastMode,
      goalMode: state.goalMode
    });
  }

  function contextStatusLabel() {
    if (state.contextUsedTokens === undefined || state.contextWindowTokens === undefined) return "Tokens —";
    return "Tokens " + Math.max(0, state.contextWindowTokens - state.contextUsedTokens).toLocaleString("ko-KR") + " 남음";
  }

  function renderContextStatus(item) {
    const compactAt = state.contextWindowTokens;
    const remaining = Math.max(0, compactAt - state.contextUsedTokens);
    const remainingRatio = compactAt > 0 ? remaining / compactAt : 0;
    const label = document.createElement("span");
    label.className = "context-token-label";
    label.textContent = contextStatusLabel();
    const meter = document.createElement("span");
    meter.className = "context-token-meter";
    meter.setAttribute("role", "progressbar");
    meter.setAttribute("aria-label", "컨텍스트 토큰 잔량");
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", String(compactAt));
    meter.setAttribute("aria-valuenow", String(remaining));
    const fill = document.createElement("span");
    fill.className = "context-token-meter-fill";
    fill.style.width = remainingRatio * 100 + "%";
    fill.style.backgroundColor = "hsl(" + Math.round(remainingRatio * 120) + " 72% 45%)";
    meter.append(fill);
    item.replaceChildren(label, meter);
  }

  function normalizeModel(value) {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) ? value : "";
  }

  function normalizeSettingValue(value, allowedValues) {
    return typeof value === "string" && allowedValues.includes(value) ? value : "";
  }

  function createId() {
    return globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
})();
