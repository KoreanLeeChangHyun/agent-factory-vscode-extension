(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const _generalSettings = globalThis.AgentFactoryChat.generalSettings({ vscode });
  let conversationClearing = false;
  let persistenceScheduled = false;
  let persistenceTimer;
  let persistenceStartedAt;
  let lastPersistedState;
  let composerLayoutFrame;
  let timelineRenderFrame;
  let previewFrame;
  const pendingPreviews = new Set();
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
  function assistantDisplayText(value) {
    if (typeof value !== "string") return value;
    let candidate = value.trim();
    const listItem = candidate.match(/^(?:[-+*]|\u2022)[ \t]+(\{[\s\S]*\})$/);
    if (listItem) candidate = listItem[1];
    if (!candidate.startsWith("{")) return value;
    let envelope;
    try { envelope = JSON.parse(candidate); } catch { return value; }
    if (!envelope || Array.isArray(envelope) || typeof envelope !== "object") return value;
    const keys = Object.keys(envelope);
    const allowed = new Set(["decisionKind", "resultPath", "resultText", "status"]);
    return keys.every(key => allowed.has(key)) && typeof envelope.status === "string" &&
      typeof envelope.resultPath === "string" && typeof envelope.resultText === "string"
      ? envelope.resultText : value;
  }
  // Host-derived approval target; only verbatim response text is shown.
  function decisionApproval(value) {
    if (!value || typeof value !== "object") return undefined;
    const request = typeof value.request === "string" && value.request.trim() ? value.request.trim() : undefined;
    const irreversible = Array.isArray(value.irreversible) ? value.irreversible.filter(item => typeof item === "string" && item.trim()) : [];
    return request || irreversible.length ? { request, irreversible } : undefined;
  }
  function reasoningDisplayLabel(value) { return value ? uiLocale() === "en" ? value : t("ui." + value) : t("ui.default"); }

  const chatSyntax = globalThis.AgentFactoryChat.syntax({
    createActivityPhase, t, renderTimeline,
    get state() { return state; }
  });
  const chatMarkdown = globalThis.AgentFactoryChat.markdown({
    t, vscode, applySyntaxHighlighting: chatSyntax.applySyntaxHighlighting,
    get state() { return state; }
  });
  const timeline = document.getElementById("timeline");
  const jumpToBottom = document.getElementById("jump-to-bottom");
  const chatTerminal = globalThis.AgentFactoryChat.terminal({
    t, createActivityPhase, timeline, chatSyntax
  });
  const chatActivityRows = globalThis.AgentFactoryChat.activityRows({
    t, timeline, chatTerminal, chatSyntax, chatMarkdown, isRunning: () => state.running
  });
  const emptyState = document.getElementById("empty-state");
  const prompt = document.getElementById("prompt");
  const promptSurface = prompt.closest(".prompt-surface");
  const sendButton = document.getElementById("send-button");
  const sendIcon = document.getElementById("send-icon");
  const goalSendIcon = document.getElementById("goal-send-icon");
  const stopIcon = document.getElementById("stop-icon");
  const attachButton = document.getElementById("attach-button");
  const autoScrollButton = document.getElementById("auto-scroll-button");
  const autoScrollState = document.getElementById("auto-scroll-state");
  const modelButton = document.getElementById("model-button");
  const modelLabel = document.getElementById("model-label");
  const submissionButton = document.getElementById("submission-button");
  const submissionMenu = document.getElementById("submission-menu");
  const inputFeedback = document.getElementById("input-feedback");
  const chatSudo = globalThis.AgentFactoryChat.sudo({
    t, inputFeedback, vscode
  });

  const modelMenu = document.getElementById("model-menu");
  const fastModeSetting = document.getElementById("agent-fast-setting");
  const fastModeButton = document.getElementById("fast-mode-button");
  const fastModeValue = document.getElementById("fast-mode-value");
  const orchestrateModeButton = document.getElementById("orchestrate-mode-button");
  const workIsolationButton = document.getElementById("work-isolation-button");
  const businessModeNames = () => ({ normal: t("ui.normal"), contract: t("ui.contract"), interview: t("ui.interview"), planning: t("ui.planning"), design: t("ui.design"), migration: t("ui.migration"), lessons: t("ui.lessons"), pipeline: t("ui.pipeline") });
  const taskModeNames = () => ({ orchestrate: t("ui.orchestrate.mode"), plan: t("ui.plan"), verification: t("ui.verification"), direct: t("ui.direct"), work: t("ui.work"), "plan-work": t("ui.plan.work"), "work-verification": t("ui.work.verification"), "plan-work-verification": t("ui.plan.work.verification") });
  let nativeGoal = null;
  let goalError;
  const sessionMenu = document.getElementById("session-menu");
  const sessionList = document.getElementById("session-list");
  const questionButton = document.getElementById("question-button");
  const questionMenu = document.getElementById("question-menu");
  const questionList = document.getElementById("question-list");
  const questionTabs = [...questionMenu.querySelectorAll("[data-question-tab]")];
  const factoryBot = document.getElementById("factory-bot");
  const runStatusLabel = document.getElementById("run-status-label");
  const runElapsed = document.getElementById("run-elapsed");
  const attachmentList = document.getElementById("attachment-list");
  const chatWorkUnits = globalThis.AgentFactoryChat.workUnits({
    openSetting, closeSettingMenu, vscode, handleSettingMenuKeydown, t, promptSurface, prompt,
    updateSendButton,
    get state() { return state; },
    get openSettingId() { return openSettingId; }
  });
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
    project: [t("worktree.location"), chatWorkUnits.worktreeLocationDescription()],
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
    fiveHour: [t("ui.five.hour.usage"), t("ui.latest.reported.usage.percentage.of.the.5.hour.account.limit.if.available")],
    fiveHourRemaining: [t("ui.five.hour.remaining"), t("ui.100.minus.five.hour.usage.an.absolute.token.count.is.not.provided")],
    fiveHourReset: [t("ui.five.hour.reset"), t("ui.five.hour.reset.description")],
    weekly: [t("ui.weekly.usage"), t("ui.latest.reported.usage.percentage.of.the.7.day.account.limit.if.available")],
    weeklyRemaining: [t("ui.weekly.remaining"), t("ui.100.minus.weekly.usage.an.absolute.token.count.is.not.provided")],
    weeklyReset: [t("ui.weekly.reset"), t("ui.weekly.reset.description")],
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
  const chatShortcuts = globalThis.AgentFactoryChat.shortcuts({
    t, botDisplayName, businessModeNames, saved, sendButton, factoryBot, persist,
    submissionOptionDisabled, closeSettingMenu, submit, openSetting,
    get state() { return state; },
    get botTalkButton() { return chatBot.botTalkButton; },
    get botMenu() { return chatBot.botMenu; },
    get openSettingId() { return openSettingId; },
    get chatNavigation() { return chatNavigation; },
    get chatHistory() { return chatHistory; }
  });
  function botDisplayName() {
    return t(state.companionAvailable ? "bot.name.lumi" : "bot.name.factory");
  }
  const state = {
    guidanceExpanded: Array.isArray(saved?.guidanceExpanded) ? saved.guidanceExpanded.filter(id => typeof id === "string") : [],
    panelId: typeof saved?.panelId === "string" ? saved.panelId : undefined,
    agentId: typeof saved?.agentId === "string" ? saved.agentId : undefined,
    capturedRun: normalizeCapturedRun(saved?.capturedRun, saved?.agentId),
    conversationId: typeof saved?.conversationId === "string" ? saved.conversationId : undefined,
    title: typeof saved?.title === "string" ? saved.title : "Main Agent",
    role: ["main", "work", "verification"].includes(saved?.role) ? saved.role : "main",
    verifiedWorkRunId: typeof saved?.verifiedWorkRunId === "string" ? saved.verifiedWorkRunId : undefined,
    draft: typeof saved?.draft === "string" ? saved.draft : "",
    autoScroll: saved?.autoScroll !== false,
    // Ordinary Enter sends orchestrator mode unless the Human switches this chat to worker mode (direct).
    orchestrateMode: saved?.orchestrateMode !== false,
    // Per project; the host restores it on initialize and stores every change.
    workIsolation: false,
    docsAuditInterval: "off",
    uiLanguage: ["auto", "ko", "en"].includes(saved?.uiLanguage) ? saved.uiLanguage : "auto",
    settingsTabOrder: saved?.settingsTabOrder,
    botsEnabled: false,
    botsAvailable: true,
    companionAvailable: true,
    botVisible: saved?.botVisible !== false,
    botPosition: Number.isFinite(saved?.botPosition?.x) && Number.isFinite(saved?.botPosition?.y) ? { x: saved.botPosition.x, y: saved.botPosition.y } : undefined,
    botAnimations: saved?.botAnimations !== false,
    botCare: restoreBotCare(saved?.botCare),
    attachments: Array.isArray(saved?.attachments) ? saved.attachments.filter(function (item) {
      return item && !item.pending && !item.previewUri?.startsWith("blob:") && item.data === undefined;
    }) : [],
    startedMessageIds: Array.isArray(saved?.startedMessageIds) ? saved.startedMessageIds : [],
    pendingRequests: Array.isArray(saved?.pendingRequests) ? saved.pendingRequests.map(item => ({ ...item, hostAcknowledged: false })) : [],
    recoveredRequest: saved?.recoveredRequest,
    timeline: collapseAdjacentReads(collapseCancellationNotices(Array.isArray(saved?.timeline) ? saved.timeline : [])),
    statusItems: normalizeStatusItems(saved?.statusItems),
    projectName: typeof saved?.projectName === "string" ? saved.projectName : "",
    pendingDecisionRunId: undefined,
    pendingDecisionCanApprove: false,
    pendingDecisionApproval: undefined,
    decisionSubmitting: false,
    executionMode: saved?.agentId ? undefined : "danger-full-access",
    runtimeAvailable: false,
    branch: undefined,
    capabilities: undefined,
    running: saved?.running === true,
    agentModels: saved?.agentModels || {},
    agentFastModes: normalizeAgentFastModes(saved?.agentFastModes, saved?.modelFastModes),
    model: normalizeModel(saved?.model),
    reasoning: normalizeSettingValue(saved?.reasoning, settingOptions.reasoning),
    agentSettingsVersion: saved?.agentSettingsVersion === 1 ? 1 : undefined,
    agentSettingsScope: ["global", "project", "chat"].includes(saved?.agentSettingsScope) ? saved.agentSettingsScope : undefined,
    agentSettingsSet: typeof saved?.agentSettingsSet === "string" && saved.agentSettingsSet.trim() ? saved.agentSettingsSet.trim() : "Chat",
    fastMode: saved?.fastMode === true,
    goalMode: false,
    businessMode: "normal",
    maestroMode: saved?.maestroMode === true,
    taskMode: "direct",
    workLoopMode: false,
    queueCount: 0,
    contextUsedTokens: safeCountOrUndefined(saved?.contextUsedTokens),
    contextWindowTokens: safeCountOrUndefined(saved?.contextWindowTokens),
    weeklyUsedPercent: safePercentOrUndefined(saved?.weeklyUsedPercent),
    fiveHourUsedPercent: safePercentOrUndefined(saved?.fiveHourUsedPercent),
    weeklyResetsAt: safeResetsAtOrUndefined(saved?.weeklyResetsAt),
    fiveHourResetsAt: safeResetsAtOrUndefined(saved?.fiveHourResetsAt),
    runExecutionStatus: typeof saved?.runExecutionStatus === "string" ? saved.runExecutionStatus : undefined,
    runProgress: typeof saved?.runProgress === "string" ? saved.runProgress : "",
    runProgressLocalization: saved?.runProgressLocalization,
    runStartedAt: Number.isFinite(saved?.runStartedAt) ? saved.runStartedAt : undefined,
    // Loop cards are restored from the runtime: another window may have deleted
    // their files while this Webview's persisted cache was closed.
    taskFlows: Array.isArray(saved?.taskFlows) ? saved.taskFlows.filter(flow => flow && typeof flow === "object" && !flow.engine).slice(-100) : [],
    runPanelExpanded: saved?.runPanelExpanded === true,
    runPanelUserChoice: saved?.runPanelUserChoice === true,
    sessions: [],
    sessionsLoading: false,
    historyNextBefore: saved?.historyNextBefore,
    workflows: [],
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
  const chatBot = globalThis.AgentFactoryChat.bot({
    state, vscode, factoryBot, uiLocale, botDisplayName, persist, t, prompt, chatShortcuts
  });
  let elapsedTimerId;
  let followLatest = true;
  let autoScrollFrame;
  let timelineViewportHeight;
  let timelineScrollTop = 0;
  const chatNavigation = globalThis.AgentFactoryChat.navigation({
    closeSettingMenu, sessionMenu, state, vscode, prompt, questionMenu, questionButton,
    promptSurface, questionTabs, historyEmpty, matchesShortcut: chatShortcuts.matchesShortcut, shortcuts: chatShortcuts.shortcuts, indexedTimeline, uiLocale,
    eventVersion, t, questionList, createModeIcon, renderTimeline, updateAutoScrollControl,
    sessionList,
    get chatHistory() { return chatHistory; },
    get questionSourceId() { return questionSourceId; },
    set questionSourceId(value) { questionSourceId = value; },
    get questionPageStart() { return questionPageStart; },
    set questionPageStart(value) { questionPageStart = value; },
    get questionListKey() { return questionListKey; },
    set questionListKey(value) { questionListKey = value; },
    get questionElements() { return questionElements; },
    get autoScrollFrame() { return autoScrollFrame; },
    get followLatest() { return followLatest; },
    set followLatest(value) { followLatest = value; },
    get messageElements() { return messageElements; },
    get timelineEndId() { return timelineEndId; },
    set timelineEndId(value) { timelineEndId = value; }
  });
  const chatStatusBar = globalThis.AgentFactoryChat.statusBar({
    chatBot, statusBar, statusCatalog, state, uiLocale, agentsMenu, t, renderContextStatus,
    normalizeStatusItems, persist, statusAnnouncement, vscode, statusSettings, statusCatalogList,
    statusSettingsButton, safeCountOrUndefined, currentCapabilities, safePercentOrUndefined,
    safeResetsAtOrUndefined, chatWorkUnits, contextStatusLabel, contextUsedStatusLabel,
    contextRemainingTokensLabel, contextUsedPercentLabel, formatPercent, formatResetsAt,
    formatElapsed, reasoningDisplayLabel, taskModeNames, enterAction,
    get statusDragId() { return statusDragId; },
    set statusDragId(value) { statusDragId = value; },
    get statusRenderPending() { return statusRenderPending; },
    set statusRenderPending(value) { statusRenderPending = value; },
    get statusElements() { return statusElements; },
    get chatAgents() { return chatAgents; },
    get statusRenderKeys() { return statusRenderKeys; },
    get goalError() { return goalError; },
    get nativeGoal() { return nativeGoal; },
    get chatAgentSettings() { return chatAgentSettings; }
  });
  const chatAgents = globalThis.AgentFactoryChat.agents({
    agentsMenu, state, renderStatusBar: chatStatusBar.renderStatusBar, vscode, agentsList, t,
    closeWorktreeMenu() { if (openSettingId === "worktree") closeSettingMenu(false); },
    get chatTaskFlow() { return chatTaskFlow; }
  });
  document.addEventListener("click", event => {
    const target = event.target.closest?.("[data-maestro-workflow]");
    if (target) vscode.postMessage({ type: "control.center.open", workflowId: target.dataset.maestroWorkflow, taskId: target.dataset.maestroTask });
  });
  const chatTaskFlow = globalThis.AgentFactoryChat.taskFlow({
    indexedTimeline, state, t, vscode,
    persist, childAgentStatusLabel: chatAgents.childAgentStatusLabel
  });
  let contractListMessage;
  // Long-term contracts, each with the number of task briefs (short-term contracts) bound to it.
  function renderContractList() {
    const message = contractListMessage;
    const list = document.getElementById("contract-list-list");
    list.replaceChildren();
    if (message.error) list.append(historyEmpty("contracts.failed"));
    else if (!message.contracts.length) list.append(historyEmpty("contracts.empty"));
    else for (const contract of message.contracts.filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)) {
      const button = document.createElement("button");
      button.className = "setting-option contract-list-entry";
      const title = document.createElement("span");
      title.className = "contract-list-title";
      title.textContent = contract.title;
      const metadata = document.createElement("span");
      metadata.className = "contract-list-metadata";
      const linked = (state.projectTasks || []).filter(entry => entry && entry.contract?.id === contract.id).length;
      metadata.textContent = [contract.id + " · v" + contract.version, linked ? t("flow.task.count", linked) : ""].filter(Boolean).join(" · ");
      button.title = contract.title + " · " + metadata.textContent;
      button.append(title, metadata);
      button.addEventListener("click", () => vscode.postMessage({ type: "contract.open", id: contract.id }));
      list.append(button);
    }
    chatHistory.positionTaskHistory();
  }
  const messageRenderKeys = new WeakMap();
  const eventVersions = new WeakMap();
  const managedCommandCache = new WeakMap();
  let nextEventVersion = 0;
  const statusElements = new Map();
  const statusRenderKeys = new WeakMap();
  const timelineIndexes = new WeakMap();
  let nextTimelineIndex = 0;
  let questionSourceId;
  let questionPageStart = 0;
  let questionListKey;
  const pendingQueueRows = new Map();
  const questionElements = new Map();
  const messageElements = new Map();
  const messageViewStates = new Map();
  let timelineEndId;

  const chatAttachments = globalThis.AgentFactoryChat.attachments({
    vscode, attachmentList, state, t, updateSendButton, persist, appendNotice, createId,
    get chatImageConverter() { return chatImageConverter; }
  });
  const chatPendingQueue = globalThis.AgentFactoryChat.pendingQueue({
    state, t, pendingQueueRows, vscode, cancelRun, uiLocale, submissionFromExecution,
    hasComposerContent, renderSubmission, prompt, renderAll, resizePrompt, persist
  });
  const chatActivities = globalThis.AgentFactoryChat.activities({
    state, t, uiLocale, vscode, activityPhaseAccessibleLabel, chatTerminal, taskModeNames, chatAgents
  });
  const chatInterview = globalThis.AgentFactoryChat.interview({
    indexedTimeline, state, submit, renderAll, persist
  });
  const chatAgentSettings = globalThis.AgentFactoryChat.agentSettings({
    state, t, fastModeButton, currentCapabilities, settingOptions, reasoningDisplayLabel, createId,
    uiLocale, normalizeAgentFastModes, persist, saveComposerSettings, updateModeControls, vscode,
    modelMenu, createModeIcon, fastModeSetting, closeSettingMenu, executionModeName,
    executionModeExplanation, renderStatusBar: chatStatusBar.renderStatusBar,
    get openSettingId() { return openSettingId; },
    get chatProviders() { return chatProviders; }
  });
  globalThis.AgentFactoryI18n.apply(document, uiLocale());
  document.documentElement.lang = uiLocale();
  prompt.value = state.draft;
  renderAll();
  resizePrompt();
  vscode.postMessage({ type: "client.ready", pendingMessageIds: state.pendingRequests.map(item => item.id) });
  const restoreImages = state.attachments.filter(function (item) { return item.kind === "image"; })
    .map(function (item) { return { id: item.id, name: item.name, target: "composer" }; });
  for (const event of [...state.timeline, ...state.pendingRequests]) {
    for (const item of Array.isArray(event.attachments) ? event.attachments : []) {
      if (item.kind === "image" && restoreImages.length < 100) restoreImages.push({ id: item.id, name: item.name, target: "history" });
    }
  }
  if (restoreImages.length) vscode.postMessage({ type: "attachments.restore", attachments: restoreImages });

  let syntaxThemeClass = document.body.className;
  new MutationObserver(function () {
    const nextThemeClass = document.body.className;
    if (nextThemeClass === syntaxThemeClass) return;
    syntaxThemeClass = nextThemeClass;
    chatSyntax.syntaxRevision += 1;
    renderTimeline();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  document.addEventListener("pointermove", chatBot.maybeGlanceAtPointer, { passive: true });
  document.documentElement.addEventListener("pointerleave", chatBot.clearBotGlance);
  window.addEventListener("blur", chatBot.clearBotGlance);
  document.addEventListener("visibilitychange", function () {
    chatBot.clearBotGlance();
    if (document.hidden) {
      chatBot.botRestingSince = Date.now();
      persist();
    } else if (chatBot.botRestingSince !== undefined && !chatBot.companionSnapshot) {
      state.botCare = { ...state.botCare,
        energy: Math.min(100, state.botCare.energy + Math.max(0, Date.now() - chatBot.botRestingSince) / 30000),
        updatedAt: Date.now() };
      chatBot.botRestingSince = undefined;
    }
    document.documentElement.dataset.afHidden = String(document.hidden);
    if (document.hidden && elapsedTimerId) {
      clearInterval(elapsedTimerId);
      elapsedTimerId = undefined;
    }
    chatBot.renderFactoryBot();
    if (!document.hidden) renderRunStatus();
  });
  chatBot.botReducedMotion.addEventListener("change", function () { chatBot.clearBotGlance(); chatBot.renderFactoryBot(); });
  factoryBot.addEventListener("pointerenter", chatBot.wakeFactoryBot);

  window.addEventListener("resize", chatBot.positionBotMenu);
  window.addEventListener("resize", function () { chatBot.positionBotSpeech(); chatBot.positionAboveCompanion(document.getElementById("companion-reaction")); });
  chatBot.botTalkButton.addEventListener("click", chatBot.talkToBot);
  // Capture before every other handler so recorded keys never trigger actions.
  document.addEventListener("keydown", function (event) {
    if (!chatShortcuts.shortcutRecording) return;
    const listening = !chatShortcuts.shortcutRecording.binding;
    // The close shortcut cancels, except while recording the close shortcut itself.
    if (chatShortcuts.shortcutRecording.id !== "close" && chatShortcuts.shortcutFromEvent(event) === chatShortcuts.shortcuts.close && !chatShortcuts.shortcutComposing(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      chatShortcuts.cancelShortcut(true);
      return;
    }
    if (!listening || chatShortcuts.shortcutComposing(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const binding = chatShortcuts.shortcutFromEvent(event);
    if (!binding || event.repeat) return;
    const action = chatShortcuts.shortcutActions.find(item => item.id === chatShortcuts.shortcutRecording.id);
    const problem = chatShortcuts.shortcutProblem(action, binding);
    if (problem) { chatShortcuts.shortcutStatus.textContent = t(problem); return; }
    const owner = chatShortcuts.shortcutActions.find(item => item.id !== action.id && chatShortcuts.shortcuts[item.id] === binding);
    chatShortcuts.shortcutRecording.binding = binding;
    chatShortcuts.shortcutRecording.problem = owner ? "conflict" : "";
    chatShortcuts.shortcutStatus.textContent = owner ? t("ui.shortcuts.conflict.named", owner.label()) : t("ui.shortcuts.pending", chatShortcuts.shortcutLabel(binding));
    chatShortcuts.renderShortcuts();
    chatShortcuts.focusShortcutControl(action.id, owner ? ".shortcut-cancel" : ".shortcut-confirm");
  }, true);
  document.addEventListener("pointerdown", function (event) {
    if (chatShortcuts.shortcutRecording && !event.target.closest?.('[data-shortcut-action="' + chatShortcuts.shortcutRecording.id + '"]')) chatShortcuts.cancelShortcut(false);
  }, true);
  document.getElementById("shortcuts-reset").addEventListener("click", () => {
    chatShortcuts.shortcutRecording = undefined;
    for (const action of chatShortcuts.shortcutActions) chatShortcuts.shortcuts[action.id] = action.fallback;
    chatShortcuts.shortcutStatus.textContent = t("ui.shortcuts.scope");
    chatShortcuts.renderShortcuts();
    persist();
  });
  // Routes trusted keys first: rebound basic controls, displaced default keys
  // and every chat-wide action.
  window.addEventListener("keydown", function (event) {
    if (chatShortcuts.shortcutRecording || !event.isTrusted || chatShortcuts.shortcutComposing(event)) return;
    const binding = chatShortcuts.shortcutFromEvent(event);
    if (!binding) return;
    const action = chatShortcuts.shortcutActions.find(item => chatShortcuts.shortcuts[item.id] === binding);
    if (action?.native) {
      if (binding === action.native) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action.id === "close") { if (!event.repeat) chatShortcuts.emulateEscape(); }
      else chatShortcuts.moveFocus(action.id === "focusNext" ? 1 : -1);
      return;
    }
    const displaced = chatShortcuts.shortcutActions.some(item => item.native === binding);
    if (action && !action.scope) {
      if (chatShortcuts.runGlobalShortcut(event, action) && displaced) event.stopImmediatePropagation();
      return;
    }
    if (displaced && !action) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  prompt.addEventListener("keydown", function (event) {
    if (!chatShortcuts.matchesShortcut(event, chatShortcuts.shortcuts.bot)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) chatBot.talkToBot();
  }, true);
  chatShortcuts.renderShortcuts();
  document.getElementById("bot-speech-close").addEventListener("click", function () {
    chatBot.botSpeechVisible = false;
    chatBot.renderBotTalk();
    prompt.focus({ preventScroll: true });
  });

  document.addEventListener("pointerdown", function (event) {
    if (!chatBot.botMenu.contains(event.target) && !factoryBot.contains(event.target)) chatBot.closeBotMenu();
  });
  const chatNotes = globalThis.AgentFactoryChat.notes({
    saved, persist, vscode, prompt, t
  });

  const chatHistory = globalThis.AgentFactoryChat.history({
    handleSettingMenuKeydown, vscode, submissionMenu, questionButton, t, closeQuestionMenu: chatNavigation.closeQuestionMenu,
    renderAssistantMarkdown: chatMarkdown.renderAssistantMarkdown, assistantDisplayText, historyEmpty
  });

  function historyEmpty(key) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = t(key);
    return empty;
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !chatBot.botSpeech.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      chatBot.botSpeechVisible = false;
      chatBot.renderBotTalk();
      factoryBot.focus();
      return;
    }
    if (event.key === "Escape" && !chatBot.botMenu.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      chatBot.closeBotMenu(true);
    }
  }, true);
  chatBot.botMenu.addEventListener("click", function (event) {
    const button = event.target.closest("[data-bot-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.botAction;
    if (action === "play" && chatBot.botTalkPending) return;
    if (state.companionAvailable && ["feed", "play", "sleep"].includes(action)) {
      chatBot.interactCompanion(action);
      chatBot.closeBotMenu(true);
      if (action === "play") chatBot.startBotConversation(t("bot.play.prompt"), false);
      return;
    }
    if (!["feed", "play", "sleep"].includes(action)) return;
    chatBot.updateBotCare();
    const care = state.botCare;
    state.botCare = { ...care,
      fullness: Math.min(100, care.fullness + (action === "feed" ? 25 : 0)),
      happiness: Math.min(100, care.happiness + (action === "play" ? 20 : action === "feed" ? 5 : 0)),
      energy: Math.max(0, care.energy - (action === "play" ? 5 : 0)),
      careCount: care.careCount + 1 };
    chatBot.closeBotMenu(true);
    chatBot.clearBotGlance();
    clearTimeout(chatBot.botGestureTimer);
    chatBot.botGestureTimer = undefined;
    if (action === "sleep") {
      chatBot.botIdleSince = Date.now() - 60000;
      chatBot.renderFactoryBot();
    } else {
      let gesture = action;
      if (action === "play") {
        const choices = chatBot.botPlayActivities.filter(activity =>
          activity !== chatBot.botLastPlayActivity && activity !== factoryBot.dataset.gesture);
        gesture = choices[Math.floor(Math.random() * choices.length)];
        chatBot.botLastPlayActivity = gesture;
      }
      delete factoryBot.dataset.gesture;
      factoryBot.getBoundingClientRect();
      factoryBot.dataset.gesture = gesture;
      chatBot.botGestureTimer = window.setTimeout(function () {
        chatBot.botGestureTimer = undefined;
        chatBot.renderFactoryBot();
      }, 8000);
    }
    chatBot.renderBotCare();
    persist();
    if (action === "play") chatBot.startBotConversation(t("bot.play.prompt"), false);
  });
  factoryBot.addEventListener("click", function (event) {
    if (chatBot.consumeDragClick(event)) return;
    const opening = chatBot.botMenu.hidden;
    chatBot.wakeFactoryBot();
    clearTimeout(chatBot.botReactionTimer);
    delete factoryBot.dataset.reacting;
    chatBot.botMenu.hidden = !opening;
    if (opening) { chatBot.botSpeechVisible = false; chatBot.renderBotTalk(); }
    chatBot.renderBotCare();
    factoryBot.setAttribute("aria-expanded", String(opening));
    if (opening) {
      chatBot.positionBotMenu();
      const first = chatBot.botMenu.querySelector("button:not(:disabled)");
      if (first) first.focus();
    }
  });
  document.addEventListener("pointerdown", chatBot.wakeFactoryBot);
  document.addEventListener("keydown", chatBot.wakeFactoryBot);
  document.addEventListener("input", chatBot.wakeFactoryBot);

  prompt.addEventListener("input", function () {
    chatBot.botDraftRevision++;
    chatBot.renderBotTalk();
    state.draft = prompt.value;
    persist(false, 150);
    if (composerLayoutFrame !== undefined) return;
    composerLayoutFrame = requestAnimationFrame(function () {
      composerLayoutFrame = undefined;
      resizePrompt();
      updateComposerControls();
    });
  });
  prompt.addEventListener("blur", function () { persist(); });

  prompt.addEventListener("keydown", function (event) {
    if (chatShortcuts.shortcuts.newLine !== "Shift+Enter" && !chatShortcuts.shortcutComposing(event) && chatShortcuts.shortcutFromEvent(event) === "Shift+Enter" &&
      !chatShortcuts.shortcutActions.some(action => action.scope === "prompt" && chatShortcuts.shortcuts[action.id] === "Shift+Enter")) {
      event.preventDefault();
      return;
    }
    if (chatShortcuts.shortcuts.newLine !== "Shift+Enter" && chatShortcuts.matchesShortcut(event, chatShortcuts.shortcuts.newLine)) {
      event.preventDefault();
      if (!document.execCommand("insertText", false, "\n")) {
        prompt.setRangeText("\n", prompt.selectionStart, prompt.selectionEnd, "end");
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    if (
      chatShortcuts.matchesShortcut(event, chatShortcuts.shortcuts.send) &&
      !event.isComposing &&
      !event.nativeEvent?.isComposing
    ) {
      event.preventDefault();
      if (!event.repeat) submit();
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
    chatAgents.closeAgentsMenu();
    // Let the native picker return to the existing draft and selection.
    prompt.focus({ preventScroll: true });
    document.getElementById("attachment-file-input").click();
  });
  document.getElementById("attachment-file-input").addEventListener("change", async function (event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    await chatAttachments.addBrowserFiles(files);
  });
  modelButton.addEventListener("click", function () {
    openSetting("model");
  });
  submissionButton.addEventListener("click", function () { openSetting("submission"); });
  fastModeButton.addEventListener("click", function () { toggleMode("fastMode"); });
  orchestrateModeButton.addEventListener("click", function () {
    state.orchestrateMode = !state.orchestrateMode;
    updateModeControls();
    persist();
  });
  workIsolationButton.addEventListener("click", function () {
    state.workIsolation = !state.workIsolation;
    updateModeControls();
    vscode.postMessage({ type: "workIsolation.set", value: state.workIsolation });
  });
  prompt.addEventListener("input", function () { inputFeedback.hidden = true; });
  questionButton.addEventListener("click", function () {
    if (questionMenu.hidden) {
      chatNavigation.openQuestionMenu();
    } else {
      chatNavigation.closeQuestionMenu(true);
    }
  });

  function updateJumpToBottom() {
    const hidden = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop <= 24;
    if (jumpToBottom.hidden !== hidden) jumpToBottom.hidden = hidden;
  }

  jumpToBottom.addEventListener("click", function () {
    followLatest = true;
    updateAutoScrollControl();
    timeline.scrollTop = timeline.scrollHeight;
    prompt.focus({ preventScroll: true });
    updateJumpToBottom();
  });
  function pauseFollowingLatest() {
    cancelAnimationFrame(autoScrollFrame);
    followLatest = false;
    updateAutoScrollControl();
  }
  // Upward input pauses before the browser applies it, so a pending render cannot pull the reader down.
  timeline.addEventListener("wheel", function (event) {
    if (event.deltaY < 0 && timeline.scrollTop > 0) pauseFollowingLatest();
  }, { passive: true });
  timeline.addEventListener("keydown", function (event) {
    if (event.target.closest("input, textarea, select, [contenteditable]")) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pauseFollowingLatest();
  });
  timeline.addEventListener("scroll", function () {
    const top = timeline.scrollTop;
    const viewportHeight = timeline.clientHeight;
    const distance = timeline.scrollHeight - viewportHeight - top;
    if (top < timelineScrollTop && distance > 1) {
      // Clamping and anchoring keep the bottom; moving away from it is a reader scrolling up.
      followLatest = false;
    } else if (timelineViewportHeight === viewportHeight) {
      // Layout changes can emit scroll events before ResizeObserver runs.
      // Preserve the previous follow intent until the new viewport is handled.
      followLatest = distance <= 24;
    }
    timelineScrollTop = top;
    updateAutoScrollControl();
    const hidden = distance <= 24;
    if (jumpToBottom.hidden !== hidden) jumpToBottom.hidden = hidden;
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
      if (chatWorkUnits.unitDialog.open || document.getElementById("image-converter").open) return;
      if (!chatNotes.notesPanel.hidden) {
        event.preventDefault();
        chatNotes.setNotesOpen(false);
        return;
      }
      // Let the native picker consume Escape before closing its settings dialog.
      if (CSS.supports("selector(select:open)") && document.querySelector("#model-menu select:open, #status-settings select:open")) return;
      if (!statusSettings.hidden) { event.preventDefault(); chatStatusBar.closeStatusSettings(); return; }
      if (document.getElementById("conversation-reader").open) return;
      const history = document.querySelector(".task-history[open]") || document.getElementById("task-history");
      if (history?.open) {
        event.preventDefault();
        history.open = false;
        history.querySelector("summary").focus();
        return;
      }
      if (!sessionMenu.hidden) {
        event.preventDefault();
        chatNavigation.closeSessionMenu(true);
        return;
      }
      if (!questionMenu.hidden) {
        event.preventDefault();
        chatNavigation.closeQuestionMenu(true);
        return;
      }
      if (openSettingId) {
        event.preventDefault();
        closeSettingMenu(true);
        return;
      }
      if (!agentsMenu.hidden) {
        event.preventDefault();
        chatAgents.closeAgentsMenu();
        return;
      }
      event.preventDefault();
      // A fresh press retries a cancellation that did not stop the run.
      if (!event.repeat) cancelRun(true);
    }
  });

  document.addEventListener("click", function (event) {
    const history = document.getElementById("task-history");
    if (history && !event.target.closest("#task-history")) history.open = false;
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
      chatNavigation.closeSessionMenu(false);
    }
    if (!questionMenu.hidden && !event.target.closest(".question-picker")) {
      chatNavigation.closeQuestionMenu(false);
    }
    if (!agentsMenu.hidden && !event.target.closest(".agents-menu") && !event.target.closest(".work-unit-activity") && !event.target.closest("#unit-create-dialog, #deploy-dialog")) {
      chatAgents.closeAgentsMenu();
    }
  });

  document.addEventListener("paste", function (event) {
    // Other text fields (settings, questions, dialogs) own their native paste.
    if (event.target !== prompt || !event.clipboardData) {
      return;
    }
    // Capture File objects while clipboardData is still readable in the event.
    const images = chatAttachments.clipboardImages(event.clipboardData);
    if (images.length) {
      event.preventDefault();
      chatAttachments.addBrowserImages(images);
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
    if (!chatAttachments.hasAttachmentData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    dropOverlay.hidden = false;
  });
  document.addEventListener("dragover", function (event) {
    if (!chatAttachments.hasAttachmentData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  });
  document.addEventListener("dragleave", function (event) {
    if (!chatAttachments.hasAttachmentData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropOverlay.hidden = true;
    }
  });
  document.addEventListener("drop", function (event) {
    if (!chatAttachments.hasAttachmentData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    if (document.activeElement === document.body || document.activeElement === attachButton) {
      prompt.focus({ preventScroll: true });
    }
    chatAttachments.addDroppedData(event.dataTransfer);
  });

  window.addEventListener("message", function (event) {
    const message = event.data;
    if (!message || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "agent.preset.field.result": {
        const status = document.getElementById("agent-preset-status");
        status.hidden = !message.error;
        status.textContent = message.error || "";
        break;
      }
      case "agent.preset.result": {
        chatAgentSettings.agentPresetBusy = false;
        if (message.error) {
          chatAgentSettings.pendingPresetName = "";
        }
        const status = document.getElementById("agent-preset-status"); status.hidden = !message.error; status.textContent = message.error || "";
        if (!message.error && chatAgentSettings.pendingPresetAction === "save") {
          document.getElementById("agent-preset-create").open = false;
          document.getElementById("agent-preset-name").value = "";
        }
        if (!message.error && chatAgentSettings.pendingPresetAction === "rename") {
          if (state.agentSettingsScope === "global" && state.agentSettingsSet === document.getElementById("agent-preset-select").value) state.agentSettingsSet = message.name;
          document.getElementById("agent-preset-rename").open = false;
          document.getElementById("agent-preset-rename-name").value = "";
          persist();
          saveComposerSettings();
        }
        chatAgentSettings.pendingPresetAction = "";
        if (!message.error && message.settings && message.name) chatAgentSettings.applyAgentSettingsToChat(message.settings, message.scope, message.name);
        chatAgentSettings.renderAgentDefaults();
        chatAgentSettings.renderAgentPresets();
        break;
      }
      case "usage.accounts":
        accountUsage = message.accounts && typeof message.accounts === "object" ? message.accounts : {};
        renderAccountUsage();
        break;
      case "agent.defaults":
        state.agentDefaults = message.settings;
        if (!state.agentSettingsScope) state.agentSettingsScope = "chat";
        if (state.agentSettingsScope === "global" && !message.settings?.presets?.some(preset => preset.name === state.agentSettingsSet)) {
          // A removed or renamed source must not strand a preserved snapshot behind locked controls.
          state.agentSettingsScope = "chat";
          state.agentSettingsSet = "Chat";
          persist(); saveComposerSettings();
        }
        chatAgentSettings.renderAgentDefaults();
        // Existing chat values are an independent snapshot and do not follow later default changes.
        updateModeControls();
        break;
      case "agent.run.selected":
        if (state.role === "main") break;
        state.capturedRun = normalizeCapturedRun(message.capturedRun, state.agentId);
        updateModeControls(); chatStatusBar.renderStatusBar(); persist();
        break;
      case "host.initialize":
        const incomingAgentId = typeof message.agentId === "string" ? message.agentId : undefined;
        const sessionBoundaryChanged = Boolean(
          (state.panelId && message.panelId !== state.panelId) ||
          (state.agentId && incomingAgentId !== state.agentId));
        const incomingConversationId = typeof message.conversationId === "string" ? message.conversationId : undefined;
        const conversationBoundaryChanged = sessionBoundaryChanged || Boolean(incomingConversationId && incomingConversationId !== state.conversationId);
        state.agentSettingsVersion = message.agentSettingsVersion === 1 ? 1 : state.agentSettingsVersion;
        state.panelId = message.panelId;
        state.agentId = incomingAgentId;
        state.title = message.title;
        state.role = ["main", "work", "verification"].includes(message.role) ? message.role : "main";
        state.verifiedWorkRunId = typeof message.verifiedWorkRunId === "string" ? message.verifiedWorkRunId : undefined;
        state.capturedRun = state.role === "main" ? undefined : normalizeCapturedRun(message.capturedRun, state.agentId);
        document.body.dataset.agentRole = state.role;
        state.projectName = message.projectName;
        state.workIsolation = message.workIsolation === true;
        state.docsAuditInterval = ["daily", "weekly"].includes(message.docsAuditInterval) ? message.docsAuditInterval : "off";
        state.runtimeAvailable = message.runtimeAvailable === true;
        if (message.resetConversation === true || conversationBoundaryChanged) resetConversationState();
        state.conversationId = incomingConversationId ?? (sessionBoundaryChanged ? undefined : state.conversationId);
        state.capabilities = message.capabilities;
        if (currentCapabilities().diagnostic) appendNotice("warning", currentCapabilities().diagnostic);
        state.running = message.running === true;
        if (state.chatFeedback === "checking") state.chatFeedback = state.running ? "waiting" : "ready";
        else if (state.running && (message.resetConversation === true || conversationBoundaryChanged || !state.chatFeedback)) state.chatFeedback = "waiting";
        if (!state.running) state.cancellationRequested = false;
        state.model = normalizeModel(message.model);
        state.agentModels = message.agentModels || state.agentModels || {};
        state.agentFastModes = normalizeAgentFastModes(message.agentFastModes || state.agentFastModes, message.modelFastModes);
        state.reasoning = normalizeSettingValue(message.reasoning, settingOptions.reasoning);
        state.agentSettingsScope = ["global", "project", "chat"].includes(message.agentSettingsScope) ? message.agentSettingsScope : state.agentSettingsScope;
        state.agentSettingsSet = typeof message.agentSettingsSet === "string" && message.agentSettingsSet.trim() ? message.agentSettingsSet.trim() : state.agentSettingsSet;
        state.businessMode = "normal";
        state.maestroMode = state.role === "main" && message.maestroMode === true;
        state.taskMode = "direct";
        state.fastMode = message.fastMode === true;
        state.workLoopMode = false;
        if (!conversationBoundaryChanged && message.resetConversation !== true) {
          state.contextUsedTokens = safeCountOrUndefined(message.contextUsedTokens);
          state.contextWindowTokens = safeCountOrUndefined(message.contextWindowTokens);
          state.weeklyUsedPercent = safePercentOrUndefined(message.weeklyUsedPercent);
          state.fiveHourUsedPercent = safePercentOrUndefined(message.fiveHourUsedPercent);
          state.weeklyResetsAt = safeResetsAtOrUndefined(message.weeklyResetsAt);
          state.fiveHourResetsAt = safeResetsAtOrUndefined(message.fiveHourResetsAt);
        }
        state.queueCount = safeCount(message.queueCount);
        if (Array.isArray(message.pendingMessageIds)) {
          for (const item of state.pendingRequests || []) {
            if (message.pendingMessageIds.includes(item.id)) { item.rejected = false; item.hostAcknowledged = true; }
          }
        }
        if (state.running && !state.runStartedAt) {
          state.runStartedAt = Date.now();
        } else if (!state.running) {
          state.runStartedAt = undefined;
        }
        state.botsAvailable = message.botsAvailable !== false;
        state.companionAvailable = message.companionAvailable !== false;
        if (!state.companionAvailable) chatBot.companionSnapshot = undefined;
        factoryBot.classList.toggle("sd-companion", state.companionAvailable);
        chatBot.botMenu.querySelectorAll("[data-companion-action]").forEach(button => { button.hidden = false; });
        state.botsEnabled = state.botsAvailable && message.botsEnabled !== false;
        document.getElementById("settings-tab-bot").style.display = state.botsAvailable ? "" : "none";
        chatShortcuts.renderShortcuts();
        chatBot.receiveBotCharacter(message);
        if (typeof message.botDefaultPrompt === "string") chatBot.botDefaultPrompt = message.botDefaultPrompt;
        chatBot.receiveBotPrompt(message.botPrompt);
        if (typeof message.botModel === "string") chatBot.botModelSaved = message.botModel;
        chatBot.renderBotModels();
        state.statusItems = normalizeStatusItems(message.statusItems);
        updateModeControls();
        vscode.postMessage({ type: "providers.request" });
        if (state.agentId && state.role === "main") vscode.postMessage({ type: "goal.control", action: "get" });
        renderTimeline();
        chatStatusBar.renderStatusBar();
        chatStatusBar.renderStatusCatalog();
        updateRunControls();
        persist();
        break;
      case "syntax.theme":
        void chatSyntax.updateSyntaxTheme(message.selection || {});
        break;
      case "worktree.created":
        chatWorkUnits.receiveUnitCreated(message);
        break;
      case "deploy.targets":
        chatWorkUnits.receiveDeployTargets(message);
        break;
      case "deploy.status":
        chatWorkUnits.receiveDeployStatus(message);
        break;
      case "worktree.repositories":
        chatWorkUnits.receiveUnitRepositories(message);
        break;
      case "composer.prefill":
        prompt.value = message.text;
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
        break;
      case "worktree.updated":
        chatWorkUnits.receiveWorktree(message);
        chatStatusBar.renderStatusBar();
        break;
      case "branch.updated":
        state.branch = typeof message.branch === "string" ? message.branch : undefined;
        chatStatusBar.renderStatusBar();
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
        // The conversation's provider decides which model routes remain selectable.
        if (openSettingId === "model") renderSettingMenu("model", modelMenu);
        break;
      case "workIsolation.updated":
        state.workIsolation = message.value === true;
        updateModeControls();
        break;
      case "docsAudit.updated":
        state.docsAuditInterval = ["daily", "weekly"].includes(message.interval) ? message.interval : "off";
        break;
      case "docsAudit.due":
        state.docsAuditPending = state.role === "main" && state.docsAuditInterval !== "off";
        startDocsAudit();
        break;
      case "providers.status":
        chatProviders.receiveProviders(message);
        break;
      case "providers.catalog":
        chatProviders.providerCatalog = message.catalog;
        chatProviders.providerVersionsRequested = false;
        chatProviders.renderProviderSettings();
        break;
      case "runtime.updated":
        state.runtimeAvailable = message.runtimeAvailable === true;
        if (message.capabilities) state.capabilities = message.capabilities;
        updateModeControls();
        updateSendButton();
        chatStatusBar.renderStatusBar();
        break;
      case "models.list":
        if (Array.isArray(message.models)) {
          chatBot.botModelOptions = message.models.filter(model => /^(gpt-|codex-|claude-)[A-Za-z0-9._-]+$/.test(model));
          chatBot.renderBotModels();
          settingOptions.model = ["", ...new Set(message.models.map(normalizeModel).filter(Boolean))];
          if (openSettingId === "model") {
            const focused = modelMenu.contains(document.activeElement) ? { role: document.activeElement.dataset.role, field: document.activeElement.dataset.field } : undefined;
            renderSettingMenu("model", modelMenu);
            if (focused?.role && focused?.field) modelMenu.querySelector('[data-role="' + focused.role + '"][data-field="' + focused.field + '"]')?.focus();
          }
        }
        break;
      case "attachment.conversionResult":
        chatImageConverter.showConversionResult(message);
        break;
      case "attachment.encode":
        void chatAttachments.encodeAttachmentImage(message);
        break;
      case "attachments.add":
        if (Array.isArray(message.attachments)) {
          chatAttachments.addAttachments(message.attachments);
        }
        break;
      case "attachments.restored":
        if (Array.isArray(message.attachments)) {
          const composer = message.attachments.filter(function (item) { return item.target === "composer"; });
          if (composer.length) chatAttachments.addAttachments(composer.map(function ({ target, ...item }) { return item; }));
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
        chatAttachments.finishImageUpload(message.id);
        const rejected = state.attachments.find(function (item) { return item.id === message.id; });
        if (rejected?.previewUri?.startsWith("blob:")) URL.revokeObjectURL(rejected.previewUri);
        state.attachments = state.attachments.filter(function (item) { return item.id !== message.id; });
        chatAttachments.renderAttachments();
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
      case "sudo.challenge":
        chatSudo.openSudoPanel(message);
        break;
      case "sudo.closed":
        chatSudo.closeSudoPanel();
        break;
      case "host.notice":
        if (message.level === "error") {
          state.cancellationRequested = false;
          renderRunStatus();
          chatStatusBar.renderStatusBar();
          chatBot.botOutcome = "failed"; chatBot.renderFactoryBot();
        }
        appendNotice(message.level, message.text, message.localization?.text);
        break;
      case "status.updated":
        if (Array.isArray(message.items)) {
          state.statusItems = normalizeStatusItems(message.items);
          chatStatusBar.renderStatusBar();
          chatStatusBar.renderStatusCatalog();
          persist();
        }
        break;
      case "chat.renamed":
        if (typeof message.title === "string" && message.title) {
          state.title = message.title;
          document.title = message.title;
          chatStatusBar.renderStatusBar();
          persist();
        }
        break;
      case "session.bound":
        if (typeof message.agentId === "string" && message.agentId) {
          state.agentId = message.agentId;
          if (message.reset === true) {
            state.chatFeedback = "checking";
            state.runExecutionStatus = undefined;
            state.runProgress = "";
            state.runProgressLocalization = undefined;
            state.runStartedAt = undefined;
            state.historyFeedback = undefined;
            state.historyPageOperation = undefined;
            state.historyPageError = undefined;
            state.conversationId = message.conversationId;
            state.contextUsedTokens = undefined;
            state.contextWindowTokens = undefined;
            state.weeklyUsedPercent = undefined;
            state.fiveHourUsedPercent = undefined;
            state.weeklyResetsAt = undefined;
            state.fiveHourResetsAt = undefined;
            state.workUnitsKnown = false;
            nativeGoal = null;
            goalError = undefined;
            state.pendingDecisionRunId = undefined;
            state.decisionSubmitting = false;
            state.historyNextBefore = undefined;
            timelineEndId = undefined;
            messageViewStates.clear();
            state.guidanceExpanded = [];
            state.timeline = [];
            state.taskFlows = [];
            followLatest = true;
            renderTimeline();
          }
          updateModeControls();
          chatNavigation.closeSessionMenu(false);
          renderRunStatus();
          persist();
        }
        break;
      case "conversation.clearing":
        setConversationClearing(message.busy === true);
        break;
      case "conversation.cleared":
        if (typeof message.conversationId === "string" && message.conversationId) {
          const pendingRequests = state.pendingRequests;
          resetConversationState();
          state.pendingRequests = pendingRequests;
          state.conversationId = message.conversationId;
          // A reset conversation has no provider binding yet; release it before the capability refresh arrives.
          if (state.capabilities?.send?.sessionProvider) {
            const { sessionProvider, ...send } = state.capabilities.send;
            state.capabilities = { ...state.capabilities, send };
          }
          renderAll();
          persist();
        }
        break;
      case "notes.list.result":
      case "notes.save.result":
        chatNotes.receiveNotes(message);
        break;
      case "contracts.list":
        contractListMessage = message;
        renderContractList();
        break;
      case "composer.reference":
        prompt.value = [prompt.value, message.text].filter(Boolean).join("\n\n");
        state.draft = prompt.value;
        resizePrompt(); updateSendButton(); persist(false); prompt.focus();
        break;
      case "project.tasks":
        if (!message.error) state.projectTasks = Array.isArray(message.entries) ? message.entries : [];
        chatTaskFlow.renderProjectHistory();
        if (contractListMessage) renderContractList();
        break;
      case "conversations.list":
        chatHistory.showConversationList(message);
        break;
      case "conversation.read.result":
        chatHistory.showSavedConversation(message);
        break;
      case "conversation.history":
        if (message.agentId === state.agentId && message.history &&
            message.history.conversationId === state.conversationId &&
            Array.isArray(message.history.messages)) {
          const loading = state.historyFeedback?.pending === true && state.historyFeedback.agentId === message.agentId && state.historyFeedback.conversationId === message.history.conversationId;
          const previousLength = state.timeline.length;
          let repaired = 0;
          state.historyNextBefore = message.history.nextBefore;
          const restored = message.history.messages.filter(function (item) {
            return item && ["user", "assistant", "interview"].includes(item.type) &&
              typeof item.id === "string" && typeof item.runId === "string" && typeof item.text === "string";
          });
          if (!state.timeline.some(function (item) { return ["user", "assistant", "interview", "activity"].includes(item.type); })) {
            state.timeline = restored;
          } else {
            const knownRuns = new Set(state.timeline.filter(item => !item.id?.startsWith("history-"))
              .map(item => item.runId).filter(Boolean));
            const knownIds = new Set(state.timeline.map(item => item.id));
            // A cached history user does not prove its answer was cached too.
            // Insert missing history beside its recorded neighbors, preserving
            // the ordering of live entries and already restored messages.
            if (new Set(restored.map(item => item.id)).size === restored.length) {
              // Link existing records once and insert beside recorded anchors.
              // Searching/copying the remaining history per message is quadratic.
              const head = {};
              let tail = head;
              const nodes = new Map();
              for (const item of state.timeline) {
                const node = { item, previous: tail };
                tail.next = node; tail = node;
                if (!nodes.has(item.id)) nodes.set(item.id, node);
              }
              const following = [];
              let next;
              for (let index = restored.length - 1; index >= 0; index--) {
                following[index] = next;
                if (nodes.has(restored[index].id)) next = nodes.get(restored[index].id);
              }
              let preceding;
              for (let index = 0; index < restored.length; index++) {
                const item = restored[index];
                if (knownIds.has(item.id)) { preceding = nodes.get(item.id); continue; }
                if (knownRuns.has(item.runId)) continue;
                const before = following[index];
                const previous = before ? before.previous : preceding || head;
                const node = { item, previous, next: previous.next };
                if (node.next) node.next.previous = node;
                previous.next = node;
                nodes.set(item.id, node); knownIds.add(item.id); preceding = node;
              }
              const merged = [];
              for (let node = head.next; node; node = node.next) merged.push(node.item);
              state.timeline = merged;
            } else {
              // Preserve the legacy ordering contract for duplicate record IDs.
              for (let index = 0; index < restored.length; index += 1) {
                const item = restored[index];
                if (knownIds.has(item.id) || knownRuns.has(item.runId)) continue;
                const following = restored.slice(index + 1).find(next => knownIds.has(next.id));
                const preceding = restored.slice(0, index).reverse().find(previous => knownIds.has(previous.id));
                const position = following ? state.timeline.findIndex(entry => entry.id === following.id)
                  : preceding ? state.timeline.findIndex(entry => entry.id === preceding.id) + 1 : 0;
                state.timeline.splice(position, 0, item);
                knownIds.add(item.id);
              }
            }
            // Repair raw or partially separated history only when the exact
            // captured request matches. Live messages remain untouched.
            const byId = new Map(restored.map(function (item) { return [item.id, item]; }));
            state.timeline = state.timeline.map(function (item) {
              const replacement = byId.get(item.id);
              if (item.type === "user" && item.id?.startsWith("history-user-") &&
                replacement?.submission && item.text !== replacement.text &&
                item.text + (item.submission?.guidance || "") ===
                  (replacement.capturedRequest || replacement.text + (replacement.submission.guidance || ""))) {
                repaired++;
                return replacement;
              }
              return item;
            });
          }
          if (loading) {
            const count = Math.max(0, state.timeline.length - previousLength) + repaired;
            state.historyFeedback = { phase: count ? "received" : "unchanged", count };
          }
          if (state.historyBrowsing && restored.length) {
            timelineEndId = restored[restored.length - 1].id;
            followLatest = false;
          }
          state.historyBrowsing = false;
          scheduleTimelineRender();
          updateModeControls();
          persist(false);
        }
        break;
      case "sessions.open":
        chatNavigation.openSessionMenu();
        break;
      case "sessions.list":
        state.sessionsLoading = false;
        state.sessions = Array.isArray(message.sessions) ? message.sessions.filter(function (session) {
          return session && typeof session.agentId === "string" && session.agentId;
        }) : [];
        chatNavigation.renderSessionList();
        break;
      case "task.stop.result":
        chatTaskFlow.finishTaskStop(message);
        break;
      case "task.delete.result":
        chatTaskFlow.finishTaskDelete(message);
        scheduleTimelineRender();
        break;
      case "agents.list":
        state.workUnitsKnown = Array.isArray(message.agents);
        state.agentsLoading = false;
        if (Array.isArray(message.workflows)) {
          // A temporarily incomplete session discovery must not erase accepted history.
          const key = snapshot => snapshot.loopId || snapshot.workflow?.id;
          const snapshots = new Map((message.workflowsComplete ? [] : state.workflows || []).map(snapshot => [key(snapshot), snapshot]));
          for (const snapshot of message.workflows) {
            snapshots.set(key(snapshot), snapshot);
            // The decision took effect once the loop left its stop; a refresh of the same stop changes nothing.
            if (snapshot.status !== "needs-human-decision") chatTaskFlow.workflowDecisionsPending.delete(snapshot.loopId);
          }
          state.workflows = [...snapshots.values()].slice(-100);
          if (message.workflowsComplete) state.taskFlows = (state.taskFlows || []).filter(flow => !flow.engine);
        }
        state.childAgents = Array.isArray(message.agents) ? message.agents.filter(chatAgents.isChildAgent) : [];
        state.workUnits = chatAgents.summarizeChildAgents(state.childAgents);
        chatAgents.renderAgentsList();
        renderRunStatus();
        chatTaskFlow.renderWorkLoopPanel();
        scheduleTimelineRender();
        chatStatusBar.renderStatusBar();
        persist(false);
        break;
      case "decision.pending":
        state.pendingDecisionCanApprove = Boolean(message.runId) && message.canApprove === true;
        state.pendingDecisionApproval = message.runId ? decisionApproval(message.approval) : undefined;
        state.pendingDecisionRunId = typeof message.runId === "string" ? message.runId : undefined;
        if (state.pendingDecisionRunId) state.chatFeedback = "decision";
        else if (state.chatFeedback === "decision") state.chatFeedback = state.running ? "awaiting" : "ready";
        state.decisionSubmitting = false;
        renderRunStatus();
        chatPendingQueue.renderPendingQueue();
        scheduleTimelineRender();
        chatStatusBar.renderStatusBar();
        updateConversationClearControl();
        break;
      case "chat.human-decision":
        if (typeof message.text === "string" && message.text) {
          state.timeline.push({ type: "user", id: createId(), text: message.text, submission: message.submission });
          scheduleTimelineRender();
          persist(false);
        }
        break;
      case "interview.question":
        if (message.question && typeof message.question.id === "string" && typeof message.question.text === "string"
            && Number.isSafeInteger(message.question.current) && Number.isSafeInteger(message.question.total)
            && Array.isArray(message.question.options) && message.question.options.length >= 2 && message.question.options.length <= 3) {
          const identity = "interview-" + (message.runId || "runtime") + "-" + message.question.id;
          const existing = state.timeline.find(entry => entry.type === "interview" && entry.id === identity);
          const entry = { type: "interview", id: identity, runId: message.runId, text: message.question.text, question: message.question };
          if (existing) Object.assign(existing, entry);
          else state.timeline.push(entry);
          scheduleTimelineRender();
          persist(false);
        }
        break;
      case "execution.updated":
        state.executionMode = message.mode;
        updateExecutionControl();
        chatStatusBar.renderStatusBar();
        break;
      case "chat.assistant":
        if (typeof message.text === "string" && message.text) {
          if (message.runId && state.timeline.some(function (entry) {
            return entry.type === "assistant" && !entry.streaming && entry.runId === message.runId && entry.text === message.text &&
              entry.phase === (message.phase === "commentary" ? "commentary" : "final");
          })) break;
          if (isDuplicateCancellation(state.timeline.at(-1), { ...message, type: "assistant" })) break;
          const incomingFlows = chatTaskFlow.extractTaskFlows(message.text).flows;
          if (incomingFlows.length) {
            const snapshots = new Map(chatTaskFlow.currentTaskFlows().map(flow => [flow.id, flow]));
            for (const flow of incomingFlows) snapshots.set(flow.id, flow);
            state.taskFlows = [...snapshots.values()].slice(-100);
          }
          const complete = { type: "assistant", id: createId(), text: message.text, localization: message.localization?.text, runId: message.runId, phase: message.phase === "commentary" ? "commentary" : "final" };
          if (state.running && !["completed", "failed", "cancelled"].includes(state.runExecutionStatus)) state.chatFeedback = complete.phase === "final" ? "response" : "streaming";
          const preview = liveAssistantPreview(complete);
          if (preview >= 0) state.timeline.splice(preview, 1, complete);
          else state.timeline.push(complete);
          if (complete.phase === "final") dropLivePreviews(complete.runId);
          scheduleTimelineRender();
          renderRunStatus();
          chatTaskFlow.renderWorkLoopPanel();
          persist(false);
        }
        break;
      case "chat.delta":
        if (typeof message.runId === "string" && typeof message.id === "string" && typeof message.text === "string" && message.text &&
            (message.stream === "commentary" || message.stream === "final")) {
          if (state.running && !["completed", "failed", "cancelled"].includes(state.runExecutionStatus) && state.chatFeedback !== "streaming") {
            state.chatFeedback = "streaming";
            renderRunStatus();
          }
          const key = message.runId + "\u0000" + message.stream + "\u0000" + message.id;
          const index = indexedTimeline();
          const candidate = index.streams.get(key);
          const entry = candidate && state.timeline[candidate.position] === candidate.event && candidate.event.streaming ? candidate.event : undefined;
          if (candidate && !entry) index.streams.delete(key);
          if (entry) {
            entry.text += message.text;
            schedulePreviewRender(entry);
          } else {
            state.timeline.push({ type: "assistant", id: createId(), text: message.text, runId: message.runId, phase: message.stream, streaming: true, streamKey: key });
            scheduleTimelineRender();
          }
        }
        break;
      case "bots.updated":
        state.botsEnabled = message.enabled === true;
        chatBot.receiveBotCharacter(message);
        if (typeof message.botDefaultPrompt === "string") chatBot.botDefaultPrompt = message.botDefaultPrompt;
        chatBot.receiveBotPrompt(message.botPrompt);
        if (typeof message.botModel === "string") chatBot.botModelSaved = message.botModel;
        chatBot.renderBotModels();
        chatBot.renderFactoryBot();
        break;
      case "bot.reply.partial":
        if (state.botsEnabled && chatBot.botTalkPending && message.requestId === chatBot.botTalkPending.requestId && typeof message.text === "string") {
          chatBot.botSpeechText.textContent = message.text;
          chatBot.renderBotTalk();
        }
        break;
      case "bot.reply": {
        if (!state.botsEnabled || !chatBot.botTalkPending || message.requestId !== chatBot.botTalkPending.requestId) break;
        const pending = chatBot.botTalkPending;
        chatBot.botTalkPending = undefined;
        const success = message.failed !== true && typeof message.text === "string" && message.text.trim().length > 0;
        if (!success && pending.fromComposer && prompt.value === "" && chatBot.botDraftRevision === pending.revision) {
          prompt.value = pending.text;
          prompt.dispatchEvent(new Event("input", { bubbles: true }));
          persist();
        }
        chatBot.botReplyEmotion = success && ["calm", "happy", "shy", "love", "surprised", "playful", "sleepy"].includes(message.emotion) ? message.emotion : undefined;
        const replyMoods = { calm: "calm", happy: "cheerful", shy: "curious", love: "cheerful", surprised: "curious", playful: "cheerful", sleepy: "calm" };
        if (chatBot.botReplyEmotion) factoryBot.dataset.mood = replyMoods[chatBot.botReplyEmotion];
        chatBot.showBotSpeech(success ? message.text : t("bot.talk.failed"));
        chatBot.renderFactoryBot();
        break;
      }
      case "bot.model.saved":
        chatBot.botModelSelect.disabled = false;
        chatBot.botModelSaved = message.model;
        chatBot.renderBotModels();
        chatBot.botModelStatus.textContent = t(message.failed ? "bot.model.failed" : "bot.prompt.saved");
        break;
      case "bot.prompt.saved": {
        if (!chatBot.botPromptPending || message.requestId !== chatBot.botPromptPending.requestId) break;
        const submitted = chatBot.botPromptPending;
        chatBot.botPromptPending = undefined;
        if (submitted.character !== chatBot.botCharacter) {
          if (!message.failed) chatBot.botPromptDrafts.set(submitted.character, { draft: submitted.prompt, saved: submitted.prompt });
          chatBot.updateBotPromptControls();
          break;
        }
        if (!message.failed && typeof message.prompt === "string") {
          chatBot.botPromptSaved = message.prompt;
          if (chatBot.botPromptEditor.value === submitted.prompt) chatBot.botPromptEditor.value = message.prompt;
          chatBot.botPromptStatus.textContent = t("bot.prompt.saved");
        } else chatBot.botPromptStatus.textContent = t("bot.prompt.failed");
        chatBot.updateBotPromptControls();
        break;
      }
      case "bot.companion":
        if (!state.companionAvailable) break;
        chatBot.companionSnapshot = message.companion;
        chatBot.companionWorking = message.working;
        chatBot.companionOutcome = message.outcome;
        chatBot.companionOutcomeUntil = message.outcomeUntil || 0;
        state.botCare = { ...chatBot.companionSnapshot };
        chatBot.botIdleSince = chatBot.companionSnapshot.lastInteractionAt;
        chatBot.renderFactoryBot();
        break;
      case "bot.mood":
        if (!state.botsEnabled || (chatBot.botSpeechVisible && chatBot.botReplyEmotion)) break;
        factoryBot.dataset.mood = ["calm", "curious", "cheerful", "focused"].includes(message.mood) ? message.mood : "";
        factoryBot.dataset.brain = factoryBot.dataset.mood ? "luna" : message.unavailable === true ? "unavailable" : "local";
        chatBot.renderFactoryBot();
        break;
      case "run.observed":
        state.runExecutionStatus = message.status;
        if (message.status === "running" && ["checking", "decision", "ready", "ended", "completed", "failed", "cancelled"].includes(state.chatFeedback)) state.chatFeedback = "waiting";
        if (["completed", "failed", "cancelled", "needs-human-decision"].includes(message.status)) {
          state.chatFeedback = message.status === "needs-human-decision" ? "decision" : message.status;
        }
        renderRunStatus();
        chatBot.botOutcome = message.status;
        chatBot.renderFactoryBot();
        break;
      case "run.state":
        const wasRunning = state.running;
        const wasChecking = state.chatFeedback === "checking";
        if (message.running === true && wasChecking) state.chatFeedback = "waiting";
        if (message.running !== true && state.docsAuditPending) setTimeout(startDocsAudit, 0);
        if (message.running === true && !state.running) {
          state.chatFeedback = wasChecking ? "waiting" : "awaiting";
          chatBot.botOutcome = undefined;
          state.runExecutionStatus = undefined;
          clearTimeout(chatBot.botWaveTimer);
          chatBot.botWaveTimer = undefined;
        }
        state.running = message.running === true;
        if (!state.running && wasChecking) state.chatFeedback = "ready";
        else if (!state.running && wasRunning) {
          state.chatFeedback = ["completed", "failed", "cancelled", "decision"].includes(state.chatFeedback) ? state.chatFeedback : "ended";
        }
        if (!state.running) state.cancellationRequested = false;
        state.runProgress = state.running ? (state.runProgress || t("ui.starting.main.agent")) : "";
        state.runProgressLocalization = globalThis.AgentFactoryI18n.describe(state.runProgress) || state.runProgressLocalization;
        if (state.running && !state.runStartedAt) {
          state.runStartedAt = Date.now();
        } else if (!state.running) {
          state.runStartedAt = undefined;
          dropLivePreviews();
        }
        updateRunControls();
        scheduleTimelineRender();
        chatStatusBar.renderStatusBar();
        persist(false);
        break;
      case "chat.pending": {
        const pending = (state.pendingRequests || []).find(item => item.id === message.id);
        if (pending) { pending.rejected = false; pending.hostAcknowledged = true; }
        chatPendingQueue.renderPendingQueue();
        renderRunStatus();
        persist(false);
        break;
      }
      case "chat.rejected": {
        const pending = (state.pendingRequests || []).find(function (item) { return item.id === message.id; });
        if (pending) pending.rejected = true;
        if (pending) document.getElementById("pending-queue-toggle").setAttribute("aria-expanded", "true");
        chatPendingQueue.renderPendingQueue();
        renderRunStatus();
        persist(false);
        break;
      }
      case "chat.started": {
        const pending = (state.pendingRequests || []).find(function (item) { return item.id === message.id; });
        state.pendingRequests = (state.pendingRequests || []).filter(function (item) { return item.id !== message.id; });
        const revealSubmission = Boolean(pending) && !(state.startedMessageIds || []).includes(message.id) &&
          !state.timeline.some(item => item.type === "user" && item.id === message.id);
        if (revealSubmission) followLatest = true;
        if (pending) state.chatFeedback = "awaiting";
        if (!(state.startedMessageIds || []).includes(message.id) && !state.timeline.some(function (item) { return item.type === "user" && item.id === message.id; })) {
          state.timeline.push({ type: "user", id: message.id,
            text: message.text || message.attachments.map(function (item) { return t("ui.attachments.c53076") + item.name; }).join("\n"),
            submittedAt: pending?.submittedAt,
            submission: message.submission || submissionFromExecution(pending?.execution),
            attachments: pending ? pending.attachments : message.attachments });
          state.pendingDecisionRunId = undefined;
          state.decisionSubmitting = false;
          // Keep accepted background workflows during a new Main conversation turn.
          state.workUnits = chatAgents.summarizeChildAgents([]);
          state.runStartedAt = Date.now();
          state.runProgress = t("ui.main.agent.running");
          state.runProgressLocalization = globalThis.AgentFactoryI18n.describe(state.runProgress);
        }
        const acknowledged = state.timeline.find(function (item) { return item.type === "user" && item.id === message.id; });
        if (acknowledged && message.submission) acknowledged.submission = message.submission;
        state.startedMessageIds = [...new Set([...(state.startedMessageIds || []), message.id])].slice(-400);
        renderAll();
        if (openSettingId === "model") chatAgentSettings.renderModelSettings(modelMenu, true);
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
        chatPendingQueue.renderPendingQueue();
        state.queueCount = safeCount(message.count);
        chatWorkUnits.renderWorktree();
        updateConversationClearControl();
        chatStatusBar.renderStatusBar();
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
        state.fiveHourUsedPercent = safePercentOrUndefined(message.fiveHourUsedPercent);
        state.weeklyResetsAt = safeResetsAtOrUndefined(message.weeklyResetsAt);
        state.fiveHourResetsAt = safeResetsAtOrUndefined(message.fiveHourResetsAt);
        chatStatusBar.renderStatusBar();
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
          upsertActivity(message.id, message.category, message.phase, message.text, message.diff, message.title, message.output, activityDetails(message));
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
        chatStatusBar.renderStatusBar();
        chatTaskFlow.renderWorkLoopPanel();
        persist(false);
        break;
    }
  });

  function submit(action = "direct", workflow = "normal", asGoal = false, choiceAnswer = null) {
    if (conversationClearing || (chatWorkUnits.conversationWorktree?.worktree?.workUnit && chatWorkUnits.conversationWorktree.worktree.phase === "merged")) return;
    if (!Object.hasOwn(taskModeNames(), action)) action = "direct";
    if (action === "direct") action = enterAction();
    const contextualRequest = workflow === "contract" ? t("submission.contract.request")
      : workflow === "planning" ? t("submission.planning.request")
      : workflow === "interview" ? t("submission.interview.request")
      : workflow === "migration" ? t("submission.migration.request")
      : workflow === "lessons" ? t("submission.lessons.request")
      : workflow === "pipeline" ? t("submission.pipeline.request")
      : action === "work" ? t("submission.work.request")
      : action === "work-verification" ? t("submission.work.verification.request") : "";
    const userText = choiceAnswer ?? (prompt.value.trim() || contextualRequest);
    if (!userText && state.attachments.length === 0) {
      inputFeedback.textContent = t("ui.enter.what.you.want.help.with.include.the.target.and.desired.result.for.example.fix.the.login.error.in.this.file");
      inputFeedback.hidden = false;
      prompt.focus();
      return;
    }
    inputFeedback.hidden = true;
    let text = userText;
    const goal = state.role === "main" && action !== "verification" && currentCapabilities().goal === true && asGoal === true;
    if (goal && (!text)) {
      inputFeedback.textContent = t("ui.describe.the.goal.you.want.to.achieve.for.example.make.the.attached.page.usable.on.mobile");
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
    const recovered = choiceAnswer === null && action === enterAction() && workflow === "normal" && !asGoal ? state.recoveredRequest : undefined;
    if (!recovered && workflow === "normal" && state.role === "main" && state.maestroMode) workflow = "maestro";
    const message = {
      id: recovered?.id || createId(),
      text,
      attachments: (choiceAnswer === null ? state.attachments : []).map(function (attachment) {
        const { previewUri, pending, ...reference } = attachment;
        return reference;
      }),
      execution: recovered?.execution || {
        ...(state.role === "main" ? { taskMode: action, businessMode: workflow } : {}),
        agentModels: state.role === "main" ? chatAgentSettings.effectiveDelegatedModels() : undefined,
        agentPermissions: state.role === "main" ? Object.fromEntries(["main", "work", "verification"].map(role => [role, state.executionMode || "cli-default"])) : undefined,
        ...(state.role === "main" ? { workIsolation: workIsolationActive() } : {}),
        // Preserve an explicit selection so the host can reject an unavailable
        // provider instead of silently falling back to another model.
        model: chatAgentSettings.effectiveAgentValue("main", "model") || undefined,
        reasoningEffort: currentCapabilities().reasoning ? chatAgentSettings.effectiveAgentValue("main", "reasoningEffort") || undefined : undefined,
        fast: currentCapabilities().fast === true && state.fastMode,
        goal,
        ...(goal ? { goalObjective: text } : {})
      }
    };
    const submittedAttachments = (choiceAnswer === null ? state.attachments : []).map(function (attachment) {
      const { pending, ...submitted } = attachment;
      return submitted;
    });
    (state.pendingRequests ??= []).push({ ...message, submittedAt: new Date().toISOString(), attachments: submittedAttachments });
    if (!state.running) state.chatFeedback = undefined;
    if (choiceAnswer === null) state.recoveredRequest = undefined;
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

  // A due periodic documents check waits until this Main chat is idle, then goes to the read-only Explorer.
  // The pending flag is not persisted: the host offers a due check again after a reload.
  function startDocsAudit() {
    if (!state.docsAuditPending || state.running || !state.runtimeAvailable || !state.capabilities || !orchestrateAvailable()) return;
    state.docsAuditPending = false;
    if (submit("orchestrate", "normal", false, t("docs.audit.request")) === true) vscode.postMessage({ type: "docsAudit.started" });
  }

  function workIsolationActive() {
    return state.workIsolation && currentCapabilities().workIsolation === true;
  }

  function orchestrateAvailable() {
    return state.role === "main" && currentCapabilities().taskModes?.includes("orchestrate") === true;
  }

  // The route ordinary Enter/send uses; menu actions choose their own route.
  function enterAction() {
    return state.orchestrateMode && orchestrateAvailable() ? "orchestrate" : "direct";
  }

  function cancelRun(retry = false) {
    if (!state.running || (state.cancellationRequested && !retry)) {
      return;
    }
    state.cancellationRequested = true;
    vscode.postMessage({ type: "run.cancel" });
    renderRunStatus();
    chatStatusBar.renderStatusBar();
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
    if (level === "error") chatTaskFlow.releaseWorkflowDecisions();
    state.timeline.push({ type: "notice", id: createId(), level, text, localization });
    renderTimeline();
    persist();
  }

  function indexedTimeline() {
    let index = timelineIndexes.get(state.timeline);
    if (!index || index.length > state.timeline.length) {
      index = { id: ++nextTimelineIndex, length: 0, activities: new Map(), positions: new Map(), streams: new Map(), questions: [], latestTurn: undefined, flows: new Map(), flowRevision: 0 };
      timelineIndexes.set(state.timeline, index);
    }
    // Existing entries keep their type/turn identity; ingestion replaces the array
    // for history merges and resets. Append-only updates visit only the new tail.
    for (; index.length < state.timeline.length; index.length++) {
      const event = state.timeline[index.length];
      const type = event.type;
      if (!index.positions.has(event.id)) index.positions.set(event.id, index.length);
      if (event.streaming && event.streamKey) index.streams.set(event.streamKey, { event, position: index.length });
      if (type === "user" && event.submission?.backgroundContinuation === true && event.text === "") continue;
      if (type === "assistant") {
        const text = event.text || "";
        let parsed = chatTaskFlow.taskFlowParseCache.get(event);
        if (!parsed || parsed.text !== text) {
          parsed = { text, flows: chatTaskFlow.extractTaskFlows(text).flows };
          chatTaskFlow.taskFlowParseCache.set(event, parsed);
        }
        for (const flow of parsed.flows) {
          index.flows.set(flow.id, flow);
          index.flowRevision++;
        }
      }
      if (type === "activity" && !index.activities.has(event.id)) index.activities.set(event.id, event);
      if (type === "user") index.questions.push(event);
      if (type === "user" || (type === "assistant" && event.phase !== "commentary")) index.latestTurn = event;
    }
    return index;
  }

  // A complete message supersedes the latest matching preview. Goal turns share
  // a run: never move a later result into an older turn's final position.
  function liveAssistantPreview(complete) {
    const normalize = function (text) { return String(text || "").replace(/\s+/g, " ").trim(); };
    const full = normalize(complete.text);
    if (!complete.runId) return -1;
    for (let index = state.timeline.length - 1; index >= 0; index--) {
      const entry = state.timeline[index];
      if (!entry.streaming || entry.runId !== complete.runId || entry.phase !== complete.phase) continue;
      const partial = normalize(entry.text);
      if (partial && full.startsWith(partial)) {
        timelineIndexes.get(state.timeline)?.streams.delete(entry.streamKey);
        return index;
      }
      if (complete.phase === "final") return -1;
    }
    return -1;
  }

  // Growing previews re-render only their own content once per frame instead of the whole timeline.
  function schedulePreviewRender(entry) {
    // Visibility restoration renders current timeline text; hidden previews do
    // not need a second queue retaining superseded message objects.
    if (document.hidden) return;
    pendingPreviews.add(entry);
    if (previewFrame !== undefined || document.hidden) return;
    previewFrame = requestAnimationFrame(function () {
      previewFrame = undefined;
      let rendered = false;
      for (const item of pendingPreviews) {
        const element = messageElements.get(item.id);
        const key = element && messageRenderKeys.get(element);
        const content = element && element.querySelector(":scope > .message-content");
        if (!content || !key || state.timeline[indexedTimeline().positions.get(item.id)] !== item) {
          scheduleTimelineRender();
          continue;
        }
        renderPreviewMarkdown(content, item.text, item);
        key[0] = eventVersion(item);
        rendered = true;
      }
      pendingPreviews.clear();
      if (rendered && state.autoScroll && followLatest) timeline.scrollTop = timeline.scrollHeight;
    });
  }

  // Parse the whole document in every path: later reference definitions and
  // list/fence continuations can change blocks that appeared complete earlier.
  function renderAssistantContent(content, event) {
    const taskContent = chatTaskFlow.extractTaskFlows(assistantDisplayText(localizedText(event.text, event.localization)));
    const environment = {};
    const extracted = event.phase !== "commentary" && globalThis.agentFactoryExecutionReferences
      ? globalThis.agentFactoryExecutionReferences.extract(taskContent.text, chatMarkdown.markdown, environment)
      : { text: taskContent.text, references: [] };
    if (extracted.references.length) {
      chatMarkdown.renderAssistantMarkdown(content, extracted.before, environment);
      chatMarkdown.renderExecutionReferences(content, extracted.references);
      chatMarkdown.appendAssistantMarkdown(content, extracted.after, environment);
    } else {
      chatMarkdown.renderAssistantMarkdown(content, extracted.text);
    }
    for (const flow of taskContent.flows) content.append(chatTaskFlow.createTaskFlow(flow));
    chatInterview.renderInterviewChoices(content, event);
    if (!event.streaming && event.runId && event.runId === state.pendingDecisionRunId && event.phase !== "commentary") {
      chatActivities.renderDecisionActions(content, event.runId);
    }
  }

  function renderPreviewMarkdown(container, text, entry) {
    renderAssistantContent(container, entry || { text, streaming: true });
  }

  function dropLivePreviews(runId) {
    const before = state.timeline.length;
    state.timeline = state.timeline.filter(function (entry) { return !entry.streaming || (runId !== undefined && entry.runId !== runId); });
    if (state.timeline.length !== before) scheduleTimelineRender();
  }

  // Optional row fields from the host; anything malformed is dropped, never guessed.
  function activityDetails(message) {
    const details = {};
    if (["read", "search", "list", "run", "test", "git", "edit", "web", "page", "tool", "think", "skill"].includes(message.kind)) details.kind = message.kind;
    for (const [key, limit] of [["target", 500], ["scope", 500], ["error", 2000], ["summary", 16384]]) {
      if (typeof message[key] === "string" && message[key] && message[key].length <= limit) details[key] = message[key];
    }
    for (const key of ["lineStart", "lineEnd", "durationMs"]) {
      if (Number.isSafeInteger(message[key]) && message[key] >= 0) details[key] = message[key];
    }
    if (Number.isSafeInteger(message.exitCode) && message.exitCode !== 0) details.exitCode = message.exitCode;
    return details;
  }

  function upsertActivity(id, category, phase, text, diff, title, output, details = {}) {
    let existing = indexedTimeline().activities.get(id);
    if (!existing) {
      const previous = state.timeline[state.timeline.length - 1];
      const incoming = { type: "activity", category, title };
      if (sameReadActivity(previous, incoming)) {
        existing = previous;
      }
    }
    const now = Date.now();
    if (existing) {
      existing.category = category;
      existing.phase = phase;
      existing.text = text;
      existing.diff = diff;
      existing.title = title;
      existing.output = output;
      for (const key of ["kind", "target", "scope", "error", "summary", "lineStart", "lineEnd", "durationMs", "exitCode"]) {
        if (Object.hasOwn(details, key)) existing[key] = details[key];
        else if (phase !== "started") delete existing[key];
      }
      // Receipt times give providers without durations an approximate elapsed time.
      if (phase !== "started" && existing.completedAt === undefined) existing.completedAt = now;
    } else {
      state.timeline.push({ type: "activity", id, category, phase, text, diff, title, output, ...details,
        ...(phase === "started" ? { startedAt: now } : { completedAt: now }) });
    }
    scheduleTimelineRender();
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
        chatTerminal.readActivityDisplayTitle(left.title, "completed") === chatTerminal.readActivityDisplayTitle(right.title, "completed"));
  }

  function isReadActivityTitle(title) {
    return title.startsWith("Read Skill · ") ||
      title === "Read run result" ||
      title.startsWith("Skill 읽기 · ") || title === "실행 결과 읽기";
  }

  function renderAll() {
    updateAutoScrollControl();
    chatPendingQueue.renderPendingQueue();
    renderTimeline();
    chatAttachments.renderAttachments();
    chatStatusBar.renderStatusBar();
    renderRunStatus();
    chatTaskFlow.renderWorkLoopPanel();
    updateSendButton();
    updateRunControls();
    updateModeControls();
    chatNavigation.updateQuestionControl();
  }

  // Event fields are replaced at ingestion, including attachments and submission.
  // Keep shallow snapshots so large text/output strings are never serialized to compare them.
  function eventVersion(event) {
    const cached = eventVersions.get(event);
    const keys = Object.keys(event);
    if (cached && keys.length === Object.keys(cached.snapshot).length &&
        keys.every(key => event[key] === cached.snapshot[key])) return cached.version;
    const version = ++nextEventVersion;
    eventVersions.set(event, { snapshot: { ...event }, version });
    return version;
  }

  function managedActivities(events = state.timeline) {
    const groups = new Map(), byEvent = new Map();
    const roles = JSON.stringify(state.childAgents.map(agent => [agent.agentId, agent.role]));
    for (const event of events) {
      if (event.type !== "activity" || event.category !== "command") continue;
      let cached = managedCommandCache.get(event);
      if (!cached || cached.text !== event.text || cached.output !== event.output || cached.roles !== roles) {
        cached = { text: event.text, output: event.output, roles,
          managed: globalThis.agentFactoryExecutionReferences?.managedCommand(event.text, event.output, state.childAgents) };
        managedCommandCache.set(event, cached);
      }
      const managed = cached.managed;
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
    const workflows = { contract: t("ui.contract"), interview: t("ui.interview"), planning: t("ui.planning"), design: t("ui.design"), migration: t("ui.migration"), lessons: t("ui.lessons"), pipeline: t("ui.pipeline") };
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
    // Captured guidance remains in submission records; conversation displays Human text only.
  }

  function scheduleTimelineRender() {
    if (timelineRenderFrame !== undefined || document.hidden) return;
    timelineRenderFrame = requestAnimationFrame(function () {
      timelineRenderFrame = undefined;
      renderTimeline();
    });
  }

  function renderTimeline() {
    cancelAnimationFrame(timelineRenderFrame);
    timelineRenderFrame = undefined;
    if (document.hidden) return;
    cancelAnimationFrame(previewFrame);
    previewFrame = undefined;
    pendingPreviews.clear();
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
    let historyStatus = timeline.querySelector(".history-feedback");
    if (!historyStatus) {
      historyStatus = document.createElement("p");
      historyStatus.className = "history-feedback";
      historyStatus.setAttribute("role", "status");
      historyStatus.setAttribute("aria-live", "polite");
    }
    let older = timeline.querySelector(".history-older");
    if (!older) {
      older = document.createElement("button");
      older.type = "button";
      older.className = "history-older";
      older.addEventListener("click", function () {
        if (state.historyNextBefore && !state.historyFeedback?.pending) {
          state.historyFeedback = { pending: true, agentId: state.agentId, conversationId: state.conversationId };
          older.disabled = true;
          older.setAttribute("aria-busy", "true");
          older.textContent = t("ui.conversation.loading");
          historyStatus.textContent = t("feedback.history.waiting");
          historyStatus.hidden = false;
          state.historyBrowsing = true;
          vscode.postMessage({ type: "history.request", before: state.historyNextBefore });
        }
      });
      timeline.prepend(older);
    }
    if (!historyStatus.isConnected) older.after(historyStatus);
    older.disabled = state.historyFeedback?.pending === true;
    older.setAttribute("aria-busy", String(older.disabled));
    older.textContent = t(older.disabled ? "ui.conversation.loading" : "ui.history.older");
    older.hidden = !state.historyNextBefore;
    historyStatus.hidden = !state.historyFeedback && !state.historyPageOperation && !state.historyPageError;
    const historyLabel = state.historyPageOperation ? t("feedback.history.rendering")
      : state.historyPageError ? t("feedback.history.renderfailed")
      : state.historyFeedback?.pending ? t("feedback.history.waiting")
      : state.historyFeedback?.phase === "page" ? t("feedback.history.page", start + 1, end, state.timeline.length)
      : state.historyFeedback?.phase === "received" ? t("feedback.history.received", state.historyFeedback.count)
      : state.historyFeedback?.phase === "unchanged" ? t("feedback.history.unchanged") : "";
    if (historyStatus.textContent !== historyLabel) historyStatus.textContent = historyLabel;
    if (state.historyPageError) historyStatus.title = state.historyPageError;
    else historyStatus.removeAttribute("title");
    let pages = timeline.querySelector(".history-pages");
    if (!pages) { pages = document.createElement("nav"); pages.className = "history-pages"; timeline.prepend(pages); }
    const pageKey = [start, end, state.timeline.length, uiLocale()].join(":");
    if (pages.dataset.renderKey !== pageKey) {
      pages.dataset.renderKey = pageKey;
      pages.replaceChildren();
      for (const [label, enabled, target] of [["ui.history.previous", start > 0, start], ["ui.history.next", end < state.timeline.length, Math.min(state.timeline.length, end + 200)]]) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = t(label); button.disabled = !enabled;
        button.addEventListener("click", function () {
          if (state.historyPageOperation) return;
          const nextEndId = target === state.timeline.length ? undefined : state.timeline[target - 1]?.id;
          const operation = { agentId: state.agentId, conversationId: state.conversationId };
          state.historyPageOperation = operation;
          state.historyPageError = undefined;
          const previousEndId = timelineEndId;
          const previousButtons = Array.from(pages.children);
          const previousMessages = Array.from(timeline.querySelectorAll(".message"));
          const previousPageKey = pages.dataset.renderKey;
          const previousHistoryFeedback = state.historyFeedback;
          const focused = document.activeElement === button;
          const disabled = Array.from(pages.children, control => control.disabled);
          for (const control of pages.children) control.disabled = true;
          historyStatus.hidden = false;
          historyStatus.textContent = t("feedback.history.rendering");
          followLatest = false;
          // Yield a paint for local display feedback before rebuilding the page.
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              if (state.historyPageOperation !== operation || state.agentId !== operation.agentId || state.conversationId !== operation.conversationId) return;
              state.historyPageOperation = undefined;
              timelineEndId = nextEndId;
              if (!state.historyFeedback?.pending) state.historyFeedback = { phase: "page" };
              try {
                renderTimeline();
                timeline.scrollTop = 0;
              } catch (error) {
                timelineEndId = previousEndId;
                state.historyFeedback = previousHistoryFeedback;
                state.historyPageError = error instanceof Error ? error.message : String(error);
                for (const node of timeline.querySelectorAll(".message")) {
                  if (!previousMessages.includes(node)) node.remove();
                }
                let previousNode = emptyState;
                for (const node of previousMessages) { previousNode.after(node); previousNode = node; }
                pages.replaceChildren(...previousButtons);
                pages.dataset.renderKey = previousPageKey;
                historyStatus.hidden = false;
                historyStatus.textContent = t("feedback.history.renderfailed");
                historyStatus.title = state.historyPageError;
                Array.from(pages.children).forEach((control, index) => { control.disabled = disabled[index]; });
              }
              if (focused && (document.activeElement === button || document.activeElement === document.body)) {
                const controls = Array.from(pages.children);
                const replacement = controls.find(control => control.textContent === button.textContent && !control.disabled) || controls.find(control => !control.disabled);
                replacement?.focus({ preventScroll: true });
              }
            });
          });
        });
        pages.append(button);
      }
      pages.hidden = state.timeline.length <= 200;
      pages.setAttribute("aria-label", t("ui.history.pages"));
    }
    Array.from(pages.children).forEach(function (button, index) {
      const disabled = Boolean(state.historyPageOperation) || (index === 0 ? start === 0 : end >= state.timeline.length);
      if (button.disabled !== disabled) button.disabled = disabled;
    });
    const managedByEvent = managedActivities(visibleEvents);
    const assistantContext = JSON.stringify([state.role, state.childAgents.map(agent => [agent.agentId, agent.role])]);
    const commandContexts = new Map(state.childAgents.map(agent => [agent.agentId, JSON.stringify(agent)]));
    for (const event of visibleEvents) {
      if (event.type === "user" && event.submission?.backgroundContinuation === true && event.text === "") continue;
      const managedGroup = managedByEvent.get(event.id);
      if (managedGroup && managedGroup.events[0] !== event) continue;
      retainedIds.add(event.id);
      const existing = existingMessages.get(event.id);
      const renderKey = [eventVersion(event), chatSyntax.syntaxRevision, uiLocale(),
        event.type === "assistant" ? assistantContext : null,
        event.type === "assistant" || event.type === "interview" ? chatInterview.canAnswerInterview(event) : null,
        event.type === "assistant" && event.runId === state.pendingDecisionRunId && event.runId
          ? JSON.stringify([state.pendingDecisionRunId, state.pendingDecisionCanApprove, state.pendingDecisionApproval, state.decisionSubmitting, state.running, state.runtimeAvailable]) : null,
        managedGroup ? state.role + ":" + (commandContexts.get(managedGroup.managed.agentId) || "") : null,
        managedGroup ? JSON.stringify([managedGroup.managed, managedGroup.events.map(eventVersion)]) : null,
        event.type === "activity" && event.phase === "started" ? state.running : null];
      const previousKey = existing && messageRenderKeys.get(existing);
      if (previousKey && renderKey.every((value, index) => value === previousKey[index])) {
        if (previousMessage.nextElementSibling !== existing) previousMessage.after(existing);
        previousMessage = existing;
        continue;
      }
      if (existing) {
        const element = existing;
        const controls = Array.from(element.querySelectorAll(".act-row, .bash-command-toggle, summary, .execution-reference button, .managed-agent-open"));
        const focusIndex = controls.indexOf(document.activeElement);
        if (focusIndex >= 0) focusedControl = { id: element.dataset.id, index: focusIndex };
        displayStates.set(element.dataset.id, {
          rows: chatActivityRows.expandedKeys(element),
          expanded: element.querySelector(".bash-command-toggle")?.getAttribute("aria-expanded") === "true",
          details: Array.from(element.querySelectorAll("details")).map(function (details, index) { return { key: details.dataset.disclosureKey || details.className + ":" + index, open: details.open, hidden: details.hidden, loaded: chatTerminal.lazyCommandOutputs.has(details) && Boolean(details.querySelector("pre")) }; }),
          scroll: Array.from(element.querySelectorAll("pre")).map(function (pre) { return { top: pre.scrollTop, left: pre.scrollLeft }; })
        });
      }
      const message = document.createElement("article");
      message.className = "message message-" + (event.type === "interview" ? "assistant" : event.type);
      message.dataset.id = event.id;
      const compaction = event.type === "activity" && event.category === "tool" &&
        ["Context compaction", "컨텍스트 압축", t("ui.context.compaction")].includes(event.title);
      // Factory script runs keep their cards; every other action is one tracking row.
      let factoryScripts = [];
      if (event.type === "activity" && event.category === "command" && !managedGroup) {
        factoryScripts = globalThis.agentFactoryExecutionReferences?.runtimeScripts(event.output) || [];
        if (!factoryScripts.length) factoryScripts = globalThis.agentFactoryExecutionReferences?.scriptInvocations(event.text) || [];
      }
      const activityRow = event.type === "activity" && !compaction && !managedGroup && !factoryScripts.length;
      if (event.type === "assistant" || event.type === "interview") {
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
        message.classList.add(activityRow ? "message-activity-row" : "message-activity-" + (event.category || "tool"));
        message.dataset.category = event.category || "tool";
        message.dataset.phase = event.phase || "started";
      }
      if (event.type === "user" || event.type === "assistant" || event.type === "interview") {
        const marker = event.type === "user" ? document.createElement("span") : createTranscriptDot();
        marker.classList.add("transcript-marker");
        marker.setAttribute("aria-hidden", "true");
        if (event.type === "user") marker.append(createModeIcon("m9 5 7 7-7 7", "submission-chevron"));
        message.append(marker);
      }
      const content = document.createElement("div");
      content.className = "message-content";
      if (compaction) {
        message.classList.add("message-compaction");
        content.setAttribute("role", "status");
        content.setAttribute("aria-live", "polite");
        const indicator = document.createElement("span");
        indicator.className = "compaction-indicator";
        indicator.setAttribute("aria-hidden", "true");
        indicator.textContent = event.phase === "completed" ? "✓" : event.phase === "failed" ? "!" : "";
        const label = document.createElement("span");
        label.textContent = event.text;
        content.append(indicator, label);
      } else if (event.type === "notice") {
        message.dataset.level = event.level || "info";
        const mark = document.createElement("span");
        mark.className = "notice-mark";
        mark.textContent = event.level === "error" || event.level === "cancelled" ? "×" : event.level === "warning" ? "!" : "i";
        const text = document.createElement("span");
        text.textContent = localizedText(event.text, event.localization);
        content.append(mark, text);
      } else if (event.type === "assistant" && event.streaming) {
        renderPreviewMarkdown(content, event.text, event);
      } else if (event.type === "interview") {
        chatInterview.renderStructuredInterview(content, event);
      } else if (event.type === "assistant") {
        renderAssistantContent(content, event);
      } else if (activityRow) {
        message.dataset.kind = event.kind || "";
        chatActivityRows.render(content, event);
      } else if (event.type === "activity" && managedGroup) {
        message.classList.add("message-activity-agent");
        chatActivities.renderManagedAgent(content, managedGroup.managed, managedGroup.events);
      } else if (event.type === "activity" && factoryScripts.length) {
        message.classList.add("message-activity-agent");
        chatActivities.renderFactoryScripts(content, factoryScripts, globalThis.agentFactoryExecutionReferences?.skillDocuments(event.text) || [], event);
      } else {
        content.textContent = event.text;
      }
      if (event.type === "user") renderSubmission(content, event.submission, event.id);
      if (event.type === "user" && Array.isArray(event.attachments)) chatAttachments.renderHistoryAttachments(content, event.attachments);
      message.append(content);
      const display = displayStates.get(event.id);
      if (display) {
        // Reopen rows first so the raw output inside them can restore its own disclosure state.
        chatActivityRows.restoreExpanded(message, display.rows);
        const toggle = message.querySelector(".bash-command-toggle");
        const command = message.querySelector(".bash-command-text");
        if (toggle && command && display.expanded) chatTerminal.setCommandExpanded(command, toggle, true);
        message.querySelectorAll("details").forEach(function (details, index) {
          const key = details.dataset.disclosureKey || details.className + ":" + index;
          const previous = display.details.find(function (item) { return item.key === key; });
          if (previous) {
            details.open = previous.open;
            details.hidden = previous.hidden && !previous.open;
            if (previous.open || previous.loaded) chatTerminal.lazyCommandOutputs.get(details)?.();
          }
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
        const control = message.querySelectorAll(".act-row, .bash-command-toggle, summary, .execution-reference button, .managed-agent-open")[focusedControl.index];
        if (control) {
          if (control.classList.contains("bash-command-toggle")) control.hidden = false;
          control.focus({ preventScroll: true });
        }
      }
    }
    for (const [id, element] of existingMessages) {
      if (!retainedIds.has(id)) {
        messageViewStates.set(id, {
          rows: chatActivityRows.expandedKeys(element),
          expanded: element.querySelector(".bash-command-toggle")?.getAttribute("aria-expanded") === "true",
          details: Array.from(element.querySelectorAll("details")).map((details, index) => ({ key: details.dataset.disclosureKey || details.className + ":" + index, open: details.open, hidden: details.hidden, loaded: chatTerminal.lazyCommandOutputs.has(details) && Boolean(details.querySelector("pre")) })),
          scroll: Array.from(element.querySelectorAll("pre")).map(pre => ({ top: pre.scrollTop, left: pre.scrollLeft }))
        });
        element.remove(); messageElements.delete(id);
      }
    }
    while (messageViewStates.size > 2000) messageViewStates.delete(messageViewStates.keys().next().value);
    chatNavigation.updateQuestionControl();
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
    // Scroll and resize can repeat the same state; retain its existing DOM.
    if (autoScrollButton.title !== label) autoScrollButton.title = label;
    if (autoScrollButton.getAttribute("aria-label") !== label) autoScrollButton.setAttribute("aria-label", label);
    const pressed = String(state.autoScroll);
    if (autoScrollButton.getAttribute("aria-pressed") !== pressed) autoScrollButton.setAttribute("aria-pressed", pressed);
    autoScrollState.toggleAttribute("hidden", !state.autoScroll);
    if (autoScrollState.getAttribute("aria-label") !== status) autoScrollState.setAttribute("aria-label", status);
    const displayState = following ? "following" : "paused";
    if (autoScrollState.dataset.state !== displayState) autoScrollState.dataset.state = displayState;
    const path = autoScrollState.querySelector("path");
    const shape = following ? "m6 5 6 6 6-6m-12 8 6 6 6-6" : "M8 5v14M16 5v14";
    if (path.getAttribute("d") !== shape) path.setAttribute("d", shape);
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

  function renderRunStatus() {
    const pending = state.pendingRequests || [];
    const phase = !state.running && pending.length
      ? pending.some(item => !item.rejected && !item.hostAcknowledged) ? "sending"
        : pending.some(item => !item.rejected) ? "queued" : "rejected"
      : state.chatFeedback;
    document.getElementById("agent-progress").hidden = !state.running && !phase;
    document.getElementById("agent-progress").dataset.feedback = phase || "";
    runElapsed.hidden = !state.running || phase === "checking";
    const progressing = state.running && state.runExecutionStatus === "running" &&
      (!phase || ["awaiting", "waiting", "streaming", "response"].includes(phase)) && !state.pendingDecisionRunId && !state.cancellationRequested;
    document.querySelector(".composer").classList.toggle("is-progressing", progressing);
    document.getElementById("agent-progress").classList.toggle("is-progressing", progressing);
    if (!state.running || phase === "checking") {
      stopElapsedTimer();
      runStatusLabel.textContent = t("ui.task.workflow");
      runStatusLabel.title = t("ui.task.workflow");
      if (phase) runStatusLabel.textContent = runStatusLabel.title = t("feedback." + phase);
      runElapsed.textContent = t("duration.seconds", 0);
      return;
    }
    if (!state.runStartedAt) {
      state.runStartedAt = Date.now();
    }
    const elapsed = Math.max(0, Date.now() - state.runStartedAt);
    runStatusLabel.textContent = state.cancellationRequested ? t("ui.cancellation.requested") : localizedText(state.runProgress, state.runProgressLocalization) || t("ui.working");
    runStatusLabel.title = state.cancellationRequested ? t("ui.cancellation.requested") : localizedText(state.runProgress, state.runProgressLocalization) || t("ui.working");
    if (phase && (!state.cancellationRequested || ["completed", "failed", "cancelled"].includes(phase))) {
      const label = t("feedback." + phase);
      runStatusLabel.textContent = label;
      runStatusLabel.title = label + " · " + (localizedText(state.runProgress, state.runProgressLocalization) || t("ui.working"));
    }
    // With messages waiting, the line names why they wait; the queued count sits at the end of the same line.
    if (pending.some(item => !item.rejected) && !state.cancellationRequested && !state.pendingDecisionRunId &&
      (!phase || ["awaiting", "waiting", "streaming", "response"].includes(phase))) {
      runStatusLabel.title = t("feedback.queueBehind") + " · " + runStatusLabel.title;
      runStatusLabel.textContent = t("feedback.queueBehind");
    }
    runElapsed.textContent = formatElapsed(elapsed);
    const elapsedItem = statusBar.querySelector('[data-item-id="elapsed"]');
    if (elapsedItem) {
      elapsedItem.textContent = chatStatusBar.statusLabel("elapsed");
      elapsedItem.setAttribute("aria-label", elapsedItem.textContent + t("ui.move.with.alt.left.right"));
    }
    chatStatusBar.refreshStatusPreview();
    if (!elapsedTimerId && !document.hidden) {
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
      return t("duration.seconds", seconds);
    }
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    return hours ? t("duration.hours", hours, minutes, seconds) : t("duration.minutes", minutes, seconds);
  }

  const chatImageConverter = globalThis.AgentFactoryChat.imageConverter({
    createId, t, vscode, state, renderAttachments: chatAttachments.renderAttachments, updateSendButton, persist
  });

  // Only a fixed-size snapshot is retained; no care log or animation frames.
  function restoreBotCare(value) {
    const stat = key => Number.isFinite(value?.[key]) ? Math.max(0, Math.min(100, value[key])) : 80;
    const now = Date.now();
    const away = Number.isFinite(value?.updatedAt) ? Math.max(0, (now - value.updatedAt) / 60000) : 0;
    return { fullness: stat("fullness"), happiness: stat("happiness"),
      energy: Math.min(100, stat("energy") + away * 2),
      careCount: Number.isSafeInteger(value?.careCount) && value.careCount >= 0 ? value.careCount : 0,
      updatedAt: now };
  }

  statusSettingsButton.addEventListener("click", function () {
    if (!statusSettings.hidden) { chatStatusBar.closeStatusSettings(); return; }
    closeSettingMenu();
    chatAgentSettings.renderGeneralSettings();
    statusSettings.hidden = false;
    statusSettingsButton.setAttribute("aria-expanded", "true");
    chatStatusBar.renderStatusCatalog();
    renderAccountUsage();
    vscode.postMessage({ type: "usage.refresh" });
    statusSettings.querySelector('[role="tab"][aria-selected="true"]')?.focus();
  });
  let accountUsage = {};
  // Antigravity keeps separate quota pools for Gemini and for its Claude/GPT models.
  const usageProviders = [["codex", "Codex"], ["claude", "Claude"], ["antigravity-gemini", "Antigravity · Gemini"],
    ["antigravity-claude-gpt", "Antigravity · Claude/GPT"]];
  function renderAccountUsage() {
    const root = document.getElementById("account-usage");
    if (!root || statusSettings.hidden) return;
    const groups = usageProviders.map(function ([id, name]) {
      const group = document.createElement("section");
      group.className = "usage-group";
      group.dataset.provider = id;
      const header = document.createElement("header");
      header.className = "usage-group-heading";
      const heading = document.createElement("h3");
      heading.textContent = name;
      header.append(heading);
      group.append(header);
      const report = accountUsage[id];
      const note = text => { const p = document.createElement("p"); p.className = "usage-note"; p.textContent = text; group.append(p); };
      if (!report || typeof report !== "object") { group.dataset.state = "empty"; note(t("ui.usage.not.reported")); return group; }
      group.dataset.state = "ready";
      if (Number.isFinite(report.reportedAt)) {
        const reported = document.createElement("time");
        reported.className = "usage-reported";
        reported.dateTime = new Date(report.reportedAt).toISOString();
        reported.textContent = t("ui.usage.reported") + " · " + new Date(report.reportedAt).toLocaleString(uiLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
        header.append(reported);
      }
      const limits = document.createElement("div");
      limits.className = "usage-limits";
      for (const [key, label] of [["fiveHour", t("ui.usage.five.hour")], ["weekly", t("ui.usage.weekly")]]) {
        const used = safePercentOrUndefined(report[key + "UsedPercent"]);
        const resetsAt = safeResetsAtOrUndefined(report[key + "ResetsAt"]);
        if (used === undefined && resetsAt === undefined) continue;
        const remaining = used === undefined ? undefined : Math.max(0, 100 - used);
        const item = document.createElement("article");
        item.className = "usage-limit";
        item.dataset.level = remaining === undefined ? "unknown" : remaining <= 20 ? "low" : remaining <= 50 ? "medium" : "healthy";
        const top = document.createElement("div");
        top.className = "usage-limit-heading";
        const title = document.createElement("span");
        title.textContent = label;
        const value = document.createElement("strong");
        value.className = "usage-limit-value";
        value.textContent = t("ui.usage.left") + (remaining === undefined ? "—" : formatPercent(remaining));
        top.append(title, value);
        item.append(top);
        if (remaining !== undefined) {
          const progress = document.createElement("progress");
          progress.className = "usage-meter";
          progress.max = 100;
          progress.value = remaining;
          progress.setAttribute("aria-label", name + " " + label + " " + t("ui.usage.left").trim());
          item.append(progress);
        }
        const reset = document.createElement("p");
        reset.className = "usage-reset";
        reset.textContent = t("ui.usage.resets") + formatResetsAt(resetsAt);
        item.append(reset);
        limits.append(item);
      }
      if (limits.children.length) group.append(limits);
      return group;
    });
    root.replaceChildren(...groups);
  }
  const settingsTabs = [...statusSettings.querySelectorAll("[data-settings-tab]")];
  const settingsTabOrder = globalThis.AgentFactoryChat.settingsTabOrder({ tabs: settingsTabs, state, persist, t });
  function selectSettingsTab(tab) {
    chatAgentSettings.renderAgentDefaults();
    for (const item of settingsTabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden = !selected;
    }
    chatStatusBar.renderStatusCatalog();
    renderAccountUsage();
    if (tab.dataset.settingsTab === "providers" && !chatProviders.providerVersionsRequested) {
      chatProviders.providerVersionsRequested = true;
      chatProviders.providerCatalog = null;
      chatProviders.renderProviderSettings();
      vscode.postMessage({ type: "providers.versions.request" });
    }
    tab.focus();
  }
  for (const tab of settingsTabs) {
    tab.addEventListener("click", function () { selectSettingsTab(tab); });
    tab.addEventListener("keydown", function (event) {
      const visibleTabs = settingsTabOrder.visibleTabs();
      const index = visibleTabs.indexOf(tab);
      let next;
      if (chatShortcuts.matchesShortcut(event, chatShortcuts.shortcuts.settingsTabNext)) next = (index + 1) % visibleTabs.length;
      if (chatShortcuts.matchesShortcut(event, chatShortcuts.shortcuts.settingsTabPrevious)) next = (index + visibleTabs.length - 1) % visibleTabs.length;
      if (chatShortcuts.matchesShortcut(event, chatShortcuts.shortcuts.settingsTabFirst)) next = 0;
      if (chatShortcuts.matchesShortcut(event, chatShortcuts.shortcuts.settingsTabLast)) next = visibleTabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      selectSettingsTab(visibleTabs[next]);
    });
  }
  document.getElementById("bots-disabled").addEventListener("change", function (event) {
    if (!state.botsAvailable) return;
    state.botsEnabled = !event.target.checked;
    chatBot.renderFactoryBot();
    vscode.postMessage({ type: "bots.configure", enabled: state.botsEnabled });
  });
  for (const [id, key] of [["bot-visible", "botVisible"], ["bot-animations", "botAnimations"]]) {
    const control = document.getElementById(id);
    control.checked = state[key];
    control.addEventListener("change", function () {
      state[key] = control.checked;
      chatBot.renderFactoryBot();
      persist();
    });
  }
  document.getElementById("status-settings-close").addEventListener("click", chatStatusBar.closeStatusSettings);
  document.getElementById("status-reset").addEventListener("click", function () {
    chatStatusBar.setStatusItems(defaultStatusItems, t("ui.default.status.items.and.order.restored"));
  });
  statusSettings.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      if (CSS.supports("selector(select:open)") && statusSettings.querySelector("select:open")) return;
      event.preventDefault(); event.stopPropagation(); chatStatusBar.closeStatusSettings();
    }
  });

  function updateSendButton() {
    sendButton.disabled = conversationClearing || !state.runtimeAvailable || !state.capabilities || Boolean(chatWorkUnits.conversationWorktree?.worktree?.workUnit && chatWorkUnits.conversationWorktree.worktree.phase === "merged");
  }

  function updateRunControls() {
    chatWorkUnits.renderWorktree();
    chatPendingQueue.renderPendingQueue();
    updateExecutionControl();
    updateComposerControls();
    renderRunStatus();
    chatTaskFlow.renderWorkLoopPanel();
  }

  // Draft edits affect send/recovery controls, not queue contents or run panels.
  function updateComposerControls() {
    const hasContent = hasComposerContent();
    document.querySelectorAll("[data-queue-recover]").forEach(function (button) {
      if (button.disabled !== hasContent) button.disabled = hasContent;
    });
    const queuesMessage = (state.running || (state.pendingRequests || []).length > 0) && hasContent;
    sendButton.classList.toggle("is-running", state.running && !queuesMessage);
    sendButton.setAttribute("aria-label", queuesMessage ? t("ui.add.message.to.queue") : state.running ? t("ui.stop.current.run") : t("ui.send.message"));
    const sendKey = chatShortcuts.shortcutLabel(chatShortcuts.shortcuts.send);
    sendButton.title = (queuesMessage ? t("ui.add.to.queue.enter") : state.running ? t("ui.stop.current.run.esc") : t("ui.send.enter")).replace(/Enter/g, sendKey);
    const goalActive = state.role === "main" && !goalError && nativeGoal?.status === "active";
    const stopsRun = state.running && !queuesMessage;
    if (goalActive && !stopsRun) {
      sendButton.setAttribute("aria-label", t(queuesMessage ? "ui.goal.active.queue" : "ui.goal.active.send"));
      sendButton.title = t(queuesMessage ? "ui.goal.active.queue" : "ui.goal.active.send");
    }
    sendIcon.toggleAttribute("hidden", stopsRun || goalActive);
    goalSendIcon.toggleAttribute("hidden", stopsRun || !goalActive);
    stopIcon.toggleAttribute("hidden", !state.running || queuesMessage);
    updateSendButton();
  }

  function hasComposerContent() {
    return prompt.value.trim().length > 0 || state.attachments.length > 0;
  }

  function toggleMode(key) {
    state[key] = !state[key];
    updateModeControls();
    chatStatusBar.renderStatusBar();
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
    if (openSettingId === "model" && document.getElementById("agent-default-scope").value === "chat") chatAgentSettings.renderModelSettings(modelMenu);
    updateExecutionControl();
    const supported = currentCapabilities();
    modelButton.parentElement.hidden = false;
    submissionButton.hidden = state.role !== "main";
    fastModeSetting.hidden = supported.fast !== true;
    fastModeButton.hidden = supported.fast !== true;
    orchestrateModeButton.hidden = state.role !== "main";
    orchestrateModeButton.disabled = !orchestrateAvailable();
    const orchestrating = enterAction() === "orchestrate";
    const orchestrateLabel = !orchestrateAvailable() ? t("ui.orchestrate.mode.unavailable") : orchestrating ? t("ui.orchestrate.mode.on") : t("ui.orchestrate.mode.off");
    orchestrateModeButton.setAttribute("aria-pressed", String(orchestrating));
    orchestrateModeButton.setAttribute("aria-label", orchestrateLabel);
    orchestrateModeButton.title = orchestrateLabel;
    workIsolationButton.hidden = state.role !== "main";
    workIsolationButton.disabled = currentCapabilities().workIsolation !== true;
    const isolationLabel = workIsolationButton.disabled ? t("ui.work.isolation.unavailable") : state.workIsolation ? t("ui.work.isolation.on") : t("ui.work.isolation.off");
    workIsolationButton.setAttribute("aria-pressed", String(state.workIsolation === true && !workIsolationButton.disabled));
    workIsolationButton.setAttribute("aria-label", isolationLabel);
    workIsolationButton.title = isolationLabel;
    fastModeButton.setAttribute("aria-pressed", String(state.fastMode));
    fastModeButton.setAttribute("aria-label", state.fastMode ? t("ui.fast.mode.on") : t("ui.fast.mode.off"));
    fastModeButton.title = state.fastMode ? t("ui.fast.mode.on") : t("ui.fast.mode.off");
    fastModeValue.textContent = state.fastMode ? t("ui.on") : t("ui.off");
    const selectedRun = state.role !== "main" ? state.capturedRun || {} : undefined;
    const modelText = selectedRun ? (selectedRun.model || t("flow.model.unavailable")) : (chatAgentSettings.effectiveAgentValue("main", "model") ? chatAgentSettings.modelOptionLabel(chatAgentSettings.effectiveAgentValue("main", "model")) : t("ui.default")) + " · " + reasoningDisplayLabel(chatAgentSettings.effectiveAgentValue("main", "reasoningEffort"));
    if (modelLabel.textContent !== modelText) modelLabel.textContent = modelText;
    modelButton.title = selectedRun ? t("ui.captured.run.model") + " · " + (selectedRun.runId || "—") + " · " + (selectedRun.model || t("flow.model.unavailable")) : t("ui.models.and.reasoning");
    modelButton.setAttribute("aria-label", modelButton.title);
    if (openSettingId === "submission") renderSubmissionMenu(submissionMenu);
    updateComposerControls();
    chatStatusBar.renderStatusBar();
  }

  function openSetting(setting) {
    if (openSettingId === setting) {
      closeSettingMenu(true);
      return;
    }
    closeSettingMenu(false);
    chatNavigation.closeSessionMenu(false);
    chatNavigation.closeQuestionMenu(false);
    openSettingId = setting;
    if (setting === "model") vscode.postMessage({ type: "models.request" });
    if (setting === "worktree" && state.role === "main") chatWorkUnits.requestDeployTargets();
    const button = settingButton(setting);
    const menu = settingMenu(setting);
    renderSettingMenu(setting, menu);
    menu.hidden = false;
    if (setting === "worktree") chatWorkUnits.positionWorktreeMenu();
    button.setAttribute("aria-expanded", "true");
    const selected = menu.querySelector('[aria-checked="true"]:not(:disabled)');
    (selected || menu.querySelector("button:not(:disabled), select:not(:disabled), details:not([hidden]) > summary"))?.focus();
  }

  const chatProviders = globalThis.AgentFactoryChat.providers({
    appendNotice, t, vscode
  });

  function setConversationClearing(busy) {
    // The clear button spins while clearing; its label carries the status for assistive technology.
    conversationClearing = busy;
    updateConversationClearControl();
    updateSendButton();
  }

  function updateConversationClearControl() {
    const clear = document.getElementById("conversation-clear-button");
    clear.hidden = state.role !== "main";
    clear.disabled = conversationClearing || !state.agentId || state.running || state.queueCount > 0 || Boolean(state.pendingDecisionRunId);
    clear.title = t(conversationClearing ? "ui.clearing.conversation" : "ui.clear.conversation");
    clear.setAttribute("aria-label", clear.title);
    clear.setAttribute("aria-busy", String(conversationClearing));
    clear.onclick = function () {
      if (clear.disabled) return;
      setConversationClearing(true);
      vscode.postMessage({ type: "conversation.clear" });
    };
  }

  function resetConversationState() {
    state.chatFeedback = undefined;
    state.historyFeedback = undefined;
    state.historyPageOperation = undefined;
    state.historyPageError = undefined;
    state.historyNextBefore = undefined;
    timelineEndId = undefined;
    messageViewStates.clear();
    state.guidanceExpanded = [];
    state.timeline = [];
    state.taskFlows = [];
    state.pendingRequests = [];
    state.recoveredRequest = undefined;
    state.startedMessageIds = [];
    state.pendingDecisionRunId = undefined;
    state.decisionSubmitting = false;
    state.queueCount = 0;
    state.contextUsedTokens = undefined;
    state.contextWindowTokens = undefined;
    state.weeklyUsedPercent = undefined;
    state.fiveHourUsedPercent = undefined;
    state.weeklyResetsAt = undefined;
    state.fiveHourResetsAt = undefined;
    state.childAgents = [];
    state.workflows = [];
    state.workUnitsKnown = false;
    state.workUnits = { activeUnits: 0, workActive: 0, verificationActive: 0, totalCalled: 0 };
    nativeGoal = null;
    goalError = undefined;
    followLatest = true;
  }

  function renderSubmissionMenu(menu) {
    menu = menu.querySelector("#submission-options");
    menu.replaceChildren();
    const entry = id => {
      const item = chatShortcuts.shortcutActions.find(action => action.id === id);
      return [item.label(), item.submit.action, item.submit.workflow, item.submit.goal, id];
    };
    const groups = [
      [t("ui.document.main"), ["submitPlanning", "submitInterview", "submitMigration", "submitLessons"].map(entry)],
      [t("ui.task.workflow"), ["submitContract", "submitWork", "submitWorkVerification"].map(entry)],
      [t("ui.deploy.group"), [entry("submitPipeline")]],
      [t("ui.goal"), [entry("submitGoal")]]
    ];
    for (const [title, entries] of groups) {
      const group = document.createElement("div");
      group.setAttribute("role", "group"); group.setAttribute("aria-label", title);
      const heading = document.createElement("div"); heading.className = "submission-heading"; heading.textContent = title;
      group.append(heading);
      for (const [label, action, workflow, goal, shortcutId] of entries) {
        const option = document.createElement("button");
        option.type = "button"; option.className = "setting-option"; option.setAttribute("role", "menuitem");
        option.dataset.action = action; option.dataset.workflow = workflow; option.dataset.goal = String(goal);
        option.disabled = submissionOptionDisabled(action, goal);
        option.title = option.disabled ? t("ui.requires.a.compatible.runtime") : t("submission.send", label) + (chatShortcuts.shortcuts[shortcutId] ? " (" + chatShortcuts.shortcutLabel(chatShortcuts.shortcuts[shortcutId]) + ")" : "");
        if (chatShortcuts.shortcuts[shortcutId]) option.setAttribute("aria-keyshortcuts", chatShortcuts.shortcutAria(chatShortcuts.shortcuts[shortcutId]));
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

  function submissionOptionDisabled(action, goal) {
    return !state.runtimeAvailable || (goal ? currentCapabilities().goal !== true : action !== "direct" && !currentCapabilities().taskModes?.includes(action));
  }

  function renderSettingMenu(setting, menu) {
    if (setting === "model") {
      chatStatusBar.closeStatusSettings();
      chatAgentSettings.renderModelSettings(menu);
    }
    else if (setting === "worktree") { chatWorkUnits.renderWorktree(); vscode.postMessage({ type: "worktree.repositories" }); }
    else renderSubmissionMenu(menu);
  }

  function createBusinessModeIcon(mode) {
    const paths = {
      normal: "M4 4h6v6H4Zm10 0h6v6h-6ZM4 14h6v6H4Zm10 0h6v6h-6Z",
      interview: "M4 4h16v12H9l-5 4V4Zm4 4h8M8 12h5",
      contract: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14M7 7h3M7 11h2m3 6 1-4L20 6l3 3-7 7-4 1Zm6-9 3 3",
      migration: "M4 4h10v16H4ZM8 8h12m-3-3 3 3-3 3M8 16h12m-3-3 3 3-3 3",
      lessons: "M5 3h14v18H5ZM8 8l2 2 5-5M8 14h8M8 17h6",
      pipeline: "M4 6h5v5H4Zm11 7h5v5h-5ZM9 8.5h3a2 2 0 0 1 2 2v2.5m-2-2 2 2 2-2",
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
      work: "M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M5 7h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2ZM3 12a20 20 0 0 0 18 0M12 12v3",
      "plan-work": "M14 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6M8 7h6M8 11h4M8 15h2m5 0 5 3-5 3v-6",
      "work-verification": "M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 2h6a1 1 0 0 1 1 1v3H8V3a1 1 0 0 1 1-1Zm-1 12 3 3 5-6",
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
    const options = Array.from(event.currentTarget.closest(".setting-menu").querySelectorAll(".setting-option:not(:disabled)")).filter(option => !option.closest("[hidden]"));
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
    if (openSettingId === "submission") {
      const history = document.getElementById("task-history");
      if (history) history.open = false;
    }
    button.setAttribute("aria-expanded", "false");
    openSettingId = undefined;
    if (restoreFocus) {
      button.focus();
    }
  }

  function settingButton(setting) { return setting === "model" ? modelButton : setting === "worktree" ? chatWorkUnits.worktreeButton : submissionButton; }
  function settingMenu(setting) { return setting === "model" ? modelMenu : setting === "worktree" ? chatWorkUnits.worktreeMenu : submissionMenu; }

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
    clearTimeout(persistenceTimer);
    if (immediate) {
      persistenceTimer = undefined;
      persistenceStartedAt = undefined;
      persistenceScheduled = false;
      persistNow();
      return;
    }
    // Save after a quiet interval, but bound continuous typing/output to one second.
    if (!persistenceScheduled) persistenceStartedAt = Date.now();
    persistenceScheduled = true;
    persistenceTimer = setTimeout(function () {
      persistenceTimer = undefined;
      persistenceStartedAt = undefined;
      if (!persistenceScheduled) return;
      persistenceScheduled = false;
      persistNow();
    }, Math.max(0, Math.min(delay, 1000 - (Date.now() - persistenceStartedAt))));
  }

  // Retain an immutable JSON-shaped snapshot. Compare scalar values rather than
  // serializing long message bodies just to detect redundant setState calls.
  function persistenceSnapshot(value, previous) {
    if (value === null || typeof value !== "object") return value;
    const keys = Object.keys(value);
    const compatible = previous !== null && typeof previous === "object" && Array.isArray(value) === Array.isArray(previous);
    let unchanged = compatible && keys.length === Object.keys(previous).length;
    const snapshot = Array.isArray(value) ? [] : Object.create(null);
    for (const key of keys) {
      snapshot[key] = persistenceSnapshot(value[key], compatible && Object.hasOwn(previous, key) ? previous[key] : undefined);
      if (!compatible || !Object.hasOwn(previous, key) || snapshot[key] !== previous[key]) unchanged = false;
    }
    return unchanged ? previous : snapshot;
  }

  // Select the existing restoration window from the tail. Full history stays in
  // state.timeline and the runtime; do not scan it for every draft/status save.
  function persistedTimeline() {
    const events = [];
    for (let index = state.timeline.length - 1; index >= 0 && events.length < 200; index--) {
      const event = state.timeline[index];
      if (!event.streaming) events.push(event);
    }
    return events.reverse();
  }

  function persistNow() {
    const next = persistenceSnapshot({
      shortcuts: { ...chatShortcuts.shortcuts },
      shortcutDefaultsVersion: chatShortcuts.shortcutDefaultsVersion,
      startedMessageIds: state.startedMessageIds,
      guidanceExpanded: state.guidanceExpanded,
      pendingRequests: state.pendingRequests,
      recoveredRequest: state.recoveredRequest,
      notesScope: chatNotes.selectedNotesScope,
      noteDraft: chatNotes.noteDraft && (chatNotes.noteDirty || chatNotes.noteSending) ? { ...chatNotes.noteDraft } : null,
      panelId: state.panelId,
      agentId: state.agentId,
      conversationId: state.conversationId,
      historyNextBefore: state.historyNextBefore,
      title: state.title,
      role: state.role,
      verifiedWorkRunId: state.verifiedWorkRunId,
      draft: state.draft,
      autoScroll: state.autoScroll,
      orchestrateMode: state.orchestrateMode,
      maestroMode: state.maestroMode,
      uiLanguage: state.uiLanguage,
      settingsTabOrder: state.settingsTabOrder,
      botVisible: state.botVisible,
      botPosition: state.botPosition,
      botAnimations: state.botAnimations,
      botCare: state.botCare,
      attachments: state.attachments.filter(function (attachment) {
        return !attachment.pending && !attachment.previewUri?.startsWith("blob:");
      }).map(function (attachment) {
        if (attachment.kind !== "image") return attachment;
        const { previewUri, ...persisted } = attachment;
        return persisted;
      }),
      taskFlows: chatTaskFlow.currentTaskFlows().slice(-100),
      timeline: persistedTimeline().map(function (event) {
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
      agentFastModes: state.agentFastModes,
      model: state.model,
      capturedRun: state.capturedRun,
      reasoning: state.reasoning,
      agentSettingsVersion: state.agentSettingsVersion,
      agentSettingsScope: state.agentSettingsScope,
      agentSettingsSet: state.agentSettingsSet,
      fastMode: state.fastMode,
      contextUsedTokens: state.contextUsedTokens,
      contextWindowTokens: state.contextWindowTokens,
      weeklyUsedPercent: state.weeklyUsedPercent,
      fiveHourUsedPercent: state.fiveHourUsedPercent,
      weeklyResetsAt: state.weeklyResetsAt,
      fiveHourResetsAt: state.fiveHourResetsAt,
      runExecutionStatus: state.runExecutionStatus,
      runProgress: state.runProgress,
      runProgressLocalization: state.runProgressLocalization,
      runStartedAt: state.runStartedAt,
      workUnits: state.workUnits,
      childAgents: state.childAgents,
      workflows: state.workflows
    }, lastPersistedState);
    if (next === lastPersistedState) return;
    vscode.setState(next);
    lastPersistedState = next;
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
      agentFastModes: state.agentFastModes,
      model: state.model || undefined,
      reasoning: state.reasoning || undefined,
      agentSettingsScope: state.agentSettingsScope,
      agentSettingsSet: state.agentSettingsSet,
      fastMode: state.fastMode,
      goalMode: false,
      businessMode: "normal",
      maestroMode: state.maestroMode === true,
    });
  }

  function contextStatusLabel() {
    if (state.contextUsedTokens === undefined || !(state.contextWindowTokens > 0)) return t("ui.ctx.left");
    const remaining = Math.max(0, state.contextWindowTokens - state.contextUsedTokens);
    return t("ui.ctx.left.350cbf") + formatPercent(remaining / state.contextWindowTokens * 100);
  }

  function normalizeCapturedRun(value, agentId) {
    const validId = id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
    if (!value || value.agentId !== agentId || !validId(value.agentId) || !validId(value.parentAgentId) || !validId(value.runId)) return undefined;
    return { parentAgentId: value.parentAgentId, agentId: value.agentId, runId: value.runId,
      ...(typeof value.model === "string" && value.model.trim() ? { model: value.model } : {}),
      ...(typeof value.reasoningEffort === "string" && value.reasoningEffort.trim() ? { reasoningEffort: value.reasoningEffort } : {}),
      ...(["work", "workLight", "explore", "scribe"].includes(value.workProfile) ? { workProfile: value.workProfile } : {}) };
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

  // Provider-reported refill time (Unix seconds): time only when it falls today, otherwise date and time.
  function formatResetsAt(seconds) {
    if (safeResetsAtOrUndefined(seconds) === undefined) return "—";
    const date = new Date(seconds * 1000);
    if (date.getTime() <= Date.now()) return t("ui.reset.elapsed");
    const time = { hour: "2-digit", minute: "2-digit" };
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString(uiLocale(), time)
      : date.toLocaleString(uiLocale(), { month: "numeric", day: "numeric", weekday: "short", ...time });
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

  function normalizeModelFastModes(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([model, enabled]) =>
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model) && typeof enabled === "boolean"));
  }
  function normalizeAgentFastModes(value, legacy) {
    const roles = ["main", "work", "workLight", "verification", "explore", "scribe"];
    const legacyModes = normalizeModelFastModes(legacy);
    const result = {};
    for (const role of roles) {
      const modes = normalizeModelFastModes(value?.[role]);
      const merged = {...legacyModes, ...modes};
      if (Object.keys(merged).length) result[role] = merged;
    }
    return result;
  }
  function normalizeModel(value) {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$|^antigravity\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value) ? value : "";
  }

  function safePercentOrUndefined(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
      ? value
      : undefined;
  }

  function safeResetsAtOrUndefined(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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
    chatShortcuts.renderShortcuts();
    inputFeedback.textContent = localizedText(inputFeedback.textContent, feedback);
    renderAll();
    chatStatusBar.renderStatusCatalog();
    chatAgentSettings.renderModelSettings(modelMenu);
    renderSubmissionMenu(submissionMenu);
    chatAgentSettings.renderGeneralSettings();
    chatNavigation.renderQuestionList();
    chatNavigation.renderSessionList();
    chatAgents.renderAgentsList();
    chatBot.renderFactoryBot();
    persist();
  });
})();
