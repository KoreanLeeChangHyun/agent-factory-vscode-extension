(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const markdown = typeof globalThis.markdownit === "function"
    ? globalThis.markdownit({ html: false, linkify: true, typographer: false })
    : undefined;
  const timeline = document.getElementById("timeline");
  let commandDisclosureObserver;
  let commandDisclosureFrame;
  let commandOutputObserver;
  let commandOutputFrame;
  const emptyState = document.getElementById("empty-state");
  const prompt = document.getElementById("prompt");
  const sendButton = document.getElementById("send-button");
  const sendIcon = document.getElementById("send-icon");
  const stopIcon = document.getElementById("stop-icon");
  const attachButton = document.getElementById("attach-button");
  const autoScrollButton = document.getElementById("auto-scroll-button");
  const modelButton = document.getElementById("model-button");
  const modelLabel = document.getElementById("model-label");
  const modelMenu = document.getElementById("model-menu");
  const reasoningButton = document.getElementById("reasoning-button");
  const reasoningLabel = document.getElementById("reasoning-label");
  const reasoningMenu = document.getElementById("reasoning-menu");
  const executionModeButton = document.getElementById("execution-mode-button");
  const executionModeMenu = document.getElementById("execution-mode-menu");
  const fastModeButton = document.getElementById("fast-mode-button");
  const goalModeButton = document.getElementById("goal-mode-button");
  const workLoopButton = document.getElementById("work-loop-button");
  const taskModeMenu = document.getElementById("task-mode-menu");
  const taskModeNames = { direct: "Direct", work: "Work", "work-verification": "Work · Verification", "plan-work-verification": "Plan · Work · Verification" };
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
  const runStatusToggle = document.getElementById("run-status-toggle");
  const runStatusLabel = document.getElementById("run-status-label");
  const runElapsed = document.getElementById("run-elapsed");
  const runStatusAgents = document.getElementById("run-status-agents");
  const runDetails = document.getElementById("run-details");
  const runDetailsSummary = document.getElementById("run-details-summary");
  const runStageList = document.getElementById("run-stage-list");
  const runStopButton = document.getElementById("run-stop-button");
  const attachmentList = document.getElementById("attachment-list");
  const statusBar = document.getElementById("status-bar");
  const agentsMenu = document.getElementById("agents-menu");
  const agentsList = document.getElementById("agents-list");
  const dropOverlay = document.getElementById("drop-overlay");
  const settingOptions = {
    task: Object.keys(taskModeNames),
    model: [""],
    reasoning: ["", "none", "low", "medium", "high", "xhigh", "max"],
    execution: ["cli-default", "workspace-write", "danger-full-access", "bypass"]
  };
  const defaultStatusItems = ["status", "agents", "project", "branch", "context", "queue"];
  const statusCatalog = {
    status: ["Run status", "Current running, queued, or decision status"],
    agents: ["Active agents", "Number of Main Agent work and verification agents"],
    project: ["Project", "Current VS Code workspace name"],
    branch: ["Git branch", "Current project branch, or — when unknown"],
    context: ["Content remaining percentage", "Remaining percentage of the Content window; unavailable without usage or window size"],
    queue: ["Queued messages", "Number of messages waiting to send in this chat"],
    agent: ["Chat name", "Current chat tab name"],
    role: ["Agent role", "Main, work, or verification role"],
    elapsed: ["Elapsed time", "Time observed for the current run in this view; shown only while running"],
    runtime: ["Runtime connection", "Current runtime connection status"],
    model: ["Selected model", "Selection for the next message; may differ from the actual server model"],
    reasoning: ["Selected reasoning effort", "Selection for the next message"],
    fast: ["Fast setting", "Fast selection for the next message, subject to support"],
    task: ["Task mode", "Task mode for the next Main Agent message"],
    execution: ["Execution permissions", "Permission settings reported by the current host"],
    contextUsed: ["Content tokens used", "Current Content tokens used; input tokens for the latest turn, not cumulative usage"],
    contextRemainingTokens: ["Content tokens remaining", "Content window size minus current tokens used, with a minimum of 0"],
    contextUsedPercent: ["Content used percentage", "Current usage as a percentage of the Content window"],
    contextWindow: ["Content window tokens", "Model Content window size reported by the runtime"],
    weekly: ["Weekly usage", "Latest reported usage percentage of the 7-day account limit, if available"],
    weeklyRemaining: ["Weekly remaining", "100% minus Weekly usage; an absolute token count is not provided"],
    agentsTotal: ["Total agent calls", "Number of work and verification agents called by Main Agent"],
    goal: ["Goal status", "Main Agent Goal setting and latest reported goal status"],
    goalTokens: ["Goal tokens used", "Cumulative tokens used as reported by the goal"],
    goalTime: ["Goal time used", "Cumulative time used as reported by the goal"],
    goalBudget: ["Goal token budget", "Token budget assigned to the goal, if available"]
  };
  const statusSettings = document.getElementById("status-settings");
  const statusSettingsButton = document.getElementById("status-settings-button");
  const statusCatalogList = document.getElementById("status-catalog");
  const statusAnnouncement = document.getElementById("status-announcement");
  let statusDragId;
  let statusRenderPending = false;
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
    autoScroll: saved?.autoScroll !== false,
    attachments: Array.isArray(saved?.attachments) ? saved.attachments.filter(function (item) {
      return item && !item.pending && !item.previewUri?.startsWith("blob:") && item.data === undefined;
    }) : [],
    startedMessageIds: Array.isArray(saved?.startedMessageIds) ? saved.startedMessageIds : [],
    pendingRequests: Array.isArray(saved?.pendingRequests) ? saved.pendingRequests : [],
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
    taskMode: Object.hasOwn(taskModeNames, saved?.taskMode) ? saved.taskMode : saved?.workLoopMode === true ? "work-verification" : "work",
    workLoopMode: saved?.workLoopMode === true,
    queueCount: 0,
    contextUsedTokens: safeCountOrUndefined(saved?.contextUsedTokens),
    contextWindowTokens: safeCountOrUndefined(saved?.contextWindowTokens),
    weeklyUsedPercent: safePercentOrUndefined(saved?.weeklyUsedPercent),
    runProgress: typeof saved?.runProgress === "string" ? saved.runProgress : "",
    runStartedAt: Number.isFinite(saved?.runStartedAt) ? saved.runStartedAt : undefined,
    runPanelExpanded: saved?.running === true && saved?.runPanelExpanded === true,
    sessions: [],
    sessionsLoading: false,
    childAgents: Array.isArray(saved?.childAgents) ? saved.childAgents : [],
    agentsLoading: false,
    workUnitsKnown: false,
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
  let autoScrollFrame;
  const messageRenderKeys = new WeakMap();

  prompt.value = state.draft;
  renderAll();
  resizePrompt();
  vscode.postMessage({ type: "client.ready" });
  const restoreImages = state.attachments.filter(function (item) { return item.kind === "image"; })
    .slice(0, 8).map(function (item) { return { id: item.id, name: item.name, target: "composer" }; });
  for (const event of [...state.timeline, ...state.pendingRequests]) {
    for (const item of Array.isArray(event.attachments) ? event.attachments : []) {
      if (item.kind === "image" && restoreImages.length < 100) restoreImages.push({ id: item.id, name: item.name, target: "history" });
    }
  }
  if (restoreImages.length) vscode.postMessage({ type: "attachments.restore", attachments: restoreImages });

  runStatusToggle.addEventListener("click", function () {
    state.runPanelExpanded = !state.runPanelExpanded;
    renderWorkLoopPanel();
    if (state.runPanelExpanded && state.role === "main") {
      vscode.postMessage({ type: "agents.request" });
    }
    persist();
  });
  runStopButton.addEventListener("click", cancelRun);

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
    updateRunControls();
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
    if (state.running && !hasComposerContent()) {
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
  workLoopButton.addEventListener("click", function () {
    openSetting("task");
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

  autoScrollButton.addEventListener("click", function () {
    state.autoScroll = !state.autoScroll;
    cancelAnimationFrame(autoScrollFrame);
    updateAutoScrollControl();
    if (state.autoScroll) {
      followLatest = true;
      timeline.scrollTop = timeline.scrollHeight;
    }
    persist();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      if (!statusSettings.hidden) { event.preventDefault(); closeStatusSettings(); return; }
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
    const link = event.target.closest(".markdown-body a");
    if (link) {
      event.preventDefault();
      vscode.postMessage({ type: "link.open", href: link.getAttribute("href") || "" });
      return;
    }
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
      addBrowserImages(images);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (event.target === prompt && text.length >= longPasteThreshold) {
      event.preventDefault();
      vscode.postMessage({ type: "attachments.createText", text });
    }
  });

  window.addEventListener("beforeunload", function () {
    for (const attachment of state.attachments) {
      if (attachment.previewUri?.startsWith("blob:")) URL.revokeObjectURL(attachment.previewUri);
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
        state.taskMode = Object.hasOwn(taskModeNames, message.taskMode) ? message.taskMode : state.taskMode;
        state.fastMode = message.fastMode === true;
        state.goalMode = message.goalMode === true;
        state.workLoopMode = message.workLoopMode === true;
        state.contextUsedTokens = safeCountOrUndefined(message.contextUsedTokens);
        state.contextWindowTokens = safeCountOrUndefined(message.contextWindowTokens);
        state.weeklyUsedPercent = safePercentOrUndefined(message.weeklyUsedPercent);
        state.queueCount = safeCount(message.queueCount);
        if (Array.isArray(message.pendingMessageIds)) {
          for (const item of state.pendingRequests || []) {
            if (!message.pendingMessageIds.includes(item.id)) item.rejected = true;
          }
        }
        if (state.running && !state.runStartedAt) {
          state.runStartedAt = Date.now();
        } else if (!state.running) {
          state.runStartedAt = undefined;
          state.runPanelExpanded = false;
        }
        state.statusItems = normalizeStatusItems(message.statusItems);
        updateModeControls();
        if (state.agentId && state.role === "main") vscode.postMessage({ type: "goal.control", action: "get" });
        renderTimeline();
        renderStatusBar();
        renderStatusCatalog();
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
      case "attachments.restored":
        if (Array.isArray(message.attachments)) {
          const composer = message.attachments.filter(function (item) { return item.target === "composer"; });
          if (composer.length) addAttachments(composer.map(function ({ target, ...item }) { return item; }));
          for (const restored of message.attachments.filter(function (item) { return item.target === "history"; })) {
            for (const event of [...state.timeline, ...state.pendingRequests]) {
              if (!Array.isArray(event.attachments)) continue;
              event.attachments = event.attachments.map(function (item) {
                if (item.id !== restored.id) return item;
                const { target, ...attachment } = restored;
                return attachment;
              });
            }
          }
          renderTimeline();
          persist();
        }
        break;
      case "attachment.rejected": {
        const rejected = state.attachments.find(function (item) { return item.id === message.id; });
        if (rejected?.previewUri?.startsWith("blob:")) URL.revokeObjectURL(rejected.previewUri);
        state.attachments = state.attachments.filter(function (item) { return item.id !== message.id; });
        renderAttachments();
        updateSendButton();
        persist();
        break;
      }
      case "host.notice":
        appendNotice(message.level, message.text);
        break;
      case "status.updated":
        if (Array.isArray(message.items)) {
          state.statusItems = normalizeStatusItems(message.items);
          renderStatusBar();
          renderStatusCatalog();
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
            state.contextUsedTokens = undefined;
            state.contextWindowTokens = undefined;
            state.weeklyUsedPercent = undefined;
            state.workUnitsKnown = false;
            nativeGoal = null;
            goalError = undefined;
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
        state.workUnitsKnown = Array.isArray(message.agents);
        state.agentsLoading = false;
        state.childAgents = Array.isArray(message.agents) ? message.agents.filter(isChildAgent) : [];
        state.workUnits = summarizeChildAgents(state.childAgents);
        renderAgentsList();
        renderRunStatus();
        renderWorkLoopPanel();
        renderTimeline();
        renderStatusBar();
        persist();
        break;
      case "decision.pending":
        state.pendingDecisionRunId = typeof message.runId === "string" ? message.runId : undefined;
        state.decisionSubmitting = false;
        renderPendingQueue();
        renderTimeline();
        renderStatusBar();
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
        renderStatusBar();
        break;
      case "chat.assistant":
        if (typeof message.text === "string" && message.text) {
          if (message.runId && state.timeline.some(function (entry) {
            return entry.type === "assistant" && entry.runId === message.runId && entry.text === message.text &&
              entry.phase === (message.phase === "commentary" ? "commentary" : "final");
          })) break;
          state.timeline.push({ type: "assistant", id: createId(), text: message.text, runId: message.runId, phase: message.phase === "commentary" ? "commentary" : "final" });
          renderTimeline();
          persist();
        }
        break;
      case "run.state":
        state.running = message.running === true;
        state.runProgress = state.running ? (state.runProgress || "Starting Main Agent") : "";
        if (state.running && !state.runStartedAt) {
          state.runStartedAt = Date.now();
        } else if (!state.running) {
          state.runStartedAt = undefined;
        }
        updateRunControls();
        renderWorkLoopPanel();
        renderTimeline();
        renderStatusBar();
        persist();
        break;
      case "chat.rejected": {
        const pending = (state.pendingRequests || []).find(function (item) { return item.id === message.id; });
        if (pending) pending.rejected = true;
        renderPendingQueue();
        persist();
        break;
      }
      case "chat.started": {
        const pending = (state.pendingRequests || []).find(function (item) { return item.id === message.id; });
        state.pendingRequests = (state.pendingRequests || []).filter(function (item) { return item.id !== message.id; });
        if (!(state.startedMessageIds || []).includes(message.id) && !state.timeline.some(function (item) { return item.type === "user" && item.id === message.id; })) {
          state.timeline.push({ type: "user", id: message.id,
            text: message.text || message.attachments.map(function (item) { return "Attachments: " + item.name; }).join("\n"),
            attachments: pending ? pending.attachments : message.attachments });
          state.pendingDecisionRunId = undefined;
          state.decisionSubmitting = false;
          state.childAgents = [];
          state.workUnits = summarizeChildAgents([]);
          state.runStartedAt = Date.now();
          state.runProgress = "Main Agent running";
        }
        state.startedMessageIds = [...new Set([...(state.startedMessageIds || []), message.id])].slice(-400);
        renderAll();
        persist();
        break;
      }
      case "queue.updated":
        renderPendingQueue();
        state.queueCount = safeCount(message.count);
        renderStatusBar();
        updateSendButton();
        break;
      case "run.progress":
        if (typeof message.text === "string" && message.text) {
          state.runProgress = message.text;
          renderRunStatus();
          persist();
        }
        break;
      case "context.usage":
        state.contextUsedTokens = safeCountOrUndefined(message.usedTokens);
        state.contextWindowTokens = safeCountOrUndefined(message.contextWindowTokens);
        state.weeklyUsedPercent = safePercentOrUndefined(message.weeklyUsedPercent);
        renderStatusBar();
        persist();
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
        state.workUnitsKnown = true;
        state.workUnits = {
          activeUnits: safeCount(message.activeUnits),
          workActive: safeCount(message.workActive),
          verificationActive: safeCount(message.verificationActive),
          totalCalled: safeCount(message.totalCalled)
        };
        renderStatusBar();
        renderWorkLoopPanel();
        persist();
        break;
    }
  });

  function submit() {
    const userText = prompt.value.trim();
    let text = userText;
    if (!text && state.attachments.length === 0) return;
    if ((!text && state.attachments.length === 0) || !state.capabilities || !state.runtimeAvailable) {
      return;
    }
    if (state.attachments.some(function (attachment) { return attachment.pending; })) {
      appendNotice("info", "Preparing image attachments. Please send again shortly.");
      return;
    }
    const message = {
      id: createId(),
      text,
      attachments: state.attachments.map(function (attachment) {
        const { previewUri, pending, ...reference } = attachment;
        return reference;
      }),
      execution: {
        ...(state.role === "main" ? { taskMode: state.taskMode } : {}),
        model: currentCapabilities().model ? state.model || undefined : undefined,
        reasoningEffort: currentCapabilities().reasoning ? state.reasoning || undefined : undefined,
        fast: currentCapabilities().fast === true && state.fastMode,
        goal: state.role === "main" && currentCapabilities().goal === true && state.goalMode,
        ...(state.role === "main" && state.goalMode && goalObjective.value.trim() ? { goalObjective: goalObjective.value.trim() } : {})
      }
    };
    if (message.execution.goal && !nativeGoal && !message.execution.goalObjective && text.length > 4000) {
      appendNotice("error", "For long requests, enter a goal of up to 4,000 characters.");
      return;
    }
    goalObjective.value = "";
    const submittedAttachments = state.attachments.map(function (attachment) {
      const { pending, ...submitted } = attachment;
      return submitted;
    });
    (state.pendingRequests ??= []).push({ ...message, attachments: submittedAttachments });
    state.draft = "";
    state.attachments = [];
    followLatest = true;
    prompt.value = "";
    renderAll();
    resizePrompt();
    // Sending reveals the latest content once without enabling automatic following.
    if (!state.autoScroll) timeline.scrollTop = timeline.scrollHeight;
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
      if (event?.title === "Read run request" || event?.title === "실행 요청 읽기") continue;
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
    if (runDocument?.[1] === "request") return { ...event, title: "Read run request" };
    if (runDocument?.[1] === "result") return { ...event, title: "Read run result" };
    return event;
  }

  function sameReadActivity(left, right) {
    return left?.type === "activity" &&
      right?.type === "activity" &&
      left.category === "command" &&
      right.category === "command" &&
      typeof left.title === "string" &&
      typeof right.title === "string" &&
      isReadActivityTitle(left.title) &&
      (left.title === right.title ||
        readActivityDisplayTitle(left.title, "completed") === readActivityDisplayTitle(right.title, "completed"));
  }

  function isReadActivityTitle(title) {
    return title.startsWith("Read Skill · ") ||
      title === "Read run result" ||
      title.startsWith("Skill 읽기 · ") || title === "실행 결과 읽기";
  }

  function addAttachments(attachments) {
    const existing = new Set(state.attachments.map(function (item) {
      return item.uri || item.name + ":" + item.size;
    }));
    for (const attachment of attachments) {
      const key = attachment.uri || attachment.name + ":" + attachment.size;
      const sameId = state.attachments.findIndex(function (item) { return item.id === attachment.id; });
      if (sameId >= 0) {
        const previous = state.attachments[sameId];
        if (previous.previewUri?.startsWith("blob:") && previous.previewUri !== attachment.previewUri) URL.revokeObjectURL(previous.previewUri);
        state.attachments[sameId] = attachment;
        existing.add(key);
      } else if (!existing.has(key) && state.attachments.length < 100) {
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

  async function addDroppedData(dataTransfer) {
    if (!dataTransfer) {
      return;
    }
    const files = Array.from(dataTransfer.files || []);
    const attachments = files.filter(function (file) { return !file.type.startsWith("image/"); }).map(function (file, index) {
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
    await addBrowserImages(files.filter(function (file) { return file.type.startsWith("image/"); }));
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

  async function addBrowserImages(files) {
    const accepted = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    for (const file of files) {
      const imageCount = state.attachments.filter(function (item) { return item.kind === "image"; }).length;
      const imageBytes = state.attachments.filter(function (item) { return item.kind === "image"; })
        .reduce(function (total, item) { return total + (item.size || 0); }, 0);
      if (!accepted.includes(file.type) || file.size < 1 || file.size > 10 * 1024 * 1024 || imageCount >= 8 || imageBytes + file.size > 20 * 1024 * 1024) {
        appendNotice("error", "Attach up to 8 PNG, JPEG, GIF, or WebP images, with a maximum of 10 MiB each and 20 MiB total.");
        continue;
      }
      const id = createId();
      addAttachments([{ id, name: file.name || "image", kind: "image", previewUri: URL.createObjectURL(file), mediaType: file.type, size: file.size, pending: true }]);
      try {
        const dataUrl = await readDataUrl(file);
        vscode.postMessage({ type: "attachments.createImage", id, name: file.name || "image", mediaType: file.type, size: file.size, data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
      } catch (error) {
        state.attachments = state.attachments.filter(function (item) { return item.id !== id; });
        appendNotice("error", "Unable to read the image.");
        renderAttachments();
        persist();
      }
    }
  }

  function readDataUrl(file) {
    return new Promise(function (resolvePromise, rejectPromise) {
      const reader = new FileReader();
      reader.addEventListener("load", function () { typeof reader.result === "string" ? resolvePromise(reader.result) : rejectPromise(new Error("invalid image")); });
      reader.addEventListener("error", function () { rejectPromise(reader.error || new Error("image read failed")); });
      reader.readAsDataURL(file);
    });
  }

  function renderAll() {
    updateAutoScrollControl();
    renderPendingQueue();
    renderTimeline();
    renderAttachments();
    renderStatusBar();
    renderRunStatus();
    renderWorkLoopPanel();
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
    actions.setAttribute("aria-label", "Respond to the proposal above");
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "Proceed as proposed";
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
    reply.textContent = "Reply directly";
    reply.addEventListener("click", function () { prompt.focus(); });
    actions.append(approve, reply);
    content.append(actions);
  }

  function renderSkillDocuments(container, documents, event) {
    container.classList.add("skill-read-card");
    const details = document.createElement("details");
    details.className = "skill-read-details";
    const summary = document.createElement("summary");
    summary.className = "skill-read-document";
    summary.title = activityPhaseAccessibleLabel(event.phase);
    for (const documentInfo of documents) {
      if (summary.childNodes.length) summary.append(document.createTextNode(" · "));
      const name = document.createElement("strong");
      name.textContent = documentInfo.skill;
      const file = document.createElement("span");
      file.textContent = documentInfo.document;
      file.title = documentInfo.path;
      summary.append(name, document.createTextNode(" "), file);
    }
    details.append(summary);
    renderTerminalCommand(details, event.text, event.phase);
    renderCommandOutput(details, event.output, false);
    container.append(details);
  }

  function renderManagedAgent(container, managed, events) {
    container.classList.add("managed-agent-card");
    const child = state.childAgents.find(function (agent) { return agent.agentId === managed.agentId; });
    const pendingRequest = ["submit", "send", "start", "resume"].includes(managed.action) && !managed.runId;
    const matchesRun = managed.kind !== "loop" && child && !pendingRequest && (!managed.runId || child.runId === managed.runId);
    const role = managed.role || child?.role;
    const status = matchesRun ? child.status : managed.observedStatus || "unknown";
    container.dataset.status = status;
    const heading = document.createElement("div");
    heading.className = "managed-agent-heading";
    const label = document.createElement("strong");
    label.textContent = managed.kind === "loop" ? taskModeNames[managed.taskMode] || "Work · Verification" : role === "verification" ? "Verification agent" : role === "work" ? "Work agent" : "Agent";
    const badge = document.createElement("span");
    badge.className = "managed-agent-status";
    badge.textContent = status === "active" ? "In progress" : status === "runtime-error" ? "Runtime error" : childAgentStatusLabel(status);
    if (managed.taskMode === "work" && status === "completed") badge.textContent += " · No separate verification requested";
    heading.append(label, badge);
    const identity = document.createElement("div");
    identity.className = "managed-agent-identity";
    identity.textContent = managed.agentId + (managed.runId ? " · " + managed.runId : "");
    const progress = document.createElement("div");
    progress.className = "managed-agent-progress";
    const last = events[events.length - 1];
    const actions = { submit: "Submit run", start: "Start work", send: "Send follow-up", status: "Check status", result: "Get result", updates: "Get updates", cancel: "Cancel", resume: "Resume", reconcile: "Reconcile work", "recover-receipt": "Recover run", skip: "Skip verification" };
    progress.textContent = (actions[managed.action] || "Check run") + (last.phase === "failed" ? " failed" : last.phase === "started" ? " in progress" : " processed");
    container.append(heading, identity, progress);
    if (child && state.role === "main") {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "managed-agent-open setting-button";
      open.textContent = "Open chat";
      open.addEventListener("click", function () {
        if (state.childAgents.some(function (agent) { return agent.agentId === managed.agentId; })) vscode.postMessage({ type: "agent.open", agentId: managed.agentId });
      });
      container.append(open);
    }
    const details = document.createElement("details");
    details.className = "managed-agent-details";
    const summary = document.createElement("summary");
    summary.textContent = "Command and run history · " + events.length;
    details.append(summary);
    for (const event of events) {
      const raw = document.createElement("div");
      renderTerminalCommand(raw, event.text, event.phase, event.title);
      renderCommandOutput(raw, event.output, Boolean(event.title));
      details.append(raw);
    }
    container.append(details);
  }

  function managedActivities() {
    const groups = new Map(), byEvent = new Map();
    for (const event of state.timeline) {
      if (event.type !== "activity" || event.category !== "command") continue;
      const managed = globalThis.agentFactoryExecutionReferences?.managedCommand(event.text, event.output, state.childAgents);
      if (!managed) continue;
      const key = managed.kind + ":" + managed.agentId;
      let group = groups.get(key);
      if (!group || (group.managed.runId && managed.runId && group.managed.runId !== managed.runId) || ["submit", "start"].includes(managed.action)) {
        group = { managed, events: [] };
        groups.set(key, group);
      } else {
        group.managed = { ...group.managed, ...managed, role: managed.role || group.managed.role, runId: managed.runId || group.managed.runId, observedStatus: managed.observedStatus || group.managed.observedStatus };
      }
      group.events.push(event);
      byEvent.set(event.id, group);
    }
    return byEvent;
  }

  function renderTimeline() {
    cancelAnimationFrame(autoScrollFrame);
    const shouldFollowLatest = state.autoScroll && followLatest;
    const existingMessages = new Map(Array.from(timeline.querySelectorAll(".message"), element => [element.dataset.id, element]));
    const retainedIds = new Set();
    let previousMessage = emptyState;
    const displayStates = new Map();
    let focusedControl;
    for (const element of timeline.querySelectorAll(".message")) {
      const controls = Array.from(element.querySelectorAll(".bash-command-toggle, summary, .execution-reference button, .managed-agent-open"));
      const focusIndex = controls.indexOf(document.activeElement);
      if (focusIndex >= 0) focusedControl = { id: element.dataset.id, index: focusIndex };
      displayStates.set(element.dataset.id, {
        expanded: element.querySelector(".bash-command-toggle")?.getAttribute("aria-expanded") === "true",
        details: Array.from(element.querySelectorAll("details")).map(function (details) { return { className: details.className, open: details.open }; }),
        scroll: Array.from(element.querySelectorAll("pre")).map(function (pre) { return { top: pre.scrollTop, left: pre.scrollLeft }; })
      });
    }
    emptyState.hidden = state.timeline.length > 0;
    const managedByEvent = managedActivities();
    for (const event of state.timeline) {
      const managedGroup = managedByEvent.get(event.id);
      if (managedGroup && managedGroup.events[0] !== event) continue;
      retainedIds.add(event.id);
      const existing = existingMessages.get(event.id);
      const renderKey = JSON.stringify([event, syntaxRevision,
        event.type === "assistant" ? [state.role, state.childAgents.map(agent => [agent.agentId, agent.role])] : null,
        event.type === "assistant" && event.runId === state.pendingDecisionRunId && event.runId
          ? [state.pendingDecisionRunId, state.decisionSubmitting, state.running, state.runtimeAvailable] : null,
        event.category === "command" ? [managedGroup, state.childAgents, state.role] : null]);
      if (existing && messageRenderKeys.get(existing) === renderKey) {
        if (previousMessage.nextElementSibling !== existing) previousMessage.after(existing);
        previousMessage = existing;
        continue;
      }
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
        const skillDocuments = globalThis.agentFactoryExecutionReferences?.skillDocuments(event.text) || [];
        if (managedGroup) {
          message.classList.add("message-activity-agent");
          renderManagedAgent(content, managedGroup.managed, managedGroup.events);
        } else if (skillDocuments.length) {
          renderSkillDocuments(content, skillDocuments, event);
        } else {
          renderTerminalCommand(content, event.text, event.phase, event.title);
          renderCommandOutput(content, event.output, Boolean(event.title));
        }
      } else if (event.type === "activity" && event.category === "file" && event.diff) {
        renderGitDiff(content, event.diff, event.text, event.phase);
      } else {
        content.textContent = event.text;
      }
      if (event.type === "user" && Array.isArray(event.attachments)) renderHistoryAttachments(content, event.attachments);
      message.append(content);
      const display = displayStates.get(event.id);
      if (display) {
        const toggle = message.querySelector(".bash-command-toggle");
        const command = message.querySelector(".bash-command-text");
        if (toggle && command && display.expanded) setCommandExpanded(command, toggle, true);
        for (const details of message.querySelectorAll("details")) {
          const previous = display.details.find(function (item) { return item.className === details.className; });
          if (previous) details.open = previous.open;
        }
      }
      // Build the replacement at its final disclosure height before touching live DOM.
      // Unchanged messages stay mounted, so OFF needs no scrollTop restoration.
      if (existing) existing.replaceWith(message);
      else previousMessage.after(message);
      if (previousMessage.nextElementSibling !== message) previousMessage.after(message);
      previousMessage = message;
      messageRenderKeys.set(message, renderKey);
      if (display) {
        message.querySelectorAll("pre").forEach(function (pre, index) {
          if (display.scroll[index]) {
            pre.scrollTop = display.scroll[index].top;
            pre.scrollLeft = display.scroll[index].left;
          }
        });
      }
      if (focusedControl?.id === event.id) {
        const control = message.querySelectorAll(".bash-command-toggle, summary, .execution-reference button, .managed-agent-open")[focusedControl.index];
        if (control) {
          if (control.classList.contains("bash-command-toggle")) control.hidden = false;
          control.focus({ preventScroll: true });
        }
      }
    }
    for (const [id, element] of existingMessages) {
      if (!retainedIds.has(id)) element.remove();
    }
    updateQuestionControl();
    timeline.setAttribute("aria-busy", String(state.running));
    if (shouldFollowLatest) {
      autoScrollFrame = requestAnimationFrame(function () {
        // The user may disable following or scroll away before this frame runs.
        if (state.autoScroll && followLatest) timeline.scrollTop = timeline.scrollHeight;
      });
    }
  }

  function updateAutoScrollControl() {
    const label = state.autoScroll
      ? "Auto-scroll ON · Click to turn off"
      : "Auto-scroll OFF · Click to jump to the latest content and turn on";
    autoScrollButton.title = label;
    autoScrollButton.setAttribute("aria-label", label);
    autoScrollButton.setAttribute("aria-pressed", String(state.autoScroll));
  }

  function activityKindLabel(category) {
    if (category === "file") return "Git changes";
    return "Tool execution";
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
    if (phase === "completed") return "Succeeded";
    if (phase === "failed") return "Failed";
    return "In progress";
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
    toggle.setAttribute("aria-label", "Expand full command");
    toggle.title = "Expand full command";
    toggle.setAttribute("aria-expanded", "false");
    toggle.hidden = true;
    const toggleIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    toggleIcon.setAttribute("viewBox", "0 0 16 16");
    toggleIcon.setAttribute("aria-hidden", "true");
    toggleIcon.setAttribute("focusable", "false");
    const togglePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    togglePath.setAttribute("d", "m4 6 4 4 4-4");
    toggleIcon.append(togglePath);
    toggle.append(toggleIcon);
    toggle.addEventListener("click", function () {
      setCommandExpanded(text, toggle, !text.classList.contains("is-expanded"));
    });
    const commandBlock = document.createElement("div");
    commandBlock.className = "terminal-command-block";
    commandBlock.append(row, toggle);
    container.append(commandBlock);
    if (!commandDisclosureObserver) {
      commandDisclosureObserver = new ResizeObserver(scheduleCommandDisclosureMeasurement);
      commandDisclosureObserver.observe(timeline);
    }
    scheduleCommandDisclosureMeasurement();
    void applySyntaxHighlighting(commandCode, command, "bash").then(function () {
      scheduleCommandDisclosureMeasurement();
    });
  }

  function setCommandExpanded(text, toggle, expanded) {
    text.classList.toggle("is-expanded", expanded);
    toggle.classList.toggle("is-expanded", expanded);
    toggle.setAttribute("aria-label", expanded ? "Collapse command" : "Expand full command");
    toggle.title = expanded ? "Collapse command" : "Expand full command";
    toggle.setAttribute("aria-expanded", String(expanded));
    if (expanded) toggle.hidden = false;
  }

  function scheduleCommandDisclosureMeasurement() {
    if (commandDisclosureFrame) return;
    commandDisclosureFrame = requestAnimationFrame(function () {
      commandDisclosureFrame = undefined;
      for (const block of timeline.querySelectorAll(".terminal-command-block")) {
        const text = block.querySelector(".bash-command-text");
        const toggle = block.querySelector(".bash-command-toggle");
        if (!text || !toggle || text.classList.contains("is-expanded")) continue;
        toggle.hidden = text.scrollHeight <= text.clientHeight + 1;
      }
    });
  }

  function readActivityDisplayTitle(title, phase) {
    // Render legacy UI labels in English without rewriting the saved event.
    if (title.startsWith("Skill 읽기 · ")) title = title.replace("Skill 읽기 · ", "Read Skill · ");
    if (title === "실행 결과 읽기") title = "Read run result";
    if (phase !== "started") return title;
    if (title.startsWith("Read Skill · ")) return title.replace("Read Skill · ", "Reading Skill · ");
    if (title === "Read run result") return "Reading run result";
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
    summary.textContent = "View run result";
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
    summary.textContent = "View Git diff";
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
    list.setAttribute("aria-label", "Execution identifiers");
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
        main.title = reference.id + " · Chat with session";
        main.addEventListener("click", function () {
          if (state.childAgents.some(function (agent) { return agent.agentId === reference.id && agent.role === expectedRole; })) {
            vscode.postMessage({ type: "agent.open", agentId: reference.id });
          }
        });
      }
      const label = document.createElement("span");
      label.className = "agent-role";
      label.textContent = reference.label === "예약된 Verification Agent" ? "Reserved Verification Agent" : reference.label;
      const id = document.createElement("span");
      id.className = "execution-reference-id";
      id.textContent = reference.id;
      main.append(label, id);
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "execution-reference-copy setting-button";
      copy.textContent = "Copy";
      copy.setAttribute("aria-label", label.textContent + " " + reference.id + " · Copy");
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
      runStatusLabel.title = "";
      runElapsed.textContent = "0s";
      return;
    }
    if (!state.runStartedAt) {
      state.runStartedAt = Date.now();
    }
    const elapsed = Math.max(0, Date.now() - state.runStartedAt);
    runStatusLabel.textContent = state.runProgress || "Working";
    runStatusLabel.title = state.runProgress || "Working";
    runElapsed.textContent = formatElapsed(elapsed);
    const elapsedItem = statusBar.querySelector('[data-item-id="elapsed"]');
    if (elapsedItem) {
      elapsedItem.textContent = statusLabel("elapsed");
      elapsedItem.setAttribute("aria-label", elapsedItem.textContent + " · Move with Alt+Left/Right");
    }
    refreshStatusPreview();
    if (!elapsedTimerId) {
      elapsedTimerId = window.setInterval(renderRunStatus, 1000);
    }
  }

  function renderWorkLoopPanel() {
    const expandable = state.role === "main";
    const expanded = expandable && state.runPanelExpanded && !runStatus.hidden;
    runStatusToggle.disabled = !expandable;
    runStatusToggle.setAttribute("aria-expanded", String(expanded));
    runStatus.classList.toggle("is-expanded", expanded);
    runStatus.classList.toggle("is-running", state.running);
    runDetails.hidden = !expanded;
    runStatusAgents.hidden = !expandable;
    runStatusAgents.textContent = state.workUnits.totalCalled > 0
      ? "Work " + state.workUnits.workActive + " · Verification " + state.workUnits.verificationActive + " in progress"
      : "";
    if (!expanded) return;

    runDetailsSummary.textContent = state.workUnits.activeUnits > 0
      ? state.workUnits.activeUnits + " active"
      : state.childAgents.length > 0 ? state.childAgents.length + " called" : "Preparing";
    runStageList.replaceChildren();
    if (state.childAgents.length === 0) {
      runStageList.append(emptyAgentItem("No work or verification agents have been called yet."));
    } else {
      for (const agent of state.childAgents.slice().sort(function (a, b) {
        return (a.role === "work" ? 0 : 1) - (b.role === "work" ? 0 : 1);
      })) {
        runStageList.append(createRunStage(agent));
      }
    }
    runStopButton.hidden = !state.running;
  }

  function createRunStage(agent) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "run-stage";
    item.dataset.status = agent.status;
    item.title = agent.agentId + " · Open session";
    const marker = document.createElement("span");
    marker.className = "run-stage-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = childAgentStatusMarker(agent.status);
    const copy = document.createElement("span");
    copy.className = "run-stage-copy";
    const name = document.createElement("span");
    name.className = "run-stage-name";
    name.textContent = agent.role === "work" ? "Work" : "Verification";
    const id = document.createElement("span");
    id.className = "run-stage-id";
    id.textContent = agent.agentId;
    copy.append(name, id);
    const status = document.createElement("span");
    status.className = "run-stage-status";
    status.textContent = childAgentStatusLabel(agent.status);
    item.append(marker, copy, status);
    item.addEventListener("click", function () {
      vscode.postMessage({ type: "agent.open", agentId: agent.agentId });
    });
    return item;
  }

  function countChildAgents(role) {
    return state.childAgents.filter(function (agent) { return agent.role === role; }).length;
  }

  function childAgentStatusMarker(status) {
    if (status === "completed") return "✓";
    if (status === "failed" || status === "cancelled") return "×";
    if (status === "needs-human-decision") return "!";
    return "●";
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
        if (attachment.uri && !attachment.pending) {
          preview.tabIndex = 0;
          preview.setAttribute("role", "button");
          preview.setAttribute("aria-label", attachment.name + " · Open original");
          preview.addEventListener("click", function () { vscode.postMessage({ type: "attachment.open", id: attachment.id }); });
          preview.addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); vscode.postMessage({ type: "attachment.open", id: attachment.id }); }
          });
        }
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
      remove.setAttribute("aria-label", attachment.name + " · Remove attachment");
      remove.addEventListener("click", function () {
        if (attachment.previewUri?.startsWith("blob:")) {
          URL.revokeObjectURL(attachment.previewUri);
        }
        state.attachments = state.attachments.filter(function (item) {
          return item.id !== attachment.id;
        });
        if (attachment.uri) vscode.postMessage({ type: "attachment.remove", id: attachment.id });
        renderAttachments();
        updateSendButton();
        persist();
      });
      chip.append(name, remove);
      attachmentList.append(chip);
    }
  }

  function renderHistoryAttachments(container, attachments) {
    const gallery = document.createElement("div");
    gallery.className = "history-attachments";
    for (const attachment of attachments) {
      if (attachment.kind !== "image") continue;
      const item = document.createElement(attachment.previewUri ? "button" : "div");
      item.className = "history-attachment";
      item.title = attachment.name;
      if (attachment.previewUri) {
        item.type = "button";
        item.setAttribute("aria-label", attachment.name + " · Open original");
        item.addEventListener("click", function () { vscode.postMessage({ type: "attachment.open", id: attachment.id }); });
        const preview = document.createElement("img");
        preview.src = attachment.previewUri;
        preview.alt = attachment.name;
        item.append(preview);
      }
      const name = document.createElement("span");
      name.textContent = attachment.name;
      item.append(name);
      gallery.append(item);
    }
    if (gallery.childElementCount) container.append(gallery);
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
      questionList.append(sessionEmpty("No user questions yet."));
      return;
    }
    questions.forEach(function (question, index) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "question-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-posinset", String(index + 1));
      item.setAttribute("aria-setsize", String(questions.length));
      const text = document.createElement("span");
      text.className = "question-item-text";
      const attachmentNames = (Array.isArray(question.attachments) ? question.attachments : [])
        .map(function (attachment) { return attachment.name; }).filter(Boolean);
      text.textContent = question.text?.trim() || (attachmentNames.length ? "Attachments: " + attachmentNames.join(", ") : "Message with attachments");
      item.append(text);
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
      sessionList.append(sessionEmpty("Loading sessions…"));
      return;
    }
    if (state.sessions.length === 0) {
      sessionList.append(sessionEmpty("No Main Agent sessions to load."));
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
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-US");
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
    sessionButton.title = state.agentId ? "Current session: " + state.agentId : "Load an existing Main Agent session";
    sessionButton.setAttribute("aria-label", sessionButton.title);
    sessionButton.disabled = state.running;
  }

  function updateQuestionControl() {
    const count = state.timeline.filter(function (event) {
      return event.type === "user";
    }).length;
    questionButton.title = "User questions (" + count + ")";
    questionButton.setAttribute("aria-label", questionButton.title);
  }

  function renderStatusBar() {
    if (statusDragId) { statusRenderPending = true; return; }
    const focusedId = statusBar.contains(document.activeElement) ? document.activeElement.dataset.itemId : undefined;
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
      item.title = statusCatalog[itemId][1];
      item.setAttribute("aria-label", statusCatalog[itemId][0] + ": " + item.textContent + " · Move with Alt+Left/Right");
      if (itemId === "agents" && state.role === "main") {
        item.classList.add("work-unit-activity");
        item.dataset.active = String(state.workUnits.activeUnits > 0);
        item.title = state.workUnitsKnown ? "Active agent tasks " + state.workUnits.activeUnits + " · Total calls " + state.workUnits.totalCalled : "Agent status unavailable · Click to refresh";
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
      bindStatusDrag(item, itemId, false);
      item.addEventListener("keydown", function (event) {
        if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
          event.preventDefault();
          moveStatus(itemId, event.key === "ArrowLeft" ? -1 : 1);
        }
      });
      statusBar.append(item);
    }
    if (focusedId) statusBar.querySelector('[data-item-id="' + focusedId + '"]')?.focus();
    refreshStatusPreview();
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
      agentsList.append(emptyAgentItem("Loading called agents…"));
      return;
    }
    if (state.childAgents.length === 0) {
      agentsList.append(emptyAgentItem("No work or verification agents have been called yet."));
      return;
    }
    for (const agent of state.childAgents) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "agent-item";
      item.setAttribute("role", "option");
      item.title = agent.agentId + " · Chat with session";
      const main = document.createElement("span");
      main.className = "agent-item-main";
      const role = document.createElement("span");
      role.className = "agent-role";
      role.textContent = agent.role === "work" ? "Work" : "Verification";
      const id = document.createElement("span");
      id.className = "agent-id";
      id.textContent = agent.agentId;
      const status = document.createElement("span");
      status.className = "agent-status";
      status.textContent = childAgentStatusLabel(agent.status) + " · Click to chat";
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
    const activeStatuses = new Set(["accepted", "queued", "starting", "running", "cancelling"]);
    return {
      activeUnits: agents.filter(function (agent) { return activeStatuses.has(agent.status); }).length,
      workActive: agents.filter(function (agent) { return agent.role === "work" && activeStatuses.has(agent.status); }).length,
      verificationActive: agents.filter(function (agent) { return agent.role === "verification" && activeStatuses.has(agent.status); }).length,
      totalCalled: agents.length
    };
  }

  function childAgentStatusLabel(status) {
    const labels = {
      accepted: "Queued",
      queued: "Queued",
      starting: "Starting",
      running: "Running",
      cancelling: "Cancelling",
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
      "needs-human-decision": "User decision required",
      unknown: "Status unknown"
    };
    return labels[status] || status;
  }

  function setStatusItems(items, announcement) {
    state.statusItems = normalizeStatusItems(items);
    renderStatusBar();
    renderStatusCatalog();
    persist();
    statusAnnouncement.textContent = announcement || "Displayed information updated.";
    vscode.postMessage({ type: "status.reorder", items: state.statusItems });
  }

  function reorderStatus(sourceId, targetId, after = false) {
    const items = state.statusItems.slice();
    if (sourceId === targetId || !items.includes(sourceId) || !items.includes(targetId)) return;
    items.splice(items.indexOf(sourceId), 1);
    items.splice(items.indexOf(targetId) + (after ? 1 : 0), 0, sourceId);
    setStatusItems(items, statusCatalog[sourceId][0] + " position updated.");
  }

  function moveStatus(itemId, offset) {
    const index = state.statusItems.indexOf(itemId);
    const target = state.statusItems[index + offset];
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
      statusDragId = itemId;
      event.stopPropagation();
      event.dataTransfer?.setData("text/status-item", itemId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      element.classList.add("dragging");
    });
    element.addEventListener("dragend", function () {
      statusDragId = undefined;
      element.classList.remove("dragging");
      clearStatusDropTargets();
      if (statusRenderPending) { statusRenderPending = false; renderStatusBar(); renderStatusCatalog(); }
    });
    function isAfter(event) {
      const rect = element.getBoundingClientRect();
      return vertical ? event.clientY > rect.top + rect.height / 2 : event.clientX > rect.left + rect.width / 2;
    }
    element.addEventListener("dragover", function (event) {
      if (!statusDragId || statusDragId === itemId || !state.statusItems.includes(itemId)) return;
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
      const sourceId = statusDragId;
      if (!sourceId || event.dataTransfer?.getData("text/status-item") !== sourceId) return;
      event.preventDefault();
      event.stopPropagation();
      statusDragId = undefined;
      statusRenderPending = false;
      clearStatusDropTargets();
      reorderStatus(sourceId, itemId, isAfter(event));
    });
  }

  function renderStatusCatalog() {
    if (statusDragId) { statusRenderPending = true; return; }
    if (statusSettings.hidden) return;
    const focusKey = statusCatalogList.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;
    statusCatalogList.replaceChildren();
    const ids = [...state.statusItems, ...Object.keys(statusCatalog).filter(id => !state.statusItems.includes(id))];
    let previousGroup;
    for (const id of ids) {
      const selected = state.statusItems.includes(id);
      if (previousGroup !== selected) {
        const heading = document.createElement("h3");
        heading.className = "status-catalog-heading";
        heading.textContent = selected ? "Visible · " + state.statusItems.length : "Available";
        statusCatalogList.append(heading);
        previousGroup = selected;
      }
      const row = document.createElement("div");
      row.className = "status-catalog-row";
      row.dataset.itemId = id;
      row.dataset.selected = String(selected);
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected;
      checkbox.dataset.focusKey = id + "-select";
      checkbox.addEventListener("change", function () {
        setStatusItems(checkbox.checked ? [...state.statusItems, id] : state.statusItems.filter(item => item !== id));
      });
      const name = document.createElement("span");
      name.textContent = statusCatalog[id][0];
      label.append(checkbox, name);
      label.title = statusCatalog[id][1];
      checkbox.setAttribute("aria-description", statusCatalog[id][1]);
      const preview = document.createElement("span");
      preview.className = "status-preview";
      preview.dataset.previewId = id;
      preview.textContent = statusLabel(id);
      const actions = document.createElement("div");
      actions.className = "status-order-actions";
      for (const [offset, title] of [[-1, "Earlier"], [1, "Later"]]) {
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
        button.title = title + " · Move";
        button.dataset.focusKey = id + "-" + offset;
        button.setAttribute("aria-label", statusCatalog[id][0] + " " + title + " · Move");
        const index = state.statusItems.indexOf(id);
        button.disabled = !selected || index + offset < 0 || index + offset >= state.statusItems.length;
        button.addEventListener("click", function () { moveStatus(id, offset); });
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
    for (const preview of statusCatalogList.querySelectorAll("[data-preview-id]")) {
      preview.textContent = statusLabel(preview.dataset.previewId);
    }
  }

  function closeStatusSettings() {
    statusSettings.hidden = true;
    statusSettingsButton.setAttribute("aria-expanded", "false");
    statusSettingsButton.focus();
  }

  statusSettingsButton.addEventListener("click", function () {
    if (!statusSettings.hidden) { closeStatusSettings(); return; }
    statusSettings.hidden = false;
    statusSettingsButton.setAttribute("aria-expanded", "true");
    renderStatusCatalog();
    statusCatalogList.querySelector("input")?.focus();
  });
  document.getElementById("status-settings-close").addEventListener("click", closeStatusSettings);
  document.getElementById("status-reset").addEventListener("click", function () {
    setStatusItems(defaultStatusItems, "Default status items and order restored.");
  });
  statusSettings.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeStatusSettings(); }
  });

  function statusLabel(itemId) {
    const main = state.role === "main";
    const count = value => safeCountOrUndefined(value) === undefined ? "Unavailable" : value.toLocaleString("en-US");
    const goalLabels = { active: "In progress", paused: "Paused", blocked: "Input required", usageLimited: "Usage limit", budgetLimited: "Goal budget limit", complete: "Completed" };
    const executionLabels = { "cli-default": "CLI default", "workspace-write": "Workspace write", "danger-full-access": "Full access", bypass: "Full access · Bypass approvals", "read-only": "Read-only" };
    const supported = currentCapabilities();
    const labels = {
      agent: state.title,
      status: state.pendingDecisionRunId ? "User decision required" : state.running ? "Running" : state.runtimeAvailable ? "Idle" : "Connection unavailable",
      role: { main: "Main", work: "Work Agent", verification: "Verification Agent" }[state.role],
      agents: main ? state.workUnitsKnown ? "Work " + state.workUnits.workActive + " · Verification " + state.workUnits.verificationActive : "Agent status unavailable" : "Agent status: Main only",
      agentsTotal: main ? "Total agents " + (state.workUnitsKnown ? count(state.workUnits.totalCalled) : "Unavailable") : "Total agents: Main only",
      project: state.projectName || "Project —",
      branch: state.branch || "—",
      context: contextStatusLabel(),
      contextUsed: contextUsedStatusLabel(),
      contextRemainingTokens: contextRemainingTokensLabel(),
      contextUsedPercent: contextUsedPercentLabel(),
      contextWindow: "Content window " + (state.contextWindowTokens > 0 ? count(state.contextWindowTokens) : "Unavailable") + " tokens",
      weekly: "Weekly usage " + (state.weeklyUsedPercent === undefined ? "Unavailable" : formatPercent(state.weeklyUsedPercent)),
      weeklyRemaining: "Weekly remaining " + (state.weeklyUsedPercent === undefined ? "Unavailable" : formatPercent(100 - state.weeklyUsedPercent)),
      elapsed: state.running && state.runStartedAt ? "Elapsed " + formatElapsed(Math.max(0, Date.now() - state.runStartedAt)) : "Elapsed —",
      queue: "Queued messages " + Math.max(state.queueCount, (state.pendingRequests || []).length),
      runtime: state.runtimeAvailable ? "Runtime connected" : "Runtime disconnected",
      model: "Selected model " + (supported.model ? state.model || "Default" : "Support unknown"),
      reasoning: "Selected reasoning " + (supported.reasoning ? state.reasoning || "Default" : "Support unknown"),
      fast: "Fast " + (supported.fast ? state.fastMode ? "On" : "Off" : "Support unknown"),
      task: main ? "Next task " + taskModeNames[state.taskMode] : "Task mode: Main only",
      execution: "Permissions " + (executionLabels[state.executionMode] || "Unavailable"),
      goal: !main ? "Goal: Main only" : goalError ? "Goal unavailable" : nativeGoal ? "Goal " + (goalLabels[nativeGoal.status] || "Unavailable") : "Goal " + (state.goalMode ? "On · Goal unknown" : "Off"),
      goalTokens: "Goal " + (main && !goalError ? count(nativeGoal?.tokensUsed) : "Unavailable") + " tokens",
      goalBudget: "Goal budget " + (main && !goalError ? count(nativeGoal?.tokenBudget) : "Unavailable") + " tokens",
      goalTime: "Goal time " + (main && !goalError && safeCountOrUndefined(nativeGoal?.timeUsedSeconds) !== undefined ? formatElapsed(nativeGoal.timeUsedSeconds * 1000) : "Unavailable")
    };
    return labels[itemId] || itemId;
  }

  function renderPendingQueue() {
    const queue = document.getElementById("pending-message-queue");
    const toggle = document.getElementById("pending-queue-toggle");
    const label = document.getElementById("pending-queue-label");
    const pending = state.pendingRequests || [];
    const expanded = pending.length > 0 && toggle.getAttribute("aria-expanded") === "true";
    toggle.hidden = pending.length === 0;
    toggle.setAttribute("aria-expanded", String(expanded));
    label.textContent = "Queued " + pending.length;
    toggle.setAttribute("aria-label", "Queued messages " + pending.length + " items");
    toggle.title = "Queued messages " + pending.length + " items · Expand/collapse list";
    toggle.onclick = function () {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      queue.hidden = !open;
    };
    queue.hidden = !expanded;
    queue.replaceChildren();
    const description = document.createElement("p");
    description.className = "pending-queue-description";
    description.textContent = state.pendingDecisionRunId ? "Queued messages will run together after your decision" : "Queued messages run together. Task mode, model, and reasoning use the first message settings.";
    queue.append(description);
    if (pending.some(function (item) { return !item.rejected; }) && !state.running && !state.pendingDecisionRunId) {
      const resume = document.createElement("button");
      resume.type = "button";
      resume.textContent = "Check run status and resume queue";
      resume.addEventListener("click", function () { vscode.postMessage({ type: "queue.resume" }); });
      queue.append(resume);
    }
    pending.forEach(function (item) {
      const entry = document.createElement("p");
      entry.textContent = item.text + (item.attachments.length ? " · " + item.attachments.map(function (attachment) { return attachment.name; }).join(", ") : "");
      queue.append(entry);
      if (item.rejected) {
        const recover = document.createElement("button");
        recover.type = "button";
        recover.textContent = "Submission unconfirmed · Restore to input";
        recover.disabled = hasComposerContent();
        recover.addEventListener("click", function () {
          if (hasComposerContent()) return;
          state.pendingRequests = state.pendingRequests.filter(function (request) { return request.id !== item.id; });
          state.draft = item.text;
          prompt.value = item.text;
          state.attachments = item.attachments;
          state.taskMode = item.execution.taskMode || state.taskMode;
          state.model = item.execution.model;
          state.reasoning = item.execution.reasoningEffort;
          state.fastMode = item.execution.fast;
          state.goalMode = item.execution.goal;
          goalObjective.value = item.execution.goalObjective || "";
          renderAll();
          resizePrompt();
          persist();
        });
        queue.append(recover);
      }
    });
  }

  function updateSendButton() {
    sendButton.disabled = !state.runtimeAvailable || !state.capabilities || (!state.running && !hasComposerContent());
  }

  function updateRunControls() {
    renderPendingQueue();
    const queuesMessage = (state.running || (state.pendingRequests || []).length > 0) && hasComposerContent();
    updateExecutionControl();
    sendButton.classList.toggle("is-running", state.running && !queuesMessage);
    sendButton.setAttribute("aria-label", queuesMessage ? "Add message to queue" : state.running ? "Stop current run" : "Send message");
    sendButton.title = queuesMessage ? "Add to queue (Enter)" : state.running ? "Stop current run (Esc)" : "Send (Enter)";
    sendIcon.hidden = state.running && !queuesMessage;
    stopIcon.hidden = !state.running || queuesMessage;
    updateSessionControl();
    renderRunStatus();
    updateSendButton();
    renderGoal();
  }

  function hasComposerContent() {
    return prompt.value.trim().length > 0 || state.attachments.length > 0;
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
    const modeName = state.executionMode === undefined ? "Current session" : executionModeName(state.executionMode);
    executionModeButton.title = "Permissions: " + modeName + (state.running
      ? " · Permissions for the next message can be changed after execution finishes."
      : " · Select execution permissions for the next message");
    executionModeButton.setAttribute("aria-label", executionModeButton.title);
    if (state.running && openSettingId === "execution") closeSettingMenu(false);
  }

  function updateModeControls() {
    updateExecutionControl();
    workLoopButton.parentElement.hidden = state.role !== "main";
    workLoopButton.replaceChildren(createTaskModeIcon(state.taskMode));
    workLoopButton.title = "Task mode: " + taskModeNames[state.taskMode] + " · Select the mode for the next message";
    workLoopButton.setAttribute("aria-label", workLoopButton.title);
    const supported = currentCapabilities();
    modelButton.parentElement.hidden = supported.model !== true;
    reasoningButton.parentElement.hidden = supported.reasoning !== true;
    fastModeButton.hidden = supported.fast !== true;
    goalModeButton.hidden = supported.goal !== true || (state.role && state.role !== "main");
    if (openSettingId && openSettingId !== "execution" && openSettingId !== "task" && supported[openSettingId] !== true) closeSettingMenu(false);
    fastModeButton.setAttribute("aria-pressed", String(state.fastMode));
    fastModeButton.setAttribute("aria-label", state.fastMode ? "Fast mode on" : "Fast mode off");
    fastModeButton.title = state.fastMode ? "Fast mode on" : "Fast mode off";
    goalModeButton.setAttribute("aria-pressed", String(state.goalMode));
    goalModeButton.setAttribute("aria-label", state.goalMode ? "Goal mode on" : "Goal mode off");
    goalModeButton.title = state.goalMode ? "Goal mode on" : "Goal mode off";
    modelLabel.textContent = state.model || "Default";
    reasoningLabel.textContent = state.reasoning || "Default";
    renderGoal();
    renderStatusBar();
  }

  function renderGoal() {
    goalPanel.hidden = state.role !== "main" || (!state.goalMode && !nativeGoal && !goalError);
    const labels = { active: "In progress", paused: "Paused", blocked: "Input required", usageLimited: "Usage limit", budgetLimited: "Goal budget limit", complete: "Goal completed" };
    goalStatus.textContent = goalError || (nativeGoal
      ? `${labels[nativeGoal.status] || nativeGoal.status} · ${nativeGoal.tokensUsed.toLocaleString("en-US")} tokens · ${nativeGoal.timeUsedSeconds}s\n${nativeGoal.objective}`
      : "Enable Goal and send a message.");
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
    const selected = menu.querySelector('[aria-checked="true"]:not(:disabled)');
    (selected || menu.querySelector("button:not(:disabled)"))?.focus();
  }

  function renderSettingMenu(setting, menu) {
    const current = setting === "task" ? state.taskMode : setting === "model" ? state.model : setting === "reasoning" ? state.reasoning : state.executionMode ?? "cli-default";
    menu.replaceChildren();
    const values = setting === "model" ? [...new Set([...settingOptions.model, state.model])] : settingOptions[setting];
    for (const value of values) {
      const option = document.createElement("button");
      option.type = "button";
      option.disabled = setting === "task" && !currentCapabilities().taskModes?.includes(value);
      if (option.disabled) option.title = "This mode requires a compatible plugin and Codex version.";
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
      label.textContent = setting === "task" ? taskModeNames[value] : setting === "execution" ? executionModeName(value) : value || "Default";
      if (setting === "task") {
        option.append(createTaskModeIcon(value), label, check);
      } else {
        option.append(check, label);
      }
      option.addEventListener("click", function () {
        if (setting === "task") {
          state.taskMode = value;
        } else if (setting === "model") {
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

  function createTaskModeIcon(mode) {
    const paths = {
      direct: "m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z",
      work: "M14 6a5 5 0 0 0-6 6L3 17a2.8 2.8 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z",
      "work-verification": "M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6l-8-3Zm-4 9 3 3 5-6",
      "plan-work-verification": "M14 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6M8 7h6M8 11h4M8 15h2m4 2 3 3 5-6"
    };
    return createModeIcon(paths[mode] || paths.work, "task-mode-icon");
  }

  function createModeIcon(pathData, className) {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.classList.add(className);
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    icon.append(path);
    return icon;
  }

  function handleSettingMenuKeydown(event) {
    const options = Array.from(event.currentTarget.parentElement.querySelectorAll(".setting-option:not(:disabled)"));
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
    return setting === "task" ? workLoopButton : setting === "model" ? modelButton : setting === "reasoning" ? reasoningButton : executionModeButton;
  }

  function settingMenu(setting) {
    return setting === "task" ? taskModeMenu : setting === "model" ? modelMenu : setting === "reasoning" ? reasoningMenu : executionModeMenu;
  }

  function executionModeName(mode) {
    return ({
      "read-only": "Read-only",
      "cli-default": state.agentId ? "Keep current policy" : "CLI default",
      "workspace-write": "Workspace write",
      "danger-full-access": "Full access",
      "bypass": "Bypass"
    })[mode] || (state.agentId ? "Keep current policy" : "CLI default");
  }

  function resizePrompt() {
    prompt.style.height = "auto";
    prompt.style.height = Math.min(prompt.scrollHeight, 280) + "px";
  }

  function persist() {
    vscode.setState({
      startedMessageIds: state.startedMessageIds,
      pendingRequests: state.pendingRequests,
      panelId: state.panelId,
      agentId: state.agentId,
      title: state.title,
      role: state.role,
      verifiedWorkRunId: state.verifiedWorkRunId,
      draft: state.draft,
      autoScroll: state.autoScroll,
      attachments: state.attachments.filter(function (attachment) {
        return !attachment.pending && !attachment.previewUri?.startsWith("blob:");
      }).map(function (attachment) {
        if (attachment.kind !== "image") return attachment;
        const { previewUri, ...persisted } = attachment;
        return persisted;
      }),
      timeline: state.timeline.slice(-200).map(function (event) {
        if (!Array.isArray(event.attachments)) return event;
        return {
          ...event,
          attachments: event.attachments.map(function (attachment) {
            if (attachment.kind !== "image") return attachment;
            const { previewUri, pending, ...persisted } = attachment;
            return persisted;
          })
        };
      }),
      statusItems: state.statusItems,
      projectName: state.projectName,
      runtimeAvailable: state.runtimeAvailable,
      running: state.running,
      model: state.model,
      reasoning: state.reasoning,
      fastMode: state.fastMode,
      goalMode: state.goalMode,
      taskMode: state.taskMode,
      workLoopMode: state.workLoopMode,
      contextUsedTokens: state.contextUsedTokens,
      contextWindowTokens: state.contextWindowTokens,
      weeklyUsedPercent: state.weeklyUsedPercent,
      runProgress: state.runProgress,
      runStartedAt: state.runStartedAt,
      runPanelExpanded: state.runPanelExpanded,
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
    if (!Array.isArray(value)) return defaultStatusItems.slice();
    const items = [...new Set(value.filter(item => typeof item === "string" && Object.hasOwn(statusCatalog, item)))];
    return value.length === 0 || items.length ? items : defaultStatusItems.slice();
  }

  function saveComposerSettings() {
    vscode.postMessage({
      type: "composer.settings",
      model: state.model || undefined,
      reasoning: state.reasoning || undefined,
      fastMode: state.fastMode,
      goalMode: state.goalMode,
      taskMode: state.taskMode,
      workLoopMode: state.workLoopMode
    });
  }

  function contextStatusLabel() {
    if (state.contextUsedTokens === undefined || !(state.contextWindowTokens > 0)) return "Content remaining unavailable";
    const remaining = Math.max(0, state.contextWindowTokens - state.contextUsedTokens);
    return "Content remaining " + formatPercent(remaining / state.contextWindowTokens * 100);
  }

  function contextUsedStatusLabel() {
    return "Content tokens used " + (state.contextUsedTokens === undefined
      ? "Unavailable" : state.contextUsedTokens.toLocaleString("en-US") + " tokens");
  }

  function contextRemainingTokensLabel() {
    if (state.contextUsedTokens === undefined || !(state.contextWindowTokens > 0)) return "Content tokens remaining unavailable";
    return "Content tokens remaining " + Math.max(0, state.contextWindowTokens - state.contextUsedTokens).toLocaleString("en-US") + " tokens";
  }

  function contextUsedPercentLabel() {
    return "Content used " + (state.contextUsedTokens === undefined || !(state.contextWindowTokens > 0)
      ? "Unavailable" : formatPercent(state.contextUsedTokens / state.contextWindowTokens * 100));
  }

  function formatPercent(value) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 1 }) + "%";
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
    meter.setAttribute("aria-label", "Content remaining percentage");
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    meter.setAttribute("aria-valuenow", String(remainingRatio * 100));
    const fill = document.createElement("span");
    fill.className = "context-token-meter-fill";
    fill.style.width = remainingRatio * 100 + "%";
    fill.dataset.level = remainingRatio < 0.1 ? "critical" : remainingRatio < 0.3 ? "warning" : "healthy";
    meter.append(fill);
    item.replaceChildren(label, meter);
  }

  function normalizeModel(value) {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) ? value : "";
  }

  function safePercentOrUndefined(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
      ? value
      : undefined;
  }

  function normalizeSettingValue(value, allowedValues) {
    return typeof value === "string" && allowedValues.includes(value) ? value : "";
  }

  function createId() {
    return globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
})();
