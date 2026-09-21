(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  let persistenceScheduled = false;
  let persistenceTimer;
  let composerLayoutFrame;
  let timelineRenderFrame;
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) scheduleTimelineRender();
    else persist();
  });

  window.addEventListener("pagehide", function () {
    persist();
  });

  let displayLanguage = vscode.getState()?.uiLanguage || "auto";
  function uiLocale() { return globalThis.AgentFactoryI18n.locale(displayLanguage, document.documentElement.dataset.hostLanguage || navigator.language); }
  function t(key, ...values) { return globalThis.AgentFactoryI18n.format(key, uiLocale(), ...values); }
  function localizedText(value, descriptor) { return globalThis.AgentFactoryI18n.resolve(descriptor, uiLocale(), value); }
  function reasoningDisplayLabel(value) { return value ? uiLocale() === "en" ? value : t("ui." + value) : t("ui.default"); }

  const markdown = typeof globalThis.markdownit === "function"
    ? globalThis.markdownit({ html: false, linkify: true, typographer: false })
    : undefined;
  const timeline = document.getElementById("timeline");
  const jumpToBottom = document.getElementById("jump-to-bottom");
  let commandDisclosureObserver;
  let commandDisclosureFrame;
  let commandOutputObserver;
  let commandOutputFrame;
  const emptyState = document.getElementById("empty-state");
  const prompt = document.getElementById("prompt");
  const promptSurface = prompt.closest(".prompt-surface");
  const sendButton = document.getElementById("send-button");
  const sendIcon = document.getElementById("send-icon");
  const stopIcon = document.getElementById("stop-icon");
  const attachButton = document.getElementById("attach-button");
  const autoScrollButton = document.getElementById("auto-scroll-button");
  const autoScrollState = document.getElementById("auto-scroll-state");
  const modelButton = document.getElementById("model-button");
  const modelLabel = document.getElementById("model-label");
  const submissionButton = document.getElementById("submission-button");
  const submissionMenu = document.getElementById("submission-menu");
  const inputFeedback = document.getElementById("input-feedback");
  const modelMenu = document.getElementById("model-menu");
  const fastModeButton = document.getElementById("fast-mode-button");
  const businessModeNames = () => ({ normal: t("ui.normal"), interview: t("ui.interview"), planning: t("ui.planning"), design: t("ui.design") });
  const taskModeNames = () => ({ plan: t("ui.plan"), verification: t("ui.verification"), direct: t("ui.direct"), work: t("ui.work"), "plan-work": t("ui.plan.work"), "work-verification": t("ui.work.verification"), "plan-work-verification": t("ui.plan.work.verification") });
  let nativeGoal = null;
  let goalError;
  const sessionMenu = document.getElementById("session-menu");
  const sessionList = document.getElementById("session-list");
  const questionButton = document.getElementById("question-button");
  const questionMenu = document.getElementById("question-menu");
  const questionList = document.getElementById("question-list");
  const factoryBot = document.getElementById("factory-bot");
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
    task: ["work", "plan", "verification", "plan-work", "work-verification", "plan-work-verification"],
    business: ["interview", "planning", "design"],
    model: [""],
    reasoning: ["", "none", "low", "medium", "high", "xhigh", "max"],
    execution: ["cli-default", "workspace-write", "danger-full-access", "bypass"]
  };
  const defaultStatusItems = ["status", "agents", "project", "branch", "context", "queue"];
  const statusCatalog = () => ({
    status: [t("ui.run.status"), t("ui.current.running.queued.or.decision.status")],
    agents: [t("ui.active.agents"), t("ui.number.of.main.agent.work.and.verification.agents")],
    project: [t("ui.project"), t("ui.current.vs.code.workspace.name")],
    branch: [t("ui.git.branch"), t("ui.current.project.branch.or.when.unknown")],
    context: [t("ui.content.remaining.percentage"), t("ui.remaining.percentage.of.the.content.window.unavailable.without.usage.or.window.size")],
    queue: [t("ui.queued.messages"), t("ui.number.of.messages.waiting.to.send.in.this.chat")],
    agent: [t("ui.chat.name"), t("ui.current.chat.tab.name")],
    role: [t("ui.agent.role"), t("ui.main.work.or.verification.role")],
    elapsed: [t("ui.elapsed.time"), t("ui.time.observed.for.the.current.run.in.this.view.shown.only.while.running")],
    runtime: [t("ui.runtime.connection"), t("ui.current.runtime.connection.status")],
    model: [t("ui.selected.model"), t("ui.selection.for.the.next.message.may.differ.from.the.actual.server.model")],
    reasoning: [t("ui.selected.reasoning.effort"), t("ui.selection.for.the.next.message")],
    fast: [t("ui.fast.setting"), t("ui.fast.selection.for.the.next.message.subject.to.support")],
    task: [t("ui.task.mode"), t("ui.task.mode.for.the.next.main.agent.message")],
    execution: [t("ui.execution.permissions"), t("ui.permission.settings.reported.by.the.current.host")],
    contextUsed: [t("ui.content.tokens.used"), t("ui.current.content.tokens.used.input.tokens.for.the.latest.turn.not.cumulative.usage")],
    contextRemainingTokens: [t("ui.content.tokens.remaining"), t("ui.content.window.size.minus.current.tokens.used.with.a.minimum.of.0")],
    contextUsedPercent: [t("ui.content.used.percentage"), t("ui.current.usage.as.a.percentage.of.the.content.window")],
    contextWindow: [t("ui.content.window.tokens"), t("ui.model.content.window.size.reported.by.the.runtime")],
    weekly: [t("ui.weekly.usage"), t("ui.latest.reported.usage.percentage.of.the.7.day.account.limit.if.available")],
    weeklyRemaining: [t("ui.weekly.remaining"), t("ui.100.minus.weekly.usage.an.absolute.token.count.is.not.provided")],
    agentsTotal: [t("ui.total.agent.calls"), t("ui.number.of.work.and.verification.agents.called.by.main.agent")],
    goal: [t("ui.goal.status"), t("ui.main.agent.goal.setting.and.latest.reported.goal.status")],
    goalTokens: [t("ui.goal.tokens.used"), t("ui.cumulative.tokens.used.as.reported.by.the.goal")],
    goalTime: [t("ui.goal.time.used"), t("ui.cumulative.time.used.as.reported.by.the.goal")],
    goalBudget: [t("ui.goal.token.budget"), t("ui.token.budget.assigned.to.the.goal.if.available")]
  });
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
    conversationId: typeof saved?.conversationId === "string" ? saved.conversationId : undefined,
    title: typeof saved?.title === "string" ? saved.title : "Main Agent",
    role: ["main", "work", "verification"].includes(saved?.role) ? saved.role : "main",
    verifiedWorkRunId: typeof saved?.verifiedWorkRunId === "string" ? saved.verifiedWorkRunId : undefined,
    draft: typeof saved?.draft === "string" ? saved.draft : "",
    autoScroll: saved?.autoScroll !== false,
    uiLanguage: ["auto", "ko", "en"].includes(saved?.uiLanguage) ? saved.uiLanguage : "auto",
    botsEnabled: false,
    botVisible: saved?.botVisible !== false,
    botAnimations: saved?.botAnimations !== false,
    attachments: Array.isArray(saved?.attachments) ? saved.attachments.filter(function (item) {
      return item && !item.pending && !item.previewUri?.startsWith("blob:") && item.data === undefined;
    }) : [],
    startedMessageIds: Array.isArray(saved?.startedMessageIds) ? saved.startedMessageIds : [],
    pendingRequests: Array.isArray(saved?.pendingRequests) ? saved.pendingRequests : [],
    timeline: collapseAdjacentReads(collapseCancellationNotices(Array.isArray(saved?.timeline) ? saved.timeline : [])),
    statusItems: normalizeStatusItems(saved?.statusItems),
    projectName: typeof saved?.projectName === "string" ? saved.projectName : "",
    pendingDecisionRunId: undefined,
    pendingDecisionCanApprove: false,
    decisionSubmitting: false,
    executionMode: saved?.agentId ? undefined : "danger-full-access",
    runtimeAvailable: false,
    branch: undefined,
    capabilities: undefined,
    running: saved?.running === true,
    agentModels: saved?.agentModels || {},
    model: normalizeModel(saved?.model),
    reasoning: normalizeSettingValue(saved?.reasoning, settingOptions.reasoning),
    fastMode: saved?.fastMode === true,
    goalMode: false,
    businessMode: "normal",
    taskMode: "direct",
    workLoopMode: false,
    queueCount: 0,
    contextUsedTokens: safeCountOrUndefined(saved?.contextUsedTokens),
    contextWindowTokens: safeCountOrUndefined(saved?.contextWindowTokens),
    weeklyUsedPercent: safePercentOrUndefined(saved?.weeklyUsedPercent),
    runProgress: typeof saved?.runProgress === "string" ? saved.runProgress : "",
    runProgressLocalization: saved?.runProgressLocalization,
    runStartedAt: Number.isFinite(saved?.runStartedAt) ? saved.runStartedAt : undefined,
    taskFlows: Array.isArray(saved?.taskFlows) ? saved.taskFlows.slice(-100) : [],
    runPanelExpanded: saved?.runPanelExpanded === true,
    sessions: [],
    sessionsLoading: false,
    historyNextBefore: saved?.historyNextBefore,
    workflows: Array.isArray(saved?.workflows) ? saved.workflows : [],
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
  let botOutcome;
  let botWaveTimer;
  let botIdleTimer;
  let botIdleSince;
  let botGestureTimer;
  const botMenu = document.getElementById("bot-menu");
  let botReactionTimer;
  let botGestureKey;
  let botGlanceTimer;
  let botNextGlanceAt = 0;
  const botReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let elapsedTimerId;
  let followLatest = true;
  let autoScrollFrame;
  let timelineViewportHeight;
  const taskFlowParseCache = new WeakMap();
  let taskFlowSnapshot;
  const messageRenderKeys = new WeakMap();
  const messageElements = new Map();
  const messageViewStates = new Map();
  let timelineEndId;


  globalThis.AgentFactoryI18n.apply(document, uiLocale());
  document.documentElement.lang = uiLocale();
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

  document.addEventListener("pointermove", maybeGlanceAtPointer, { passive: true });
  document.documentElement.addEventListener("pointerleave", clearBotGlance);
  window.addEventListener("blur", clearBotGlance);
  document.addEventListener("visibilitychange", function () {
    clearBotGlance();
    document.documentElement.dataset.afHidden = String(document.hidden);
    if (document.hidden && elapsedTimerId) {
      clearInterval(elapsedTimerId);
      elapsedTimerId = undefined;
    }
    if (!document.hidden) renderRunStatus();
  });
  botReducedMotion.addEventListener("change", clearBotGlance);
  factoryBot.addEventListener("pointerenter", wakeFactoryBot);

  function closeBotMenu(restoreFocus = false) {
    botMenu.hidden = true;
    factoryBot.setAttribute("aria-expanded", "false");
    if (restoreFocus) factoryBot.focus();
  }
  function positionBotMenu() {
    if (botMenu.hidden) return;
    const box = factoryBot.getBoundingClientRect();
    botMenu.style.left = Math.max(8, Math.min(window.innerWidth - botMenu.offsetWidth - 8, box.right - botMenu.offsetWidth)) + "px";
    botMenu.style.top = Math.max(8, box.top - botMenu.offsetHeight - 8) + "px";
  }
  window.addEventListener("resize", positionBotMenu);
  document.addEventListener("pointerdown", function (event) {
    if (!botMenu.contains(event.target) && !factoryBot.contains(event.target)) closeBotMenu();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !botMenu.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeBotMenu(true);
    }
  }, true);
  botMenu.addEventListener("click", function (event) {
    const button = event.target.closest("[data-bot-action]");
    if (!button || button.disabled || factoryBot.dataset.state !== "idle") return;
    const action = button.dataset.botAction;
    closeBotMenu(true);
    clearBotGlance();
    clearTimeout(botGestureTimer);
    botGestureTimer = undefined;
    if (action === "sleep") {
      botIdleSince = Date.now() - 60000;
      renderFactoryBot();
    } else {
      delete factoryBot.dataset.gesture;
      factoryBot.getBoundingClientRect();
      factoryBot.dataset.gesture = action;
      botGestureTimer = window.setTimeout(function () {
        botGestureTimer = undefined;
        renderFactoryBot();
      }, 8000);
    }
  });
  factoryBot.addEventListener("click", function () {
    const opening = botMenu.hidden;
    wakeFactoryBot();
    clearTimeout(botReactionTimer);
    delete factoryBot.dataset.reacting;
    // Restart the short response on repeated clicks without resetting task state.
    factoryBot.getBoundingClientRect();
    factoryBot.dataset.reacting = "true";
    botReactionTimer = window.setTimeout(function () {
      delete factoryBot.dataset.reacting;
      botReactionTimer = undefined;
    }, 700);
    botMenu.hidden = !opening;
    factoryBot.setAttribute("aria-expanded", String(opening));
    if (opening) {
      positionBotMenu();
      const first = botMenu.querySelector("button:not(:disabled)");
      if (first) first.focus();
    }
  });
  document.addEventListener("pointerdown", wakeFactoryBot);
  document.addEventListener("keydown", wakeFactoryBot);
  document.addEventListener("input", wakeFactoryBot);

  prompt.addEventListener("input", function () {
    state.draft = prompt.value;
    persist(false, 150);
    if (composerLayoutFrame !== undefined) return;
    composerLayoutFrame = requestAnimationFrame(function () {
      composerLayoutFrame = undefined;
      resizePrompt();
      updateRunControls();
    });
  });
  prompt.addEventListener("blur", function () { persist(); });

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
    // Let the native picker return to the existing draft and selection.
    prompt.focus({ preventScroll: true });
    document.getElementById("attachment-file-input").click();
  });
  document.getElementById("attachment-file-input").addEventListener("change", async function (event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    let bytes = 0;
    for (const file of files) {
      if (!file.name || file.name.length > 255 || /[\\/\x00-\x1f]/.test(file.name) || [".", ".."].includes(file.name)) {
        appendNotice("error", t("ui.local.file.read.failed"));
        continue;
      }
      if (state.attachments.length >= 100 || file.size > 10 * 1024 * 1024 || bytes + file.size > 20 * 1024 * 1024) {
        appendNotice("error", t("ui.local.file.limit"));
        continue;
      }
      bytes += file.size;
      if (file.type.startsWith("image/")) {
        await addBrowserImages([file]);
        continue;
      }
      const id = createId();
      addAttachments([{ id, name: file.name, kind: "file", size: file.size, pending: true }]);
      try {
        const data = await readDataUrl(file);
        vscode.postMessage({ type: "attachments.createFile", id, name: file.name, size: file.size, data: data.slice(data.indexOf(",") + 1) });
      } catch {
        state.attachments = state.attachments.filter(item => item.id !== id);
        appendNotice("error", t("ui.local.file.read.failed"));
        renderAttachments();
        persist();
      }
    }
  });
  modelButton.addEventListener("click", function () {
    openSetting("model");
  });
  submissionButton.addEventListener("click", function () { openSetting("submission"); });
  fastModeButton.addEventListener("click", function () { toggleMode("fastMode"); });
  prompt.addEventListener("input", function () { inputFeedback.hidden = true; });
  questionButton.addEventListener("click", function () {
    if (questionMenu.hidden) {
      openQuestionMenu();
    } else {
      closeQuestionMenu(true);
    }
  });

  function updateJumpToBottom() {
    jumpToBottom.hidden = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 24;
  }

  jumpToBottom.addEventListener("click", function () {
    followLatest = true;
    updateAutoScrollControl();
    timeline.scrollTop = timeline.scrollHeight;
    prompt.focus({ preventScroll: true });
    updateJumpToBottom();
  });
  timeline.addEventListener("scroll", function () {
    // Layout changes can emit scroll events before ResizeObserver runs.
    // Preserve the previous follow intent until the new viewport is handled.
    if (timelineViewportHeight === timeline.clientHeight) {
      followLatest = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 24;
    }
    updateAutoScrollControl();
    updateJumpToBottom();
  }, { passive: true });
  timeline.addEventListener("toggle", updateJumpToBottom, true);
  timeline.addEventListener("load", updateJumpToBottom, true);
  timelineViewportHeight = timeline.clientHeight;
  new ResizeObserver(function () {
    timelineViewportHeight = timeline.clientHeight;
    if (state.autoScroll && followLatest) timeline.scrollTop = timeline.scrollHeight;
    updateAutoScrollControl();
    updateJumpToBottom();
  }).observe(timeline);
  new MutationObserver(updateJumpToBottom).observe(timeline, { childList: true, subtree: true, characterData: true });
  updateJumpToBottom();

  autoScrollButton.addEventListener("click", function () {
    state.autoScroll = !state.autoScroll;
    cancelAnimationFrame(autoScrollFrame);
    if (state.autoScroll) {
      followLatest = true;
      timeline.scrollTop = timeline.scrollHeight;
    }
    updateAutoScrollControl();
    persist();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      // Let the native picker consume Escape before closing its settings dialog.
      if (CSS.supports("selector(select:open)") && document.querySelector("#model-menu select:open, #status-settings select:open")) return;
      if (!statusSettings.hidden) { event.preventDefault(); closeStatusSettings(); return; }
      const history = document.getElementById("task-history");
      if (history.open) {
        event.preventDefault();
        history.open = false;
        history.querySelector("summary").focus();
        return;
      }
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
    const history = document.getElementById("task-history");
    if (!event.target.closest("#task-history")) history.open = false;
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
    if (document.activeElement === document.body || document.activeElement === attachButton) {
      prompt.focus({ preventScroll: true });
    }
    addDroppedData(event.dataTransfer);
  });

  window.addEventListener("message", function (event) {
    const message = event.data;
    if (!message || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "host.initialize":
        const incomingConversationId = typeof message.conversationId === "string" ? message.conversationId : undefined;
        const conversationBoundaryChanged = Boolean(incomingConversationId && incomingConversationId !== state.conversationId);
        state.panelId = message.panelId;
        state.title = message.title;
        state.role = ["main", "work", "verification"].includes(message.role) ? message.role : "main";
        state.verifiedWorkRunId = typeof message.verifiedWorkRunId === "string" ? message.verifiedWorkRunId : undefined;
        document.body.dataset.agentRole = state.role;
        state.projectName = message.projectName;
        state.runtimeAvailable = message.runtimeAvailable === true;
        if (message.resetConversation === true || conversationBoundaryChanged) resetConversationState();
        state.conversationId = incomingConversationId ?? state.conversationId;
        state.capabilities = message.capabilities;
        if (currentCapabilities().diagnostic) appendNotice("warning", currentCapabilities().diagnostic);
        state.running = message.running === true;
        state.model = normalizeModel(message.model);
        state.agentModels = message.agentModels || state.agentModels || {};
        state.reasoning = normalizeSettingValue(message.reasoning, settingOptions.reasoning);
        state.businessMode = "normal";
        state.taskMode = "direct";
        state.fastMode = message.fastMode === true;
        state.workLoopMode = false;
        if (!conversationBoundaryChanged && message.resetConversation !== true) {
          state.contextUsedTokens = safeCountOrUndefined(message.contextUsedTokens);
          state.contextWindowTokens = safeCountOrUndefined(message.contextWindowTokens);
          state.weeklyUsedPercent = safePercentOrUndefined(message.weeklyUsedPercent);
        }
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
          if (currentTaskFlows().length === 0) state.runPanelExpanded = false;
        }
        state.botsEnabled = message.botsEnabled !== false;
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
            const focused = modelMenu.contains(document.activeElement) ? { role: document.activeElement.dataset.role, field: document.activeElement.dataset.field } : undefined;
            renderSettingMenu("model", modelMenu);
            if (focused?.role && focused?.field) modelMenu.querySelector('[data-role="' + focused.role + '"][data-field="' + focused.field + '"]')?.focus();
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
      case "image.resolved":
        for (const img of document.querySelectorAll("img[data-local-image]")) {
          if (img.dataset.localImage !== message.href) continue;
          if (message.src && /^data:image\/(png|jpeg|gif|webp);base64,/.test(message.src)) img.src = message.src;
          else { img.alt = t("image.unavailable", img.alt || t("image.default")); }
        }
        break;
      case "host.notice":
        if (message.level === "error") { botOutcome = "failed"; renderFactoryBot(); }
        appendNotice(message.level, message.text, message.localization?.text);
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
            state.conversationId = message.conversationId;
            state.contextUsedTokens = undefined;
            state.contextWindowTokens = undefined;
            state.weeklyUsedPercent = undefined;
            state.workUnitsKnown = false;
            nativeGoal = null;
            goalError = undefined;
            state.pendingDecisionRunId = undefined;
            state.decisionSubmitting = false;
            state.historyNextBefore = undefined;
            timelineEndId = undefined;
            messageViewStates.clear();
            state.timeline = [];
            state.taskFlows = [];
            followLatest = true;
            renderTimeline();
          }
          updateModeControls();
          closeSessionMenu(false);
          persist();
        }
        break;
      case "conversation.cleared":
        if (typeof message.conversationId === "string" && message.conversationId) {
          const pendingRequests = state.pendingRequests;
          resetConversationState();
          state.pendingRequests = pendingRequests;
          state.conversationId = message.conversationId;
          renderAll();
          persist();
        }
        break;
      case "conversation.history":
        if (message.agentId === state.agentId && message.history &&
            message.history.conversationId === state.conversationId &&
            Array.isArray(message.history.messages)) {
          state.historyNextBefore = message.history.nextBefore;
          const restored = message.history.messages.filter(function (item) {
            return item && ["user", "assistant"].includes(item.type) &&
              typeof item.id === "string" && typeof item.runId === "string" && typeof item.text === "string";
          });
          if (!state.timeline.some(function (item) { return ["user", "assistant", "activity"].includes(item.type); })) {
            state.timeline = restored;
          } else {
            const knownRuns = new Set(state.timeline.map(item => item.runId).filter(Boolean));
            const knownIds = new Set(state.timeline.map(item => item.id));
            state.timeline = [...restored.filter(item => !knownIds.has(item.id) && !knownRuns.has(item.runId)), ...state.timeline];
            // Repair raw or partially separated history only when the exact
            // captured request matches. Live messages remain untouched.
            const byId = new Map(restored.map(function (item) { return [item.id, item]; }));
            state.timeline = state.timeline.map(function (item) {
              const replacement = byId.get(item.id);
              return item.type === "user" && item.id?.startsWith("history-user-") &&
                replacement?.submission && item.text !== replacement.text &&
                item.text + (item.submission?.guidance || "") === replacement.text + (replacement.submission.guidance || "")
                ? replacement : item;
            });
          }
          if (state.historyBrowsing && restored.length) {
            timelineEndId = restored[restored.length - 1].id;
            followLatest = false;
          }
          state.historyBrowsing = false;
          scheduleTimelineRender();
          persist(false);
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
        if (Array.isArray(message.workflows)) {
          // A temporarily incomplete session discovery must not erase accepted history.
          const key = snapshot => snapshot.loopId || snapshot.workflow?.id;
          const snapshots = new Map((state.workflows || []).map(snapshot => [key(snapshot), snapshot]));
          for (const snapshot of message.workflows) snapshots.set(key(snapshot), snapshot);
          state.workflows = [...snapshots.values()].slice(-100);
        }
        state.childAgents = Array.isArray(message.agents) ? message.agents.filter(isChildAgent) : [];
        state.workUnits = summarizeChildAgents(state.childAgents);
        renderAgentsList();
        renderRunStatus();
        renderWorkLoopPanel();
        scheduleTimelineRender();
        renderStatusBar();
        persist(false);
        break;
      case "decision.pending":
        state.pendingDecisionCanApprove = Boolean(message.runId) && message.canApprove === true;
        state.pendingDecisionRunId = typeof message.runId === "string" ? message.runId : undefined;
        state.decisionSubmitting = false;
        renderPendingQueue();
        scheduleTimelineRender();
        renderStatusBar();
        updateConversationClearControl();
        break;
      case "chat.human-decision":
        if (typeof message.text === "string" && message.text) {
          state.timeline.push({ type: "user", id: createId(), text: message.text, submission: message.submission });
          scheduleTimelineRender();
          persist(false);
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
          if (isDuplicateCancellation(state.timeline.at(-1), { ...message, type: "assistant" })) break;
          const incomingFlows = extractTaskFlows(message.text).flows;
          if (incomingFlows.length) {
            const snapshots = new Map(currentTaskFlows().map(flow => [flow.id, flow]));
            for (const flow of incomingFlows) snapshots.set(flow.id, flow);
            state.taskFlows = [...snapshots.values()].slice(-100);
          }
          state.timeline.push({ type: "assistant", id: createId(), text: message.text, localization: message.localization?.text, runId: message.runId, phase: message.phase === "commentary" ? "commentary" : "final" });
          scheduleTimelineRender();
          renderRunStatus();
          renderWorkLoopPanel();
          persist(false);
        }
        break;
      case "bots.updated":
        state.botsEnabled = message.enabled === true;
        renderFactoryBot();
        break;
      case "bot.mood":
        if (!state.botsEnabled) break;
        factoryBot.dataset.mood = ["calm", "curious", "cheerful", "focused"].includes(message.mood) ? message.mood : "";
        factoryBot.dataset.brain = factoryBot.dataset.mood ? "luna" : message.unavailable === true ? "unavailable" : "local";
        renderFactoryBot();
        break;
      case "run.observed":
        botOutcome = message.status;
        renderFactoryBot();
        break;
      case "run.state":
        if (message.running === true && !state.running) {
          botOutcome = undefined;
          clearTimeout(botWaveTimer);
          botWaveTimer = undefined;
        }
        state.running = message.running === true;
        state.runProgress = state.running ? (state.runProgress || t("ui.starting.main.agent")) : "";
        state.runProgressLocalization = globalThis.AgentFactoryI18n.describe(state.runProgress) || state.runProgressLocalization;
        if (state.running && !state.runStartedAt) {
          state.runStartedAt = Date.now();
        } else if (!state.running) {
          state.runStartedAt = undefined;
        }
        updateRunControls();
        renderWorkLoopPanel();
        scheduleTimelineRender();
        renderStatusBar();
        persist(false);
        break;
      case "chat.rejected": {
        const pending = (state.pendingRequests || []).find(function (item) { return item.id === message.id; });
        if (pending) pending.rejected = true;
        renderPendingQueue();
        persist(false);
        break;
      }
      case "chat.started": {
        const pending = (state.pendingRequests || []).find(function (item) { return item.id === message.id; });
        state.pendingRequests = (state.pendingRequests || []).filter(function (item) { return item.id !== message.id; });
        const revealSubmission = Boolean(pending) && !(state.startedMessageIds || []).includes(message.id) &&
          !state.timeline.some(item => item.type === "user" && item.id === message.id);
        if (revealSubmission) followLatest = true;
        if (!(state.startedMessageIds || []).includes(message.id) && !state.timeline.some(function (item) { return item.type === "user" && item.id === message.id; })) {
          state.timeline.push({ type: "user", id: message.id,
            text: message.text || message.attachments.map(function (item) { return t("ui.attachments.c53076") + item.name; }).join("\n"),
            submission: message.submission || submissionFromExecution(pending?.execution),
            attachments: pending ? pending.attachments : message.attachments });
          state.pendingDecisionRunId = undefined;
          state.decisionSubmitting = false;
          // Keep accepted background workflows during a new Main conversation turn.
          state.workUnits = summarizeChildAgents([]);
          state.runStartedAt = Date.now();
          state.runProgress = t("ui.main.agent.running");
          state.runProgressLocalization = globalThis.AgentFactoryI18n.describe(state.runProgress);
        }
        const acknowledged = state.timeline.find(function (item) { return item.type === "user" && item.id === message.id; });
        if (acknowledged && message.submission) acknowledged.submission = message.submission;
        state.startedMessageIds = [...new Set([...(state.startedMessageIds || []), message.id])].slice(-400);
        renderAll();
        // Acceptance inserts the submitted request after the initial send scroll.
        // Reveal that request once, without changing the automatic-scroll preference.
        if (revealSubmission) {
          timeline.scrollTop = timeline.scrollHeight;
          updateAutoScrollControl();
          updateJumpToBottom();
        }
        persist(false);
        break;
      }
      case "queue.updated":
        renderPendingQueue();
        state.queueCount = safeCount(message.count);
        updateConversationClearControl();
        renderStatusBar();
        updateSendButton();
        break;
      case "run.progress":
        if (typeof message.text === "string" && message.text) {
          state.runProgress = message.text;
          state.runProgressLocalization = message.localization?.text;
          renderRunStatus();
          persist(false);
        }
        break;
      case "context.usage":
        state.contextUsedTokens = safeCountOrUndefined(message.usedTokens);
        state.contextWindowTokens = safeCountOrUndefined(message.contextWindowTokens);
        state.weeklyUsedPercent = safePercentOrUndefined(message.weeklyUsedPercent);
        renderStatusBar();
        persist(false);
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
          persist(false);
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
        persist(false);
        break;
    }
  });

  function submit(action = "direct", workflow = "normal", asGoal = false, choiceAnswer = null) {
    if (!Object.hasOwn(taskModeNames(), action)) action = "direct";
    const userText = choiceAnswer ?? prompt.value.trim();
    if (!userText && state.attachments.length === 0) {
      inputFeedback.textContent = t("ui.enter.what.you.want.help.with.include.the.target.and.desired.result.for.example.fix.the.login.error.in.this.file");
      inputFeedback.hidden = false;
      prompt.focus();
      return;
    }
    inputFeedback.hidden = true;
    let text = userText;
    const goal = state.role === "main" && action !== "verification" && currentCapabilities().goal === true && asGoal === true;
    if (goal && (!text || text.length > 4000)) {
      inputFeedback.textContent = text ? t("ui.shorten.the.goal.to.4.000.characters") : t("ui.describe.the.goal.you.want.to.achieve.for.example.make.the.attached.page.usable.on.mobile");
      inputFeedback.hidden = false;
      prompt.focus();
      return;
    }
    if ((!text && state.attachments.length === 0) || !state.capabilities || !state.runtimeAvailable) {
      return;
    }
    if (choiceAnswer === null && state.attachments.some(function (attachment) { return attachment.pending; })) {
      appendNotice("info", t("ui.preparing.image.attachments.please.send.again.shortly"));
      return;
    }
    const message = {
      id: createId(),
      text,
      attachments: (choiceAnswer === null ? state.attachments : []).map(function (attachment) {
        const { previewUri, pending, ...reference } = attachment;
        return reference;
      }),
      execution: {
        ...(state.role === "main" ? { taskMode: action, businessMode: workflow } : {}),
        agentModels: state.role === "main" ? JSON.parse(JSON.stringify(state.agentModels || {})) : undefined,
        agentPermissions: state.role === "main" ? Object.fromEntries(["main", "work", "verification"].map(role => [role, state.executionMode || "cli-default"])) : undefined,
        model: currentCapabilities().model ? state.model || undefined : undefined,
        reasoningEffort: currentCapabilities().reasoning ? state.reasoning || undefined : undefined,
        fast: currentCapabilities().fast === true && state.fastMode,
        goal,
        ...(goal ? { goalObjective: text } : {})
      }
    };
    const submittedAttachments = (choiceAnswer === null ? state.attachments : []).map(function (attachment) {
      const { pending, ...submitted } = attachment;
      return submitted;
    });
    (state.pendingRequests ??= []).push({ ...message, attachments: submittedAttachments });
    if (choiceAnswer === null) {
      saveComposerSettings();
      state.draft = "";
      state.attachments = [];
      prompt.value = "";
    }
    followLatest = true;
    renderAll();
    resizePrompt();
    // Sending reveals the latest content once without enabling automatic following.
    if (!state.autoScroll) timeline.scrollTop = timeline.scrollHeight;
    persist();
    vscode.postMessage({ type: "chat.send", ...message });
    return true;
  }

  function canAnswerInterview(event) {
    // Only the latest conversational turn matters; do not allocate and scan
    // the entire retained history for every visible message.
    let latest;
    for (let index = state.timeline.length - 1; index >= 0; index--) {
      const item = state.timeline[index];
      if (item.type === "user" || (item.type === "assistant" && item.phase !== "commentary")) {
        latest = item;
        break;
      }
    }
    return latest === event && !event.choiceAnswer && !state.running && !state.pendingRequests?.length && state.runtimeAvailable;
  }

  function renderInterviewChoices(content, event) {
    if (event.phase === "commentary") return;
    for (const table of content.querySelectorAll("table")) {
      const heading = table.previousElementSibling?.textContent.trim() || "";
      if (!/^(?:질문|Question)\s*\[\d+\s*\/\s*\d+\]\s*:/i.test(heading)) continue;
      if (!/^(?:선택지?|Option)$/i.test(table.querySelector("th")?.textContent.trim() || "")) continue;
      const rows = Array.from(table.querySelectorAll("tbody tr"));
      if (rows.length < 2 || rows.length > 3 || rows.some((row, index) => row.cells[0]?.textContent.trim() !== String(index + 1))) continue;
      for (const row of rows) {
        const number = row.cells[0].textContent.trim();
        const button = document.createElement("button");
        button.type = "button";
        button.className = "interview-choice";
        button.textContent = number;
        button.setAttribute("aria-label", number + ": " + row.cells[1].textContent.trim());
        button.disabled = !canAnswerInterview(event);
        button.addEventListener("click", function () {
          if (!canAnswerInterview(event)) return;
          if (submit("direct", "normal", false, number)) {
            event.choiceAnswer = number;
            renderAll();
            persist();
          }
        });
        row.cells[0].replaceChildren(button);
      }
    }
  }

  function cancelRun() {
    if (!state.running) {
      return;
    }
    vscode.postMessage({ type: "run.cancel" });
  }

  function isDuplicateCancellation(previous, current) {
    // Older hosts emitted both an error notice and a final cancellation summary.
    return previous?.type === "notice" && previous.level === "error" &&
      current?.type === "assistant" && current.phase !== "commentary" &&
      current.text?.trim() === "The run was cancelled." &&
      previous.text?.split("\n")[0].trim() === "The run was cancelled." &&
      (!previous.runId || !current.runId || previous.runId === current.runId);
  }

  function collapseCancellationNotices(events) {
    const retained = [];
    for (const event of events) {
      if (!isDuplicateCancellation(retained.at(-1), event)) retained.push(event);
    }
    return retained;
  }

  function appendNotice(level, text, localization = globalThis.AgentFactoryI18n.describe(text)) {
    if (typeof text !== "string" || !text) {
      return;
    }
    state.timeline.push({ type: "notice", id: createId(), level, text, localization });
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
        appendNotice("error", t("ui.attach.up.to.8.png.jpeg.gif.or.webp.images.with.a.maximum.of.10.mib.each.and.20.mib.total"));
        continue;
      }
      const id = createId();
      addAttachments([{ id, name: file.name || "image", kind: "image", previewUri: URL.createObjectURL(file), mediaType: file.type, size: file.size, pending: true }]);
      try {
        const dataUrl = await readDataUrl(file);
        vscode.postMessage({ type: "attachments.createImage", id, name: file.name || "image", mediaType: file.type, size: file.size, data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
      } catch (error) {
        state.attachments = state.attachments.filter(function (item) { return item.id !== id; });
        appendNotice("error", t("ui.unable.to.read.the.image"));
        renderAttachments();
        persist();
      }
    }
  }

  function readDataUrl(file) {
    return new Promise(function (resolvePromise, rejectPromise) {
      const reader = new FileReader();
      reader.addEventListener("load", function () { typeof reader.result === "string" ? resolvePromise(reader.result) : rejectPromise(new Error(t("ui.invalid.image"))); });
      reader.addEventListener("error", function () { rejectPromise(reader.error || new Error(t("ui.image.read.failed"))); });
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
    updateQuestionControl();
  }

  function renderDecisionActions(content, runId) {
    if (!state.pendingDecisionCanApprove) return;
    const actions = document.createElement("div");
    actions.className = "decision-actions";
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", t("ui.respond.to.the.proposal.above"));
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = t("ui.proceed.as.proposed");
    approve.disabled = state.running || state.decisionSubmitting || !state.runtimeAvailable;
    approve.addEventListener("click", function () {
      if (!state.pendingDecisionCanApprove || state.running || state.decisionSubmitting || state.pendingDecisionRunId !== runId) return;
      state.decisionSubmitting = true;
      approve.disabled = true;
      vscode.postMessage({ type: "decision.approve", runId });
    });
    actions.append(approve);
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

  function renderCommandError(container, outcome) {
    if (!outcome.detail) return;
    const detail = document.createElement("div");
    detail.className = "command-error-summary";
    detail.textContent = outcome.detail;
    container.append(detail);
  }

  function renderFactoryScripts(container, scripts, documents, event) {
    container.classList.add("managed-agent-card");
    const outcome = globalThis.agentFactoryExecutionReferences.commandOutcome(event);
    container.dataset.status = outcome.status;
    const row = document.createElement("div");
    row.className = "managed-agent-heading";
    const heading = document.createElement("strong");
    const labels = { doctor: t("ui.check.execution.environment"), capabilities: t("ui.check.supported.features"), submit: t("ui.submit.task"), send: t("ui.send.follow.up"), status: t("ui.check.task.status"), result: t("ui.read.task.result"), start: t("ui.start.task") };
    heading.textContent = scripts.map(function (script) {
      if (script.skill === "agent" && ["exec.py", "loop.py"].includes(script.script) && labels[script.action]) return labels[script.action];
      return script.script + (script.action ? " · " + script.action : "");
    }).join(" / ");
    const badge = document.createElement("span");
    badge.className = "managed-agent-status";
    badge.textContent = outcome.status === "completed" ? t(scripts.some(script => ["start", "submit", "send"].includes(script.action)) ? "activity.request.command.completed" : "activity.command.completed") : activityPhaseAccessibleLabel(outcome.status === "running" ? "started" : outcome.status);
    row.append(heading, badge);
    container.append(row);
    renderCommandError(container, outcome);
    // Keep mixed commands and failures intact, including their non-Factory output.
    renderSkillDocuments(container, documents.length ? documents : scripts.map(function (script) {
      return { skill: "agent-factory:" + script.skill, document: script.script, path: script.path };
    }), event);
  }

  function renderManagedAgent(container, managed, events) {
    container.classList.add("managed-agent-card");
    const child = state.childAgents.find(function (agent) { return agent.agentId === managed.agentId; });
    const pendingRequest = ["submit", "send", "start", "resume"].includes(managed.action) && !managed.runId;
    const matchesRun = managed.kind !== "loop" && child && !pendingRequest && (!managed.runId || child.runId === managed.runId);
    const role = managed.role || child?.role;
    const last = events[events.length - 1];
    const outcome = globalThis.agentFactoryExecutionReferences.commandOutcome(last);
    const status = pendingRequest && outcome.status === "failed" ? "failed" : matchesRun ? child.status : managed.observedStatus || "unknown";
    container.dataset.status = status;
    const heading = document.createElement("div");
    heading.className = "managed-agent-heading";
    const label = document.createElement("strong");
    label.textContent = managed.taskMode === "plan" ? t("ui.plan.work.agent") : managed.kind === "loop" ? taskModeNames()[managed.taskMode] || t("ui.work.verification") : role === "verification" ? t("ui.verification.agent") : role === "work" ? t("ui.work.agent") : t("ui.agent");
    const badge = document.createElement("span");
    badge.className = "managed-agent-status";
    badge.textContent = status === "active" ? t("ui.in.progress") : status === "runtime-error" ? t("ui.runtime.error") : childAgentStatusLabel(status);
    if (["work", "plan-work"].includes(managed.taskMode) && status === "completed") badge.textContent += t("ui.no.separate.verification.requested");
    heading.append(label, badge);
    const identity = document.createElement("div");
    identity.className = "managed-agent-identity";
    identity.textContent = managed.agentId + (managed.runId ? " · " + managed.runId : "");
    const progress = document.createElement("div");
    progress.className = "managed-agent-progress";
    const actions = { submit: t("ui.submit.run"), start: t("ui.start.work"), send: t("ui.send.follow.up"), status: t("ui.check.status"), result: t("ui.get.result"), updates: t("ui.get.updates"), cancel: t("ui.cancel"), resume: t("ui.resume"), reconcile: t("ui.reconcile.work"), "recover-receipt": t("ui.recover.run"), skip: t("ui.skip.verification") };
    progress.textContent = (actions[managed.action] || t("ui.check.run")) + (outcome.status === "failed" ? t("ui.failed") : outcome.status === "running" ? t("ui.in.progress.3d921e") : pendingRequest ? t("ui.acceptance.unconfirmed") : t("ui.processed"));
    if (["submit", "send", "start", "resume"].includes(managed.action)) {
      progress.textContent = outcome.status === "failed" ? t("activity.request.failed") :
        outcome.status === "running" ? t("activity.request.pending") :
        managed.runId && (matchesRun || ["accepted", "queued", "starting", "running", "active", "completed", "failed", "cancelled", "needs-human-decision"].includes(managed.observedStatus)) ? t("activity.request.accepted") : t("activity.request.unconfirmed");
    }
    container.append(heading, identity, progress);
    renderCommandError(container, outcome);
    if (child && state.role === "main") {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "managed-agent-open setting-button";
      open.textContent = t("ui.open.chat");
      open.addEventListener("click", function () {
        if (state.childAgents.some(function (agent) { return agent.agentId === managed.agentId; })) vscode.postMessage({ type: "agent.open", agentId: managed.agentId });
      });
      container.append(open);
    }
    const details = document.createElement("details");
    details.className = "managed-agent-details";
    const summary = document.createElement("summary");
    summary.textContent = t("ui.command.and.run.history") + events.length;
    details.append(summary);
    for (const event of events) {
      const raw = document.createElement("div");
      renderTerminalCommand(raw, event.text, event.phase, event.title);
      renderCommandOutput(raw, event.output, Boolean(event.title));
      raw.querySelectorAll("details").forEach(function (item, index) {
        item.dataset.disclosureKey = event.id + ":" + index;
      });
      details.append(raw);
    }
    container.append(details);
  }

  function managedActivities(events = state.timeline) {
    const groups = new Map(), byEvent = new Map();
    for (const event of events) {
      if (event.type !== "activity" || event.category !== "command") continue;
      const managed = globalThis.agentFactoryExecutionReferences?.managedCommand(event.text, event.output, state.childAgents);
      if (!managed) continue;
      const key = managed.kind + ":" + managed.agentId;
      let group = groups.get(key);
      if (!group || (group.managed.runId && managed.runId && group.managed.runId !== managed.runId) || ["submit", "send", "start", "resume"].includes(managed.action)) {
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

  function submissionFromExecution(execution) {
    if (!execution) return undefined;
    return { taskMode: execution.taskMode, businessMode: execution.businessMode, goal: execution.goal === true };
  }

  function renderSubmission(content, submission) {
    if (!submission || typeof submission !== "object") return;
    const actions = { work: t("ui.work"), plan: t("ui.plan"), verification: t("ui.verification"), "plan-work": t("ui.plan.work.f294a9"), "work-verification": t("ui.work.verification.6a0009"), "plan-work-verification": t("ui.plan.work.verification.d02a66") };
    const workflows = { interview: t("ui.interview"), planning: t("ui.planning"), design: t("ui.design") };
    const labels = [Object.hasOwn(workflows, submission.businessMode) ? workflows[submission.businessMode] : undefined, Object.hasOwn(actions, submission.taskMode) ? actions[submission.taskMode] : undefined, submission.goal === true ? t("ui.goal") : undefined].filter(Boolean);
    if (submission.backgroundContinuation === true) labels.unshift(t("ui.background.continuation.label"));
    if (labels.length) {
      const metadata = document.createElement("div");
      metadata.className = "message-submission";
      metadata.setAttribute("aria-label", t("ui.submission.method"));
      for (const label of labels) {
        const badge = document.createElement("span");
        badge.textContent = label;
        metadata.append(badge);
      }
      content.prepend(metadata);
    }
    // Missing historical guidance is unknown; never reconstruct it from today's templates.
    if (typeof submission.guidance === "string" && submission.guidance.trim()) {
      content.classList.add("has-message-guidance");
      const details = document.createElement("details");
      details.className = "message-guidance";
      const summary = document.createElement("summary");
      summary.setAttribute("aria-label", t("ui.view.delivered.guidance"));
      summary.title = t("ui.view.delivered.guidance");
      summary.append(createModeIcon("m8.5 5 7 7-7 7", "submission-chevron"));
      const note = document.createElement("p");
      note.textContent = t("ui.application.added.guidance.for.this.request.this.is.not.the.full.provider.prompt");
      const guidance = document.createElement("pre");
      guidance.textContent = submission.guidance;
      details.append(summary, note, guidance);
      content.append(details);
    }
  }

  function scheduleTimelineRender() {
    if (timelineRenderFrame || document.hidden) return;
    timelineRenderFrame = requestAnimationFrame(function () {
      timelineRenderFrame = undefined;
      renderTimeline();
    });
  }

  function renderTimeline() {
    cancelAnimationFrame(autoScrollFrame);
    const shouldFollowLatest = state.autoScroll && followLatest;
    const existingMessages = messageElements;
    const endIndex = timelineEndId ? state.timeline.findIndex(item => item.id === timelineEndId) + 1 : state.timeline.length;
    const end = endIndex > 0 ? endIndex : state.timeline.length;
    const start = Math.max(0, end - 200);
    const visibleEvents = state.timeline.slice(start, end);
    const retainedIds = new Set();
    let previousMessage = emptyState;
    const displayStates = messageViewStates;
    let focusedControl;
    emptyState.hidden = state.timeline.length > 0;
    let older = timeline.querySelector(".history-older");
    if (!older) {
      older = document.createElement("button");
      older.type = "button";
      older.className = "history-older";
      older.addEventListener("click", function () {
        if (state.historyNextBefore) {
          state.historyBrowsing = true;
          vscode.postMessage({ type: "history.request", before: state.historyNextBefore });
        }
      });
      timeline.prepend(older);
    }
    older.textContent = t("ui.history.older");
    older.hidden = !state.historyNextBefore;
    let pages = timeline.querySelector(".history-pages");
    if (!pages) { pages = document.createElement("nav"); pages.className = "history-pages"; timeline.prepend(pages); }
    pages.replaceChildren();
    for (const [label, enabled, target] of [["ui.history.previous", start > 0, start], ["ui.history.next", end < state.timeline.length, Math.min(state.timeline.length, end + 200)]]) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = t(label); button.disabled = !enabled;
      button.addEventListener("click", function () {
        timelineEndId = target === state.timeline.length ? undefined : state.timeline[target - 1]?.id;
        followLatest = false;
        renderTimeline();
        timeline.scrollTop = 0;
      });
      pages.append(button);
    }
    pages.hidden = state.timeline.length <= 200;
    pages.setAttribute("aria-label", t("ui.history.pages"));
    const managedByEvent = managedActivities(visibleEvents);
    for (const event of visibleEvents) {
      const managedGroup = managedByEvent.get(event.id);
      if (managedGroup && managedGroup.events[0] !== event) continue;
      retainedIds.add(event.id);
      const existing = existingMessages.get(event.id);
      const renderKey = JSON.stringify([event, syntaxRevision, uiLocale(),
        event.type === "assistant" ? [state.role, state.childAgents.map(agent => [agent.agentId, agent.role]), canAnswerInterview(event)] : null,
        event.type === "assistant" && event.runId === state.pendingDecisionRunId && event.runId
          ? [state.pendingDecisionRunId, state.pendingDecisionCanApprove, state.decisionSubmitting, state.running, state.runtimeAvailable] : null,
        event.category === "command" ? [managedGroup, state.childAgents, state.role] : null]);
      if (existing && messageRenderKeys.get(existing) === renderKey) {
        if (previousMessage.nextElementSibling !== existing) previousMessage.after(existing);
        previousMessage = existing;
        continue;
      }
      if (existing) {
        const element = existing;
        const controls = Array.from(element.querySelectorAll(".bash-command-toggle, summary, .execution-reference button, .managed-agent-open"));
        const focusIndex = controls.indexOf(document.activeElement);
        if (focusIndex >= 0) focusedControl = { id: element.dataset.id, index: focusIndex };
        displayStates.set(element.dataset.id, {
          expanded: element.querySelector(".bash-command-toggle")?.getAttribute("aria-expanded") === "true",
          details: Array.from(element.querySelectorAll("details")).map(function (details, index) { return { key: details.dataset.disclosureKey || details.className + ":" + index, open: details.open }; }),
          scroll: Array.from(element.querySelectorAll("pre")).map(function (pre) { return { top: pre.scrollTop, left: pre.scrollLeft }; })
        });
      }
      const message = document.createElement("article");
      message.className = "message message-" + event.type;
      message.dataset.id = event.id;
      if (event.type === "assistant") {
        message.classList.add(event.phase === "commentary" ? "message-commentary" : "message-final");
      }
      if (event.type === "user") {
        message.tabIndex = -1;
        if (typeof event.text === "string" && event.text.length) {
          const copy = document.createElement("button");
          copy.type = "button";
          copy.className = "message-copy setting-button";
          copy.append(createModeIcon("M9 9h12v12H9z M6 15H3V3h12v3", "message-copy-icon"));
          copy.title = t("ui.copy.question");
          copy.setAttribute("aria-label", t("ui.copy.question"));
          copy.addEventListener("click", function () {
            vscode.postMessage({ type: "message.copy", text: event.text });
          });
          message.append(copy);
        }
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
        if (event.type === "user") marker.append(createModeIcon("m9 5 7 7-7 7", "submission-chevron"));
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
        text.textContent = localizedText(event.text, event.localization);
        content.append(mark, text);
      } else if (event.type === "assistant") {
        const taskContent = extractTaskFlows(localizedText(event.text, event.localization));
        const extracted = event.phase !== "commentary" && globalThis.agentFactoryExecutionReferences
          ? globalThis.agentFactoryExecutionReferences.extract(taskContent.text, markdown)
          : { text: taskContent.text, references: [] };
        if (extracted.references.length) {
          renderAssistantMarkdown(content, extracted.before);
          renderExecutionReferences(content, extracted.references);
          appendAssistantMarkdown(content, extracted.after);
        } else {
          renderAssistantMarkdown(content, extracted.text);
        }
        for (const flow of taskContent.flows) content.append(createTaskFlow(flow));
        renderInterviewChoices(content, event);
        if (event.runId && event.runId === state.pendingDecisionRunId && event.phase !== "commentary") {
          renderDecisionActions(content, event.runId);
        }
      } else if (event.type === "activity" && event.category === "command") {
        const skillDocuments = globalThis.agentFactoryExecutionReferences?.skillDocuments(event.text) || [];
        const runtimeScripts = globalThis.agentFactoryExecutionReferences?.runtimeScripts(event.output) || [];
        const factoryScripts = runtimeScripts.length ? runtimeScripts : globalThis.agentFactoryExecutionReferences?.scriptInvocations(event.text) || [];
        if (managedGroup) {
          message.classList.add("message-activity-agent");
          renderManagedAgent(content, managedGroup.managed, managedGroup.events);
        } else if (factoryScripts.length) {
          message.classList.add("message-activity-agent");
          renderFactoryScripts(content, factoryScripts, skillDocuments, event);
        } else if (skillDocuments.length) {
          renderSkillDocuments(content, skillDocuments, event);
        } else {
          renderCommandError(content, globalThis.agentFactoryExecutionReferences.commandOutcome(event));
          renderTerminalCommand(content, event.text, event.phase, event.title);
          renderCommandOutput(content, event.output, Boolean(event.title));
        }
      } else if (event.type === "activity" && event.category === "file" && event.diff) {
        renderGitDiff(content, event.diff, event.text, event.phase);
      } else {
        content.textContent = event.text;
      }
      if (event.type === "user") renderSubmission(content, event.submission);
      if (event.type === "user" && Array.isArray(event.attachments)) renderHistoryAttachments(content, event.attachments);
      message.append(content);
      const display = displayStates.get(event.id);
      if (display) {
        const toggle = message.querySelector(".bash-command-toggle");
        const command = message.querySelector(".bash-command-text");
        if (toggle && command && display.expanded) setCommandExpanded(command, toggle, true);
        message.querySelectorAll("details").forEach(function (details, index) {
          const key = details.dataset.disclosureKey || details.className + ":" + index;
          const previous = display.details.find(function (item) { return item.key === key; });
          if (previous) details.open = previous.open;
        });
      }
      // Build the replacement at its final disclosure height before touching live DOM.
      // Unchanged messages stay mounted, so OFF needs no scrollTop restoration.
      if (existing) existing.replaceWith(message);
      else previousMessage.after(message);
      if (previousMessage.nextElementSibling !== message) previousMessage.after(message);
      previousMessage = message;
      messageRenderKeys.set(message, renderKey);
      messageElements.set(event.id, message);
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
      if (!retainedIds.has(id)) {
        messageViewStates.set(id, {
          expanded: element.querySelector(".bash-command-toggle")?.getAttribute("aria-expanded") === "true",
          details: Array.from(element.querySelectorAll("details")).map((details, index) => ({ key: details.dataset.disclosureKey || details.className + ":" + index, open: details.open })),
          scroll: Array.from(element.querySelectorAll("pre")).map(pre => ({ top: pre.scrollTop, left: pre.scrollLeft }))
        });
        element.remove(); messageElements.delete(id);
      }
    }
    while (messageViewStates.size > 2000) messageViewStates.delete(messageViewStates.keys().next().value);
    updateQuestionControl();
    timeline.setAttribute("aria-busy", String(state.running));
    if (shouldFollowLatest) {
      autoScrollFrame = requestAnimationFrame(function () {
        // Recheck both the preference and reading position before following.
        if (state.autoScroll && followLatest) timeline.scrollTop = timeline.scrollHeight;
      });
    }
  }

  function updateAutoScrollControl() {
    const following = state.autoScroll && followLatest;
    const status = following ? t("ui.following.latest.messages") : t("ui.paused.jump.to.the.bottom.to.resume");
    const label = state.autoScroll
      ? t("ui.auto.scroll.on") + status + t("ui.click.to.turn.off")
      : t("ui.auto.scroll.off.click.to.jump.to.the.latest.content.and.turn.on");
    autoScrollButton.title = label;
    autoScrollButton.setAttribute("aria-label", label);
    autoScrollButton.setAttribute("aria-pressed", String(state.autoScroll));
    autoScrollState.toggleAttribute("hidden", !state.autoScroll);
    autoScrollState.setAttribute("aria-label", status);
    autoScrollState.dataset.state = following ? "following" : "paused";
    autoScrollState.querySelector("path").setAttribute("d", following
      ? "m6 5 6 6 6-6m-12 8 6 6 6-6" : "M8 5v14M16 5v14");
  }

  function activityKindLabel(category) {
    if (category === "file") return t("ui.git.changes");
    return t("ui.tool.execution");
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
    if (phase === "completed") return t("ui.succeeded");
    if (phase === "failed") return t("ui.failed.09fef5");
    return t("ui.in.progress");
  }

  function renderTerminalCommand(container, command, phaseValue, title) {
    container.classList.add("terminal-command-content");
    const row = document.createElement("div");
    row.className = "terminal-command-row";
    const prompt = document.createElement("span");
    prompt.className = "terminal-command-prompt";
    prompt.textContent = phaseValue === "failed" ? t("ui.failed.0f4f56") : phaseValue === "completed" ? t("ui.ran") : t("ui.running");
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
    toggle.setAttribute("aria-label", t("ui.expand.full.command"));
    toggle.title = t("ui.expand.full.command");
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
    toggle.setAttribute("aria-label", expanded ? t("ui.collapse.command") : t("ui.expand.full.command"));
    toggle.title = expanded ? t("ui.collapse.command") : t("ui.expand.full.command");
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
    const skill = /^(?:Read Skill|Skill 읽기) · (.*)$/.exec(title);
    if (skill) return t(phase === "started" ? "activity.skill.reading" : "activity.skill.read", skill[1]);
    if (["Read run result", "실행 결과 읽기"].includes(title)) return t(phase === "started" ? "activity.result.reading" : "activity.result.read");
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
    const preview = createCommandOutput(output || t("ui.no.output"));
    preview.classList.add("terminal-output-preview");
    const details = document.createElement("details");
    details.className = "terminal-output-details";
    const summary = document.createElement("summary");
    summary.textContent = t("ui.view.run.result");
    details.append(summary, createCommandOutput(output || t("ui.no.output")));
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
    label.append(document.createTextNode(t("ui.edited") + (files.length === 1 ? files[0].path : t("diff.files", files.length || 1)) + " "));
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
    summary.textContent = t("ui.view.git.diff");
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
      more.textContent = t("diff.more", shown - 12);
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
    list.setAttribute("aria-label", t("ui.execution.identifiers"));
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
        main.title = reference.id + t("ui.chat.with.session");
        main.addEventListener("click", function () {
          if (state.childAgents.some(function (agent) { return agent.agentId === reference.id && agent.role === expectedRole; })) {
            vscode.postMessage({ type: "agent.open", agentId: reference.id });
          }
        });
      }
      const label = document.createElement("span");
      label.className = "agent-role";
      label.textContent = ({ "Work Agent": t("reference.work.agent"), "Work Run": t("reference.work.run"), "Work Session": t("reference.work.session"), "Loop": t("reference.loop"), "예약된 Verification Agent": t("ui.reserved.verification.agent") })[reference.label] || reference.label;
      const id = document.createElement("span");
      id.className = "execution-reference-id";
      id.textContent = reference.id;
      main.append(label, id);
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "execution-reference-copy setting-button";
      copy.textContent = t("ui.copy");
      copy.setAttribute("aria-label", label.textContent + " " + reference.id + t("ui.copy.fafe60"));
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
    for (const img of container.querySelectorAll("img[src]")) {
      const href = img.getAttribute("src");
      if (img.dataset.localImage || !/^(?:file:\/\/|\/|\.\.?\/)/i.test(href)) continue;
      img.dataset.localImage = href;
      img.removeAttribute("src");
      vscode.postMessage({ type: "image.resolve", href });
    }
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
    runElapsed.hidden = !state.running;
    const hasUnfinishedTasks = displayTaskFlows().some(unfinishedFlow);
    runStatus.hidden = !state.running && !hasUnfinishedTasks;
    if (!state.running) {
      stopElapsedTimer();
      runStatusLabel.textContent = t("ui.task.workflow");
      runStatusLabel.title = t("ui.task.workflow");
      runElapsed.textContent = t("duration.seconds", 0);
      return;
    }
    if (!state.runStartedAt) {
      state.runStartedAt = Date.now();
    }
    const elapsed = Math.max(0, Date.now() - state.runStartedAt);
    runStatusLabel.textContent = localizedText(state.runProgress, state.runProgressLocalization) || t("ui.working");
    runStatusLabel.title = localizedText(state.runProgress, state.runProgressLocalization) || t("ui.working");
    runElapsed.textContent = formatElapsed(elapsed);
    const elapsedItem = statusBar.querySelector('[data-item-id="elapsed"]');
    if (elapsedItem) {
      elapsedItem.textContent = statusLabel("elapsed");
      elapsedItem.setAttribute("aria-label", elapsedItem.textContent + t("ui.move.with.alt.left.right"));
    }
    refreshStatusPreview();
    if (!elapsedTimerId && !document.hidden) {
      elapsedTimerId = window.setInterval(renderRunStatus, 1000);
    }
  }

  function extractTaskFlows(text) {
    const flows = [];
    const rest = text.replace(/^```task-flow\s*\n([\s\S]*?)^```\s*$/gm, function (block, json) {
      try {
        const flow = JSON.parse(json);
        const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
        const validText = value => typeof value === "string" && value.trim() && value.length <= 300;
        const statuses = ["pending", "running", "verifying", "completed", "failed", "blocked", "cancelled"];
        if (!validId(flow.id) || !validText(flow.title) || !Array.isArray(flow.tasks) || !flow.tasks.length || flow.tasks.length > 100) return block;
        if (!flow.tasks.every(task => task && validId(task.id) && validText(task.title) && statuses.includes(task.status) &&
          (task.description === undefined || (typeof task.description === "string" && task.description.length <= 8200)) &&
          (task.agentId === undefined || validId(task.agentId)) && (task.runId === undefined || validId(task.runId)))) return block;
        if (new Set(flow.tasks.map(task => task.id)).size !== flow.tasks.length) return block;
        flows.push(flow);
        return "";
      } catch { return block; }
    });
    return { text: rest, flows };
  }

  function currentTaskFlows() {
    // Assistant messages are appended or replaced, never edited in place.
    // User/activity updates do not affect task-flow extraction.
    const inputs = [state.timeline, state.timeline.length, state.taskFlows,
      state.childAgents, state.workflows, t("ui.verification")];
    if (taskFlowSnapshot && inputs.every((value, index) => value === taskFlowSnapshot.inputs[index])) {
      return taskFlowSnapshot.flows;
    }
    const flows = new Map();
    for (const entry of state.timeline) {
      if (entry.type !== "assistant") continue;
      const text = entry.text || "";
      let parsed = taskFlowParseCache.get(entry);
      if (!parsed || parsed.text !== text) {
        parsed = { text, flows: extractTaskFlows(text).flows };
        taskFlowParseCache.set(entry, parsed);
      }
      for (const flow of parsed.flows) flows.set(flow.id, flow);
    }
    for (const savedFlow of state.taskFlows || []) {
      for (const flow of extractTaskFlows("```task-flow\n" + JSON.stringify(savedFlow) + "\n```").flows) flows.set(flow.id, flow);
    }
    // Runtime-accepted task metadata is authoritative even when commentary is absent.
    for (const agent of state.childAgents.slice().reverse()) {
      const binding = agent.taskBinding;
      if (!acceptedTaskAgent(agent) || !binding) continue;
      const task = { id: binding.taskId, title: binding.title, description: binding.description,
        status: agent.status === "completed" ? "pending" : agent.status === "needs-human-decision" ? "blocked" :
          ["failed", "cancelled"].includes(agent.status) ? agent.status : agent.status === "running" ? (agent.role === "verification" ? "verifying" : "running") : "pending",
        agentId: agent.agentId, runId: agent.runId, sessionRole: agent.role };
      if (typeof binding.completionCriteria === "string") task.description += "\n\n" + binding.completionCriteria;
      const candidate = { id: binding.workflowId, title: binding.workflowTitle, tasks: [task] };
      if (!extractTaskFlows("```task-flow\n" + JSON.stringify(candidate) + "\n```").flows.length) continue;
      const existing = flows.get(candidate.id);
      const flow = existing ? { ...existing, tasks: [...existing.tasks] } : { ...candidate, tasks: [] };
      const index = flow.tasks.findIndex(entry => entry.id === task.id);
      if (index < 0) flow.tasks.push(task);
      else {
        const previous = flow.tasks[index];
        flow.tasks[index] = { ...task, status: previous.status === "completed" && previous.runId === task.runId ? "completed" : task.status };
      }
      flows.set(flow.id, flow);
    }
    for (const snapshot of state.workflows || []) {
      const workflow = snapshot.workflow;
      if (!workflow || !Array.isArray(workflow.tasks)) continue;
      const verification = ["work-verification", "plan-work-verification"].includes(snapshot.taskMode);
      const tasks = workflow.tasks.flatMap((task, index) => {
        const description = [task.description, task.completionCriteria].filter(Boolean).join("\n\n");
        const stages = [{ id: verification ? "stage-" + index + ".work" : task.id, taskId: task.id, title: task.title, description, status: task.workStatus, sessionAgentId: task.workAgentId || snapshot.workAgentId, sessionRunId: task.workRunId, sessionRole: "work" }];
        if (verification) stages.push({ id: "stage-" + index + ".verification", taskId: task.id, title: String(task.title).slice(0, 280) + " · " + t("ui.verification"), description, status: task.verificationStatus === "running" ? "verifying" : task.verificationStatus, sessionAgentId: task.verificationAgentId || snapshot.verificationAgentId, sessionRunId: task.verificationRunId, sessionRole: "verification" });
        return stages;
      });
      const candidate = { id: workflow.id, title: workflow.title, tasks };
      if (extractTaskFlows("```task-flow\n" + JSON.stringify(candidate) + "\n```").flows.length) flows.set(workflow.id, { ...candidate, engine: true, loopId: snapshot.loopId, workAgentId: snapshot.workAgentId, closable: snapshot.status === "runtime-error" });
    }
    const result = [...flows.values()];
    taskFlowSnapshot = { inputs, flows: result };
    return result;
  }

  function liveTaskStatus(task) {
    let status = task.status;
    const agent = task.agentId && task.runId && state.childAgents.find(agent => agent.agentId === task.agentId && agent.runId === task.runId);
    if (agent && status !== "completed") {
      if (["failed", "cancelled"].includes(agent.status)) status = agent.status;
      else if (agent.status === "needs-human-decision") status = "blocked";
      else if (agent.status === "running") status = agent.role === "verification" ? "verifying" : "running";
      // A finished child is not proof that the whole task passed verification.
      else if (["running", "verifying"].includes(status)) status = "pending";
    }
    return status;
  }

  function summarizeTaskFlow(flow, live) {
    const groups = new Map();
    const workers = new Set();
    for (const task of flow.tasks) {
      const id = task.taskId || task.id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(task);
      const worker = task.sessionAgentId || task.agentId;
      if (worker && task.sessionRole !== "verification") workers.add(worker);
    }
    const counts = { pending: 0, running: 0, verifying: 0, completed: 0, blocked: 0, failed: 0, cancelled: 0 };
    const current = [];
    const statusOf = task => live ? liveTaskStatus(task) : task.status;
    for (const stages of groups.values()) {
      const work = stages.find(task => task.sessionRole !== "verification") || stages[0];
      const verification = stages.find(task => task.sessionRole === "verification");
      // A finished Work stage still waits for its selected Verification stage.
      const selected = statusOf(work) === "completed" && verification ? verification : work;
      const status = statusOf(selected);
      if (Object.hasOwn(counts, status)) counts[status] += 1;
      if (["running", "verifying"].includes(status)) current.push(t("flow.summary.current.task", work.title, t("flow.status." + status)));
    }
    return { total: groups.size, workers: workers.size, counts, current };
  }

  function createTaskFlow(flow, live = false) {
    const section = document.createElement("section");
    section.className = "task-flow";
    section.dataset.flowId = flow.id;
    section.setAttribute("aria-label", flow.title);
    const title = document.createElement("strong");
    title.textContent = flow.title;
    section.append(title);
    if (live && flow.closable && state.role === "main") {
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = t("flow.close.failed");
      close.addEventListener("click", () => {
        vscode.postMessage({ type: "workflow.close", workAgentId: flow.workAgentId, loopId: flow.loopId });
      });
      section.append(close);
    }
    const totals = summarizeTaskFlow(flow, live);
    const summary = document.createElement("div");
    summary.className = "task-flow-summary";
    summary.setAttribute("role", "group");
    summary.setAttribute("aria-label", t("flow.summary.label"));
    const size = document.createElement("strong");
    size.className = "task-flow-total";
    size.textContent = t("flow.task.count", totals.total);
    const workers = document.createElement("span");
    workers.className = "task-flow-workers";
    workers.textContent = totals.workers ? t("flow.summary.workers", totals.workers) : t("flow.summary.workers.unknown");
    summary.append(size, workers);
    for (const [status, count] of Object.entries(totals.counts)) {
      const metric = document.createElement("span");
      metric.dataset.summaryStatus = status;
      metric.textContent = t("flow.summary.count", t("flow.status." + status), count);
      summary.append(metric);
    }
    const current = document.createElement("p");
    current.className = "task-flow-current";
    current.textContent = totals.current.length ? t("flow.summary.current", totals.current.join(" · ")) : t("flow.summary.current.none");
    if (live) {
      current.setAttribute("role", "status");
      current.setAttribute("aria-live", "polite");
      current.setAttribute("aria-atomic", "true");
    }
    section.append(summary, current);
    const list = document.createElement("ol");
    list.className = "task-flow-list";
    flow.tasks.forEach(function (task, index) {
      const status = live ? liveTaskStatus(task) : task.status;
      const item = document.createElement("li");
      item.className = "task-flow-step";
      item.dataset.status = status;
      item.dataset.taskId = task.taskId || task.id;
      if (task.sessionRunId || task.runId) item.dataset.runId = task.sessionRunId || task.runId;
      if (["running", "verifying"].includes(status)) item.setAttribute("aria-current", "step");
      const marker = document.createElement("span");
      marker.className = "task-flow-number";
      marker.textContent = String(index + 1);
      const name = document.createElement("span");
      name.className = "task-flow-name";
      name.textContent = task.title;
      const label = document.createElement("span");
      label.className = "task-flow-state";
      label.textContent = t("flow.status." + status);
      item.append(marker, name, label);
      if (task.description) {
        const details = document.createElement("details");
        details.className = "task-flow-description";
        const summary = document.createElement("summary");
        summary.textContent = t("flow.request.details");
        const description = document.createElement("div");
        description.textContent = task.description;
        details.append(summary, description);
        item.append(details);
      }
      const agentId = task.sessionAgentId || task.agentId;
      const runId = task.sessionRunId || task.runId;
      const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
      if (validId(agentId) && validId(runId)) {
        const agent = state.childAgents.find(agent => agent.agentId === agentId && agent.runId === runId && acceptedTaskAgent(agent));
        if (task.sessionRunId || agent) {
          const role = task.sessionRole || agent?.role;
          const open = document.createElement("button");
          open.type = "button";
          open.className = "task-flow-open setting-button";
          open.textContent = t(role === "verification" ? "flow.open.verification.session" : "flow.open.work.session");
          open.setAttribute("aria-label", task.title + " · " + open.textContent);
          open.title = agentId;
          open.addEventListener("click", function () { vscode.postMessage({ type: "agent.open", agentId }); });
          item.append(open);
        }
      }
      list.append(item);
    });
    section.append(list);
    return section;
  }

  function acceptedTaskAgent(agent) {
    return Boolean(agent.runId) && ["accepted", "queued", "starting", "running", "cancelling", "needs-human-decision", "completed", "failed", "cancelled"].includes(agent.status);
  }

  function displayTaskFlows() {
    const agents = state.childAgents.filter(acceptedTaskAgent);
    const flows = currentTaskFlows().filter(flow => {
      if (flow.engine) return true;
      const bound = agents.filter(agent => flow.tasks.some(task => task.agentId === agent.agentId && task.runId === agent.runId));
      if (!bound.length) return false;
      // A cached plan is not a live workflow after its accepted runs have ended.
      // Keep explicit terminal flow snapshots; unresolved legacy plans remain in chat.
      return bound.some(agent => !["completed", "failed", "cancelled"].includes(agent.status)) ||
        flow.tasks.every(task => ["completed", "failed", "cancelled"].includes(task.status));
    });

    return flows;
  }

  function unfinishedFlow(flow) {
    return flow.tasks.some(task => ["pending", "running", "verifying", "blocked"].includes(liveTaskStatus(task)));
  }

  function renderWorkLoopPanel() {
    const flows = displayTaskFlows();
    const active = flows.filter(unfinishedFlow);
    const history = flows.filter(flow => !unfinishedFlow(flow));
    const boundRuns = new Set(flows.flatMap(flow => flow.tasks.map(task => task.agentId + "/" + task.runId)));
    const legacyHistory = state.childAgents.filter(agent => acceptedTaskAgent(agent) &&
      ["completed", "failed", "cancelled"].includes(agent.status) && !boundRuns.has(agent.agentId + "/" + agent.runId) &&
      !(state.workflows || []).some(snapshot => snapshot.workflow?.id === agent.taskBinding?.workflowId));
    const historyPanel = document.getElementById("task-history");
    const historyList = document.getElementById("task-history-list");
    historyPanel.hidden = state.role !== "main" || (history.length === 0 && legacyHistory.length === 0);
    const historySignature = JSON.stringify([history, state.childAgents, t("flow.status.pending")]);
    if (historyList.dataset.signature !== historySignature) {
      historyList.dataset.signature = historySignature;
      historyList.replaceChildren(...history.map(flow => createTaskFlow(flow, true)), ...legacyHistory.map(createRunStage));
    }
    const hasActive = active.length > 0;
    if (hasActive && runDetails.dataset.hasActive !== "true") state.runPanelExpanded = true;
    runDetails.dataset.hasActive = String(hasActive);
    if (!hasActive) {
      state.runPanelExpanded = false;
      runStageList.replaceChildren();
      delete runStageList.dataset.flowSignature;
    }
    const expandable = state.role === "main" && hasActive;
    const expanded = expandable && state.runPanelExpanded && !runStatus.hidden;
    runStatusToggle.disabled = !expandable;
    runStatusToggle.setAttribute("aria-expanded", String(expanded));
    runStatus.classList.toggle("is-expanded", expanded);
    runStatus.classList.toggle("is-running", state.running);
    runDetails.hidden = !expanded;
    runStatusAgents.hidden = !expandable || state.workUnits.activeUnits === 0;
    runStatusAgents.textContent = state.workUnits.activeUnits > 0
      ? t("status.runningAgents", state.workUnits.workActive, state.workUnits.verificationActive) : "";
    if (!expanded) return;
    runDetailsSummary.textContent = active.length ? t("flow.task.count", active.reduce((sum, flow) => sum + summarizeTaskFlow(flow, true).total, 0)) : t("ui.preparing");
    const signature = JSON.stringify([active, state.childAgents, t("flow.status.pending")]);
    runStopButton.hidden = !state.running;
    if (runStageList.dataset.flowSignature === signature) return;
    runStageList.dataset.flowSignature = signature;
    runStageList.replaceChildren(...active.map(flow => createTaskFlow(flow, true)));
  }

  function childTaskName(agent) {
    const title = agent.taskBinding?.title;
    if (typeof title === "string" && title.trim() && title.length <= 300) return title;
    // Historical Main snapshots are usable only with the exact accepted run binding.
    if (agent.runId) {
      const flows = currentTaskFlows();
      for (const flow of flows) {
        const task = flow.tasks.find(task => task.agentId === agent.agentId && task.runId === agent.runId);
        if (task) return task.title;
      }
    }
    return t("ui.task.name.unavailable");
  }

  function createRunStage(agent) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "run-stage";
    item.dataset.status = agent.status;
    item.title = agent.agentId + t("ui.open.session");
    const marker = document.createElement("span");
    marker.className = "run-stage-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = childAgentStatusMarker(agent.status);
    const copy = document.createElement("span");
    copy.className = "run-stage-copy";
    const name = document.createElement("span");
    name.className = "run-stage-name";
    name.textContent = agent.role === "work" ? t("ui.work") : t("ui.verification");
    const id = document.createElement("span");
    id.className = "run-stage-id";
    id.textContent = childTaskName(agent);
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
      return t("duration.seconds", seconds);
    }
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    return hours ? t("duration.hours", hours, minutes, seconds) : t("duration.minutes", minutes, seconds);
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
          preview.setAttribute("aria-label", t("attachment.open", attachment.name));
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
      remove.setAttribute("aria-label", t("attachment.remove", attachment.name));
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
      if (attachment.kind !== "image") {
        const reference = document.createElement("div");
        reference.className = "attachment-chip history-reference";
        reference.title = attachment.uri || attachment.name;
        const name = document.createElement("span");
        name.className = "attachment-chip-name";
        name.textContent = attachment.name;
        reference.append(name);
        gallery.append(reference);
        continue;
      }
      const item = document.createElement(attachment.previewUri ? "button" : "div");
      item.className = "history-attachment";
      item.title = attachment.name;
      if (attachment.previewUri) {
        item.type = "button";
        item.setAttribute("aria-label", t("attachment.open", attachment.name));
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
    state.sessionsLoading = true;
    renderSessionList();
    vscode.postMessage({ type: "sessions.request" });
  }

  function closeSessionMenu(restoreFocus) {
    sessionMenu.hidden = true;
    if (restoreFocus) {
      prompt.focus();
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
      questionList.append(sessionEmpty(t("ui.no.user.questions.yet")));
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
      text.textContent = question.text?.trim() || (attachmentNames.length ? t("ui.attachments.c53076") + attachmentNames.join(", ") : t("ui.message.with.attachments"));
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
    cancelAnimationFrame(autoScrollFrame);
    followLatest = false;
    updateAutoScrollControl();
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
      sessionList.append(sessionEmpty(t("ui.loading.sessions")));
      return;
    }
    if (state.sessions.length === 0) {
      sessionList.append(sessionEmpty(t("ui.no.main.agent.sessions.to.load")));
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
      meta.textContent = [session.model, formatSessionDate(session.updatedAt)].filter(Boolean).join(" · ") || t("ui.main.agent");
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
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(uiLocale());
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

  function updateQuestionControl() {
    const count = state.timeline.filter(function (event) {
      return event.type === "user";
    }).length;
    questionButton.title = t("toolbar.questions", count);
    questionButton.setAttribute("aria-label", questionButton.title);
  }

  function clearBotGlance() {
    clearTimeout(botGlanceTimer);
    botGlanceTimer = undefined;
    delete factoryBot.dataset.glance;
  }

  function maybeGlanceAtPointer(event) {
    if (!state.botsEnabled || event.pointerType !== "mouse" || document.hidden || !state.botVisible ||
        !state.botAnimations || botReducedMotion.matches || factoryBot.dataset.state !== "idle") return;
    const now = Date.now();
    if (now < botNextGlanceAt) return;
    // Sample once per interval, including misses, so frequent events cannot force a glance.
    botNextGlanceAt = now + 12000;
    if (Math.random() >= 0.2) return;
    const box = factoryBot.getBoundingClientRect();
    const dx = Math.max(-1, Math.min(1, (event.clientX - box.x - box.width / 2) / 160));
    const dy = Math.max(-1, Math.min(1, (event.clientY - box.y - box.height / 2) / 160));
    factoryBot.style.setProperty("--bot-glance-x", (dx * 2.5) + "px");
    factoryBot.style.setProperty("--bot-glance-y", (dy * 2) + "px");
    factoryBot.style.setProperty("--bot-glance-tilt", (dx * 6) + "deg");
    factoryBot.dataset.glance = "true";
    botGlanceTimer = window.setTimeout(clearBotGlance, 1500);
  }

  function wakeFactoryBot() {
    botIdleSince = undefined;
    renderFactoryBot();
  }

  function updateBotGesture(mode) {
    const mood = factoryBot.dataset.mood || "calm";
    const key = mode + ":" + mood;
    if (key !== botGestureKey || mode !== "idle") {
      clearTimeout(botGestureTimer);
      botGestureTimer = undefined;
      botGestureKey = key;
    }
    if (mode !== "idle") {
      delete factoryBot.dataset.gesture;
      return;
    }
    if (botGestureTimer !== undefined) return;
    const pools = {
      calm: ["breathe", "stretch", "coffee", "read", "bow", "look"],
      curious: ["look", "read", "balance", "wave", "stretch", "shy"],
      cheerful: ["dance", "wave", "bow", "balance", "stretch", "shy"],
      focused: ["read", "coffee", "look", "breathe", "stretch", "bow"]
    };
    const choices = (pools[mood] || pools.calm).filter(function (gesture) {
      return gesture !== factoryBot.dataset.gesture;
    });
    factoryBot.dataset.gesture = choices[Math.floor(Math.random() * choices.length)];
    botGestureTimer = window.setTimeout(function () {
      botGestureTimer = undefined;
      renderFactoryBot();
    }, 8000);
  }

  function renderFactoryBot() {
    document.getElementById("bots-disabled").checked = !state.botsEnabled;
    factoryBot.hidden = !state.botsEnabled || !state.botVisible;
    document.getElementById("bot-visible").disabled = !state.botsEnabled;
    document.getElementById("bot-animations").disabled = !state.botsEnabled;
    if (!state.botsEnabled) {
      clearTimeout(botIdleTimer); botIdleTimer = undefined;
      clearTimeout(botGestureTimer); botGestureTimer = undefined;
      clearTimeout(botWaveTimer); botWaveTimer = undefined;
      clearTimeout(botReactionTimer); botReactionTimer = undefined;
      botIdleSince = undefined;
      botGestureKey = undefined;
      delete factoryBot.dataset.gesture;
      delete factoryBot.dataset.reacting;
      delete factoryBot.dataset.mood;
      delete factoryBot.dataset.brain;
      clearBotGlance();
      closeBotMenu();
      return;
    }
    factoryBot.dataset.animations = String(state.botAnimations);
    let mode = state.pendingDecisionRunId ? "waiting"
      : !state.runtimeAvailable ? "offline"
      : state.running ? "working"
      : botOutcome === "completed" ? "complete"
      : botOutcome === "failed" ? "error" : "idle";
    clearTimeout(botIdleTimer);
    botIdleTimer = undefined;
    if (mode === "idle") {
      if (botIdleSince === undefined) botIdleSince = Date.now();
      const elapsed = Date.now() - botIdleSince;
      if (elapsed >= 60000) mode = "sleeping";
      else {
        if (elapsed >= 45000) mode = "drowsy";
        botIdleTimer = window.setTimeout(renderFactoryBot, (elapsed < 45000 ? 45000 : 60000) - elapsed);
      }
    } else {
      botIdleSince = undefined;
    }
    const labels = { drowsy: t("ui.getting.sleepy"), sleeping: t("ui.sleeping"), idle: t("ui.ready"), working: t("ui.working"), waiting: t("ui.waiting.for.your.reply"), complete: t("ui.completed"), error: t("ui.needs.attention"), offline: t("ui.resting.runtime.offline") };
    factoryBot.dataset.state = mode;
    if (botMenu) {
      const available = mode === "idle" || mode === "drowsy" || mode === "sleeping";
      botMenu.querySelectorAll("[data-bot-action]").forEach(button => { button.disabled = !available; });
      document.getElementById("bot-menu-note").hidden = available;
      if (!state.botVisible) closeBotMenu();
    }
    if (mode !== "idle" || !state.botVisible || !state.botAnimations || botReducedMotion.matches) clearBotGlance();
    updateBotGesture(mode);
    factoryBot.title = t("ui.factory.bot") + labels[mode] + (factoryBot.dataset.brain === "luna" ? t("ui.luna.none") : factoryBot.dataset.brain === "unavailable" ? t("ui.local.animation.luna.unavailable") : "");
    factoryBot.setAttribute("aria-label", factoryBot.title);
    if (mode === "complete" && !botWaveTimer) {
      botWaveTimer = window.setTimeout(function () {
        botWaveTimer = undefined;
        if (botOutcome === "completed") botOutcome = undefined;
        renderFactoryBot();
      }, 2400);
    }
  }

  function renderStatusBar() {
    renderFactoryBot();
    if (statusDragId) { statusRenderPending = true; return; }
    const focusedId = statusBar.contains(document.activeElement) ? document.activeElement.dataset.itemId : undefined;
    statusBar.replaceChildren();
    for (const itemId of state.statusItems.filter(statusItemAvailable)) {
      const item = document.createElement("span");
      item.className = "status-item";
      if (itemId === "runtime" && !state.runtimeAvailable) {
        item.classList.add("runtime-offline");
      }
      item.draggable = true;
      item.tabIndex = 0;
      item.dataset.itemId = itemId;
      item.textContent = statusLabel(itemId);
      item.title = statusCatalog()[itemId][1];
      item.setAttribute("aria-description", statusCatalog()[itemId][1]);
      item.setAttribute("aria-label", statusCatalog()[itemId][0] + ": " + item.textContent + t("ui.move.with.alt.left.right"));
      if (itemId === "agents" && state.role === "main") {
        item.classList.add("work-unit-activity");
        item.dataset.active = String(state.workUnits.activeUnits > 0);
        item.title = state.workUnitsKnown ? t("ui.active.agent.tasks") + state.workUnits.activeUnits + t("ui.total.calls") + state.workUnits.totalCalled : t("ui.agent.status.unavailable.click.to.refresh");
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
      agentsList.append(emptyAgentItem(t("ui.loading.called.agents")));
      return;
    }
    if (state.childAgents.length === 0) {
      agentsList.append(emptyAgentItem(t("ui.no.work.or.verification.agents.have.been.called.yet")));
      return;
    }
    for (const agent of state.childAgents) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "agent-item";
      item.setAttribute("role", "option");
      item.title = agent.agentId + t("ui.chat.with.session");
      const main = document.createElement("span");
      main.className = "agent-item-main";
      const role = document.createElement("span");
      role.className = "agent-role";
      role.textContent = agent.role === "work" ? t("ui.work") : t("ui.verification");
      const id = document.createElement("span");
      id.className = "agent-id";
      id.textContent = childTaskName(agent);
      const status = document.createElement("span");
      status.className = "agent-status";
      status.textContent = childAgentStatusLabel(agent.status) + t("ui.click.to.chat");
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
      accepted: t("ui.queued"),
      queued: t("ui.queued"),
      starting: t("ui.starting"),
      running: t("ui.running.73989d"),
      cancelling: t("ui.cancelling"),
      completed: t("ui.completed"),
      failed: t("ui.failed.09fef5"),
      cancelled: t("ui.cancelled"),
      "needs-human-decision": t("ui.user.decision.required"),
      unknown: t("ui.status.unknown")
    };
    return labels[status] || status;
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

  function moveStatus(itemId, offset) {
    const visible = state.statusItems.filter(statusItemAvailable);
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
    const visible = state.statusItems.filter(statusItemAvailable);
    const ids = [...visible, ...Object.keys(statusCatalog()).filter(id => !state.statusItems.includes(id) && statusItemAvailable(id))];
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
      preview.textContent = statusLabel(id);
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
    if (!statusSettings.hidden && statusCatalogList.dataset.available !== Object.keys(statusCatalog()).filter(statusItemAvailable).join(",")) {
      renderStatusCatalog();
    }
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
    renderGeneralSettings();
    statusSettings.hidden = false;
    statusSettingsButton.setAttribute("aria-expanded", "true");
    renderStatusCatalog();
    statusSettings.querySelector('[role="tab"][aria-selected="true"]')?.focus();
  });
  const settingsTabs = [...statusSettings.querySelectorAll("[data-settings-tab]")];
  function selectSettingsTab(tab) {
    for (const item of settingsTabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden = !selected;
    }
    renderStatusCatalog();
    tab.focus();
  }
  for (const tab of settingsTabs) {
    tab.addEventListener("click", function () { selectSettingsTab(tab); });
    tab.addEventListener("keydown", function (event) {
      const index = settingsTabs.indexOf(tab);
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % settingsTabs.length;
      if (event.key === "ArrowLeft") next = (index + settingsTabs.length - 1) % settingsTabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = settingsTabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      selectSettingsTab(settingsTabs[next]);
    });
  }
  document.getElementById("bots-disabled").addEventListener("change", function (event) {
    state.botsEnabled = !event.target.checked;
    renderFactoryBot();
    vscode.postMessage({ type: "bots.configure", enabled: state.botsEnabled });
  });
  for (const [id, key] of [["bot-visible", "botVisible"], ["bot-animations", "botAnimations"]]) {
    const control = document.getElementById(id);
    control.checked = state[key];
    control.addEventListener("change", function () {
      state[key] = control.checked;
      renderFactoryBot();
      persist();
    });
  }
  document.getElementById("status-settings-close").addEventListener("click", closeStatusSettings);
  document.getElementById("status-reset").addEventListener("click", function () {
    setStatusItems(defaultStatusItems, t("ui.default.status.items.and.order.restored"));
  });
  statusSettings.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      if (CSS.supports("selector(select:open)") && statusSettings.querySelector("select:open")) return;
      event.preventDefault(); event.stopPropagation(); closeStatusSettings();
    }
  });

  function statusItemAvailable(id) {
    const main = state.role === "main";
    const hasUsage = safeCountOrUndefined(state.contextUsedTokens) !== undefined;
    const hasWindow = state.contextWindowTokens > 0;
    const supported = currentCapabilities();
    switch (id) {
      case "context": case "contextRemainingTokens": case "contextUsedPercent": return hasUsage && hasWindow;
      case "contextUsed": return hasUsage;
      case "contextWindow": return hasWindow;
      case "weekly": case "weeklyRemaining": return safePercentOrUndefined(state.weeklyUsedPercent) !== undefined;
      case "agents": case "agentsTotal": return main && state.workUnitsKnown;
      case "goalTokens": return main && !goalError && safeCountOrUndefined(nativeGoal?.tokensUsed) !== undefined;
      case "goalTime": return main && !goalError && safeCountOrUndefined(nativeGoal?.timeUsedSeconds) !== undefined;
      case "goalBudget": return main && !goalError && safeCountOrUndefined(nativeGoal?.tokenBudget) !== undefined;
      case "goal": return main && !goalError && Boolean(nativeGoal || supported.goal);
      case "task": return main;
      case "model": case "reasoning": case "fast": return Boolean(supported[id]);
      case "elapsed": return Boolean(state.running && state.runStartedAt);
      case "project": return Boolean(state.projectName);
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
      status: state.pendingDecisionRunId ? t("ui.awaiting.input") : state.running ? t("ui.running.73989d") : state.runtimeAvailable ? t("ui.idle") : t("ui.offline"),
      role: { main: t("ui.main"), work: t("ui.work"), verification: t("ui.verify") }[state.role],
      agents: main ? state.workUnitsKnown ? t("status.agents", state.workUnits.workActive, state.workUnits.verificationActive) : t("ui.agents") : t("ui.agents.main.only"),
      agentsTotal: main ? t("ui.calls") + (state.workUnitsKnown ? count(state.workUnits.totalCalled) : "—") : t("ui.calls.main.only"),
      project: state.projectName || t("ui.project.f7d911"),
      branch: state.branch || "—",
      context: contextStatusLabel(),
      contextUsed: contextUsedStatusLabel(),
      contextRemainingTokens: contextRemainingTokensLabel(),
      contextUsedPercent: contextUsedPercentLabel(),
      contextWindow: t("ui.ctx.window") + (state.contextWindowTokens > 0 ? count(state.contextWindowTokens) : "—") + t("ui.tokens"),
      weekly: t("ui.wk.used") + (state.weeklyUsedPercent === undefined ? "—" : formatPercent(state.weeklyUsedPercent)),
      weeklyRemaining: t("ui.wk.left") + (state.weeklyUsedPercent === undefined ? "—" : formatPercent(100 - state.weeklyUsedPercent)),
      elapsed: state.running && state.runStartedAt ? t("ui.elapsed") + formatElapsed(Math.max(0, Date.now() - state.runStartedAt)) : t("ui.elapsed.54e60c"),
      queue: t("ui.queue") + Math.max(state.queueCount, (state.pendingRequests || []).length),
      runtime: state.runtimeAvailable ? t("ui.runtime.online") : t("ui.runtime.offline"),
      model: t("ui.model.b32422") + (supported.model ? state.model || t("ui.default") : t("ui.unknown")),
      reasoning: t("ui.reasoning.529e9c") + (supported.reasoning ? reasoningDisplayLabel(state.reasoning) : t("ui.unknown")),
      fast: t("ui.fast.314aef") + (supported.fast ? state.fastMode ? t("ui.on") : t("ui.off") : t("ui.unknown")),
      task: main ? t("ui.task") + taskModeNames()[state.taskMode]?.replaceAll(t("ui.verification"), t("ui.verify")) : t("ui.task.main.only"),
      execution: t("ui.perms") + (executionLabels[state.executionMode] || "—"),
      goal: !main ? t("ui.goal.main.only") : goalError ? t("ui.goal.0c4444") : nativeGoal ? t("ui.goal.8c9d70") + (goalLabels[nativeGoal.status] || "—") : t("ui.goal.8c9d70") + t("ui.off"),
      goalTokens: t("ui.goal.used") + (main && !goalError ? count(nativeGoal?.tokensUsed) : "—") + t("ui.tokens"),
      goalBudget: t("ui.goal.budget") + (main && !goalError ? count(nativeGoal?.tokenBudget) : "—") + t("ui.tokens"),
      goalTime: t("ui.goal.time") + (main && !goalError && safeCountOrUndefined(nativeGoal?.timeUsedSeconds) !== undefined ? formatElapsed(nativeGoal.timeUsedSeconds * 1000) : "—")
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
    label.textContent = t("queue.count", pending.length);
    toggle.setAttribute("aria-label", t("queue.items", pending.length));
    toggle.title = t("queue.expand", pending.length);
    toggle.onclick = function () {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      queue.hidden = !open;
    };
    queue.hidden = !expanded;
    queue.replaceChildren();
    const description = document.createElement("p");
    description.className = "pending-queue-description";
    description.textContent = state.pendingDecisionRunId ? t("ui.queued.messages.will.run.together.after.your.decision") : t("ui.queued.messages.retain.their.execution.action.only.matching.actions.run.together");
    queue.append(description);
    if (pending.some(function (item) { return !item.rejected; }) && !state.running && !state.pendingDecisionRunId) {
      const resume = document.createElement("button");
      resume.type = "button";
      resume.textContent = t("ui.check.run.status.and.resume.queue");
      resume.addEventListener("click", function () { vscode.postMessage({ type: "queue.resume" }); });
      queue.append(resume);
    }
    pending.forEach(function (item) {
      const entry = document.createElement("div");
      entry.textContent = item.text + (item.attachments.length ? " · " + item.attachments.map(function (attachment) { return attachment.name; }).join(", ") : "");
      renderSubmission(entry, submissionFromExecution(item.execution));
      queue.append(entry);
      if (item.rejected) {
        const recover = document.createElement("button");
        recover.type = "button";
        recover.textContent = t("ui.submission.unconfirmed.restore.to.input");
        recover.disabled = hasComposerContent();
        recover.addEventListener("click", function () {
          if (hasComposerContent()) return;
          state.pendingRequests = state.pendingRequests.filter(function (request) { return request.id !== item.id; });
          state.draft = item.text;
          prompt.value = item.text;
          state.attachments = item.attachments;
          state.taskMode = "direct";
          state.businessMode = "normal";
          state.model = item.execution.model;
          state.agentModels = item.execution.agentModels || {};
          state.reasoning = item.execution.reasoningEffort;
          state.fastMode = item.execution.fast;
          renderAll();
          resizePrompt();
          persist();
        });
        queue.append(recover);
      }
    });
  }

  function updateSendButton() {
    sendButton.disabled = !state.runtimeAvailable || !state.capabilities;
  }

  function updateRunControls() {
    renderPendingQueue();
    const queuesMessage = (state.running || (state.pendingRequests || []).length > 0) && hasComposerContent();
    updateExecutionControl();
    sendButton.classList.toggle("is-running", state.running && !queuesMessage);
    sendButton.setAttribute("aria-label", queuesMessage ? t("ui.add.message.to.queue") : state.running ? t("ui.stop.current.run") : t("ui.send.message"));
    sendButton.title = queuesMessage ? t("ui.add.to.queue.enter") : state.running ? t("ui.stop.current.run.esc") : t("ui.send.enter");
    sendIcon.hidden = state.running && !queuesMessage;
    stopIcon.hidden = !state.running || queuesMessage;
    renderRunStatus();
    renderWorkLoopPanel();
    updateSendButton();
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
    updateConversationClearControl();
    const select = document.querySelector('#general-permissions [data-setting="permissions"]');
    if (select) {
      select.disabled = state.running;
      select.value = state.executionMode ?? "cli-default";
      const help = document.getElementById("agent-permissions-description");
      help.textContent = executionModeExplanation(select.value);
      help.hidden = !help.textContent;
    }
  }

  function updateModeControls() {
    updateExecutionControl();
    const supported = currentCapabilities();
    modelButton.parentElement.hidden = false;
    submissionButton.hidden = state.role !== "main";
    fastModeButton.hidden = supported.fast !== true;
    fastModeButton.setAttribute("aria-pressed", String(state.fastMode));
    fastModeButton.setAttribute("aria-label", state.fastMode ? t("ui.fast.mode.on") : t("ui.fast.mode.off"));
    fastModeButton.title = state.fastMode ? t("ui.fast.mode.on") : t("ui.fast.mode.off");
    promptSurface.classList.toggle("is-astra", /(?:^|[-/])astra(?:$|-)/i.test(state.model || ""));
    const modelText = (state.model || t("ui.default")) + " · " + reasoningDisplayLabel(state.reasoning);
    if (modelLabel.textContent !== modelText) modelLabel.textContent = modelText;
    modelButton.title = t("ui.models.and.reasoning");
    modelButton.setAttribute("aria-label", modelButton.title);
    if (openSettingId === "submission") renderSubmissionMenu(submissionMenu);
    renderStatusBar();
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
    (selected || menu.querySelector("button:not(:disabled), select:not(:disabled)"))?.focus();
  }

  function renderModelSettings(menu) {
    menu.replaceChildren();
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", t("ui.models.and.reasoning"));
    const header = document.createElement("div");
    header.className = "agent-settings-heading";
    const title = document.createElement("strong");
    title.textContent = t("ui.agent.settings");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "agent-settings-close";
    close.setAttribute("aria-label", t("ui.close.agent.settings"));
    close.append(createModeIcon("m6 6 12 12M18 6 6 18", "agent-settings-close-icon"));
    close.addEventListener("click", function () { closeSettingMenu(true); });
    header.append(title, close);
    const columns = document.createElement("div");
    columns.className = "agent-settings-columns";
    columns.setAttribute("aria-hidden", "true");
    for (const text of [t("ui.agent"), t("ui.model"), t("ui.reasoning")]) {
      const column = document.createElement("span");
      column.textContent = text;
      columns.append(column);
    }
    menu.classList.add("aligned-settings");
    menu.append(header, columns);
    const roles = state.role === "main" ? [["main", t("ui.main")], ["work", t("ui.work")], ["verification", t("ui.verification")]] : [["main", state.role === "work" ? t("ui.work") : t("ui.verification")]];
    for (const [role, label] of roles) {
      const row = document.createElement("div");
      row.className = "agent-model-row";
      row.dataset.agentRole = role;
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", label);
      const legend = document.createElement("strong");
      legend.className = "agent-model-name";
      legend.textContent = label;
      row.append(legend);
      for (const field of ["model", "reasoningEffort"]) {
        const current = role === "main" ? (field === "model" ? state.model : state.reasoning) : state.agentModels?.[role]?.[field];
        const wrapper = document.createElement("label");
        const fieldLabel = field === "model" ? t("ui.model") : t("ui.reasoning");
        const caption = document.createElement("span");
        caption.className = "agent-model-caption";
        caption.textContent = fieldLabel;
        wrapper.append(caption);
        const values = field === "model" ? [...new Set(["", ...settingOptions.model, current].filter(value => typeof value === "string"))] : settingOptions.reasoning;
        const isReasoning = field === "reasoningEffort";
        const control = document.createElement(isReasoning ? "input" : "select");
        control.dataset.role = role;
        control.dataset.field = field;
        control.setAttribute("aria-label", label + " " + fieldLabel);
        const output = document.createElement("span");
        let slider;
        let progress;
        if (isReasoning) {
          wrapper.classList.add("agent-reasoning-control");
          output.className = "agent-reasoning-value";
          control.type = "range";
          control.min = "0";
          control.max = String(values.length - 1);
          control.step = "1";
          control.value = String(Math.max(0, values.indexOf(current || "")));
          wrapper.append(output);
          slider = document.createElement("span");
          slider.className = "agent-reasoning-slider";
          progress = document.createElement("progress");
          progress.max = values.length - 1;
          progress.setAttribute("aria-hidden", "true");
          const ticks = document.createElement("span");
          ticks.className = "agent-reasoning-ticks";
          ticks.setAttribute("aria-hidden", "true");
          for (const value of values) {
            const tick = document.createElement("span");
            tick.title = reasoningDisplayLabel(value);
            ticks.append(tick);
          }
          slider.append(progress, ticks);
        } else {
          for (const value of values) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value || t("ui.default");
            option.selected = value === (current || "");
            control.append(option);
          }
        }
        const selectedValue = () => isReasoning ? values[Number(control.value)] : control.value;
        const showEffort = () => {
          if (!isReasoning) return;
          const value = selectedValue();
          const ultra = value === "max";
          wrapper.classList.toggle("is-ultra", ultra);
          output.textContent = ultra ? "ULTRA" : value && uiLocale() === "en" ? value.toUpperCase() : reasoningDisplayLabel(value);
          output.title = ultra ? t("ui.ultra.max.reasoning.effort") : reasoningDisplayLabel(value);
          control.setAttribute("aria-valuetext", reasoningDisplayLabel(value));
          progress.value = Number(control.value);
        };
        showEffort();
        control.disabled = currentCapabilities()[isReasoning ? "reasoning" : "model"] !== true;
        control.addEventListener(isReasoning ? "input" : "change", function () {
          const value = selectedValue();
          showEffort();
          if (role === "main") state[isReasoning ? "reasoning" : "model"] = value;
          else {
            state.agentModels = { ...state.agentModels, [role]: { ...state.agentModels?.[role], [field]: value || undefined } };
          }
          updateModeControls();
          persist();
          saveComposerSettings();
        });
        if (slider) {
          slider.append(control);
          wrapper.append(slider);
        } else wrapper.append(control);
        row.append(wrapper);
      }
      menu.append(row);
    }
  }

  function renderGeneralSettings() {
    const menu = document.getElementById("general-permissions");
    menu.replaceChildren();
    if (state.role === "main") {
      const row = document.createElement("div");
      row.className = "agent-permissions-row";
      const legend = document.createElement("div");
      legend.className = "agent-permissions-heading";
      const name = document.createElement("strong");
      name.textContent = t("ui.permissions");
      legend.append(name);
      const select = document.createElement("select");
      select.dataset.setting = "permissions";
      select.setAttribute("aria-label", t("ui.execution.permissions"));
      for (const value of settingOptions.execution) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = executionModeName(value);
        option.selected = value === (state.executionMode ?? "cli-default");
        select.append(option);
      }
      const help = document.createElement("p");
      help.id = "agent-permissions-description";
      select.setAttribute("aria-describedby", help.id);
      const explain = () => { help.textContent = executionModeExplanation(select.value); help.hidden = !help.textContent; };
      explain();
      select.disabled = state.running;
      select.addEventListener("change", function () {
        if (state.running) return;
        state.executionMode = select.value;
        vscode.postMessage({ type: "execution.select", mode: select.value });
        explain(); renderStatusBar(); persist(); saveComposerSettings();
      });
      row.append(legend, select, help);
      menu.append(row);
    }
  }

  function updateConversationClearControl() {
    const clear = document.getElementById("conversation-clear-button");
    clear.hidden = state.role !== "main";
    clear.disabled = !state.agentId || state.running || state.queueCount > 0 || Boolean(state.pendingDecisionRunId);
    clear.title = t("ui.clear.conversation") + " · " + t("ui.start.a.fresh.codex.thread.here.agent.settings.and.historical.run.records.are.retained");
    clear.setAttribute("aria-label", t("ui.clear.conversation"));
    clear.onclick = function () {
      if (!clear.disabled) vscode.postMessage({ type: "conversation.clear" });
    };
  }

  function resetConversationState() {
    state.historyNextBefore = undefined;
    timelineEndId = undefined;
    messageViewStates.clear();
    state.timeline = [];
    state.taskFlows = [];
    state.pendingRequests = [];
    state.startedMessageIds = [];
    state.pendingDecisionRunId = undefined;
    state.decisionSubmitting = false;
    state.queueCount = 0;
    state.contextUsedTokens = undefined;
    state.contextWindowTokens = undefined;
    state.weeklyUsedPercent = undefined;
    state.childAgents = [];
    state.workflows = [];
    state.workUnitsKnown = false;
    state.workUnits = { activeUnits: 0, workActive: 0, verificationActive: 0, totalCalled: 0 };
    nativeGoal = null;
    goalError = undefined;
    followLatest = true;
  }

  function renderSubmissionMenu(menu) {
    menu.replaceChildren();
    const groups = [
      [t("ui.document.main"), settingOptions.business.map(value => [businessModeNames()[value], "direct", value, false])],
      [t("ui.task.workflow"), settingOptions.task.map(value => [taskModeNames()[value], value, "normal", false])],
      [t("ui.goal"), [[t("ui.goal"), "direct", "normal", true]]]
    ];
    for (const [title, entries] of groups) {
      const group = document.createElement("div");
      group.setAttribute("role", "group"); group.setAttribute("aria-label", title);
      const heading = document.createElement("div"); heading.className = "submission-heading"; heading.textContent = title;
      group.append(heading);
      for (const [label, action, workflow, goal] of entries) {
        const option = document.createElement("button");
        option.type = "button"; option.className = "setting-option"; option.setAttribute("role", "menuitem");
        option.dataset.action = action; option.dataset.workflow = workflow; option.dataset.goal = String(goal);
        option.disabled = !state.runtimeAvailable || (goal ? currentCapabilities().goal !== true : action !== "direct" && !currentCapabilities().taskModes?.includes(action));
        option.title = option.disabled ? t("ui.requires.a.compatible.runtime") : t("submission.send", label);
        const name = document.createElement("span"); name.textContent = label;
        const icon = goal ? createModeIcon("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "task-mode-icon") : workflow !== "normal" ? createBusinessModeIcon(workflow) : createTaskModeIcon(action);
        option.append(icon, name, createModeIcon("M12 19V5m-6 6 6-6 6 6", "submit-icon"));
        option.addEventListener("click", function () { closeSettingMenu(false); submit(action, workflow, goal); });
        option.addEventListener("keydown", handleSettingMenuKeydown);
        group.append(option);
      }
      menu.append(group);
    }
  }

  function renderSettingMenu(setting, menu) {
    if (setting === "model") renderModelSettings(menu);
    else renderSubmissionMenu(menu);
  }

  function createBusinessModeIcon(mode) {
    const paths = {
      normal: "M4 4h6v6H4Zm10 0h6v6h-6ZM4 14h6v6H4Zm10 0h6v6h-6Z",
      interview: "M4 4h16v12H9l-5 4V4Zm4 4h8M8 12h5",
      planning: "M5 3h14v18H5ZM8 7h2m3 0h3M8 12h2m3 0h3M8 17h2m3 0h3",
      design: "M3 3h6v6H3Zm12 12h6v6h-6ZM9 6h9v9M6 9v9h9"
    };
    return createModeIcon(paths[mode] || paths.normal, "task-mode-icon");
  }

  function executionModeExplanation(mode) {
    return ({
      "cli-default": t("ui.inherit.the.current.session.or.cli.permission.policy"),
      "workspace-write": t("ui.allow.writes.within.the.workspace.other.actions.follow.the.host.approval.policy"),
      "danger-full-access": t("ui.allow.filesystem.access.outside.the.workspace.approvals.still.follow.the.host.policy"),
      bypass: ""
    })[mode] ?? t("ui.use.the.host.permission.policy");
  }

  function createTaskModeIcon(mode) {
    const paths = {
      plan: "M5 3h14v18H5ZM8 7h2m3 0h3M8 12h2m3 0h3M8 17h2m3 0h3",
      verification: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6M6 10l3 3 5-6",
      direct: "m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z",
      work: "M14 6a5 5 0 0 0-6 6L3 17a2.8 2.8 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z",
      "plan-work": "M14 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6M8 7h6M8 11h4M8 15h2m5 0 5 3-5 3v-6",
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
    const options = Array.from(event.currentTarget.closest(".setting-menu").querySelectorAll(".setting-option:not(:disabled)"));
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

  function settingButton(setting) { return setting === "model" ? modelButton : submissionButton; }
  function settingMenu(setting) { return setting === "model" ? modelMenu : submissionMenu; }

  function executionModeName(mode) {
    return ({
      "read-only": t("ui.read.only"),
      "cli-default": state.agentId ? t("ui.keep.current.policy") : t("ui.cli.default"),
      "workspace-write": t("ui.workspace.write"),
      "danger-full-access": t("ui.full.access"),
      "bypass": t("ui.bypass")
    })[mode] || (state.agentId ? t("ui.keep.current.policy") : t("ui.cli.default"));
  }

  function resizePrompt() {
    prompt.style.height = "auto";
    prompt.style.height = Math.min(prompt.scrollHeight, 280) + "px";
  }

  function persist(immediate = true, delay = 50) {
    if (immediate) {
      clearTimeout(persistenceTimer);
      persistenceTimer = undefined;
      persistenceScheduled = false;
      persistNow();
      return;
    }
    if (persistenceScheduled) return;
    persistenceScheduled = true;
    persistenceTimer = setTimeout(function () {
      persistenceTimer = undefined;
      if (!persistenceScheduled) return;
      persistenceScheduled = false;
      persistNow();
    }, delay);
  }
  function persistNow() {
    vscode.setState({
      startedMessageIds: state.startedMessageIds,
      pendingRequests: state.pendingRequests,
      panelId: state.panelId,
      agentId: state.agentId,
      conversationId: state.conversationId,
      historyNextBefore: state.historyNextBefore,
      title: state.title,
      role: state.role,
      verifiedWorkRunId: state.verifiedWorkRunId,
      draft: state.draft,
      autoScroll: state.autoScroll,
      uiLanguage: state.uiLanguage,
      botVisible: state.botVisible,
      botAnimations: state.botAnimations,
      attachments: state.attachments.filter(function (attachment) {
        return !attachment.pending && !attachment.previewUri?.startsWith("blob:");
      }).map(function (attachment) {
        if (attachment.kind !== "image") return attachment;
        const { previewUri, ...persisted } = attachment;
        return persisted;
      }),
      taskFlows: currentTaskFlows().slice(-100),
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
      agentModels: state.agentModels,
      model: state.model,
      reasoning: state.reasoning,
      fastMode: state.fastMode,
      contextUsedTokens: state.contextUsedTokens,
      contextWindowTokens: state.contextWindowTokens,
      weeklyUsedPercent: state.weeklyUsedPercent,
      runProgress: state.runProgress,
      runProgressLocalization: state.runProgressLocalization,
      runStartedAt: state.runStartedAt,
      runPanelExpanded: state.runPanelExpanded,
      workUnits: state.workUnits,
      childAgents: state.childAgents,
      workflows: state.workflows
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
    const items = [...new Set(value.filter(item => typeof item === "string" && Object.hasOwn(statusCatalog(), item)))];
    return value.length === 0 || items.length ? items : defaultStatusItems.slice();
  }

  function saveComposerSettings() {
    vscode.postMessage({
      type: "composer.settings",
      agentModels: state.agentModels,
      model: state.model || undefined,
      reasoning: state.reasoning || undefined,
      fastMode: state.fastMode,
      goalMode: false,
      businessMode: "normal",
    });
  }

  function contextStatusLabel() {
    if (state.contextUsedTokens === undefined || !(state.contextWindowTokens > 0)) return t("ui.ctx.left");
    const remaining = Math.max(0, state.contextWindowTokens - state.contextUsedTokens);
    return t("ui.ctx.left.350cbf") + formatPercent(remaining / state.contextWindowTokens * 100);
  }

  function contextUsedStatusLabel() {
    return t("ui.ctx.used") + (state.contextUsedTokens === undefined
      ? "—" : state.contextUsedTokens.toLocaleString(uiLocale())) + t("ui.tokens");
  }

  function contextRemainingTokensLabel() {
    if (state.contextUsedTokens === undefined || !(state.contextWindowTokens > 0)) return t("ui.ctx.left.tokens");
    return t("ui.ctx.left.350cbf") + Math.max(0, state.contextWindowTokens - state.contextUsedTokens).toLocaleString(uiLocale()) + t("ui.tokens");
  }

  function contextUsedPercentLabel() {
    return t("ui.ctx.used") + (state.contextUsedTokens === undefined || !(state.contextWindowTokens > 0)
      ? "—" : formatPercent(state.contextUsedTokens / state.contextWindowTokens * 100));
  }

  function formatPercent(value) {
    return value.toLocaleString(uiLocale(), { maximumFractionDigits: 1 }) + "%";
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
    meter.setAttribute("aria-label", t("ui.content.remaining.percentage"));
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

  const languageControl = document.getElementById("ui-language");
  languageControl.value = state.uiLanguage;
  languageControl.addEventListener("change", function () {
    const feedback = globalThis.AgentFactoryI18n.describe(inputFeedback.textContent);
    state.uiLanguage = languageControl.value;
    displayLanguage = state.uiLanguage;
    document.documentElement.lang = uiLocale();
    globalThis.AgentFactoryI18n.apply(document, uiLocale());
    inputFeedback.textContent = localizedText(inputFeedback.textContent, feedback);
    renderAll();
    renderStatusCatalog();
    renderModelSettings(modelMenu);
    renderSubmissionMenu(submissionMenu);
    renderGeneralSettings();
    renderQuestionList();
    renderSessionList();
    renderAgentsList();
    renderFactoryBot();
    persist();
  });
})();
