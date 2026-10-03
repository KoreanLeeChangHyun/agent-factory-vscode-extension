(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  let conversationClearing = false;
  let persistenceScheduled = false;
  let persistenceTimer;
  let persistenceStartedAt;
  let lastPersistedState;
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
  // Every chat action is bindable. Prompt-scoped actions read the draft; the
  // rest run anywhere in the chat. Bindings are "Mod+Alt+Shift+Key" strings.
  const shortcutGroups = [
    { id: "composer", label: () => t("ui.shortcuts.group.composer") },
    { id: "document", label: () => t("ui.document.main") },
    { id: "workflow", label: () => t("ui.task.workflow") },
    { id: "history", label: () => t("ui.shortcuts.group.history") },
    { id: "bot", bot: true, label: () => t("ui.bot") },
    { id: "basic", label: () => t("ui.shortcuts.group.basic") }
  ];
  const submitShortcut = (id, group, fallback, label, action, workflow, goal) =>
    ({ id: id, group: group, fallback: fallback, submit: { action: action, workflow: workflow, goal: goal }, label: label });
  const shortcutActions = [
    { id: "send", group: "composer", scope: "prompt", required: true, fallback: "Enter", label: () => t("ui.send.message") },
    { id: "bot", group: "composer", scope: "prompt", bot: true, fallback: "Mod+Shift+Enter", label: () => t("bot.named.shortcut", botDisplayName()) },
    { id: "newLine", group: "composer", scope: "prompt", fallback: "Shift+Enter", label: () => t("ui.new.line") },
    submitShortcut("submitPlanning", "document", "Alt+Shift+P", () => businessModeNames().planning, "direct", "planning", false),
    submitShortcut("submitInterview", "document", "Alt+Shift+I", () => businessModeNames().interview, "direct", "interview", false),
    submitShortcut("submitMigration", "document", "Alt+Shift+M", () => businessModeNames().migration, "direct", "migration", false),
    submitShortcut("submitLessons", "document", "Alt+Shift+L", () => businessModeNames().lessons, "direct", "lessons", false),
    submitShortcut("submitContract", "workflow", "Alt+Shift+C", () => t("ui.contract"), "direct", "contract", false),
    submitShortcut("submitWork", "workflow", "Alt+Shift+W", () => t("ui.work"), "work", "normal", false),
    submitShortcut("submitWorkVerification", "workflow", "Alt+Shift+V", () => t("submission.work.verification.label"), "work-verification", "normal", false),
    submitShortcut("submitPipeline", "workflow", "Alt+Shift+D", () => businessModeNames().pipeline, "direct", "pipeline", false),
    submitShortcut("submitGoal", "workflow", "Alt+Shift+G", () => t("ui.goal"), "direct", "normal", true),
    { id: "openContracts", group: "history", fallback: "Alt+Shift+K", history: "contract-list", label: () => t("contracts.title") },
    { id: "openTaskHistory", group: "history", fallback: "Alt+Shift+T", history: "task-history", label: () => t("flow.history") },
    { id: "openConversationHistory", group: "history", fallback: "Alt+Shift+H", questionTab: "history", label: () => t("ui.conversation.history") },
    { id: "botMenu", group: "bot", bot: true, fallback: "Alt+Shift+B", label: () => t("ui.shortcuts.bot.menu", botDisplayName()) },
    { id: "botFeed", group: "bot", bot: true, fallback: "Alt+Shift+1", button: '[data-bot-action="feed"]', label: () => t("bot.feed") },
    { id: "botPlay", group: "bot", bot: true, fallback: "Alt+Shift+2", button: '[data-bot-action="play"]', label: () => t("bot.play") },
    { id: "botSleep", group: "bot", bot: true, fallback: "Alt+Shift+3", button: '[data-bot-action="sleep"]', label: () => t("bot.sleep") },
    { id: "botPet", group: "bot", bot: true, fallback: "Alt+Shift+4", button: '[data-companion-action="pet"]', label: () => t("bot.pet") },
    { id: "botPraise", group: "bot", bot: true, fallback: "Alt+Shift+5", button: '[data-companion-action="praise"]', label: () => t("bot.praise") },
    { id: "botCall", group: "bot", bot: true, fallback: "Alt+Shift+6", button: '[data-companion-action="call"]', label: () => t("bot.call") },
    // Basic controls keep their browser behavior on the default key and are
    // emulated when rebound, so the default key stops acting once replaced.
    { id: "close", group: "basic", required: true, native: "Escape", fallback: "Escape", label: () => t("ui.close.settings.or.an.open.menu") },
    { id: "focusNext", group: "basic", required: true, native: "Tab", fallback: "Tab", label: () => t("ui.shortcuts.focus.next") },
    { id: "focusPrevious", group: "basic", required: true, native: "Shift+Tab", fallback: "Shift+Tab", label: () => t("ui.shortcuts.focus.previous") },
    { id: "settingsTabPrevious", group: "basic", scope: "tabs", fallback: "ArrowLeft", label: () => t("ui.shortcuts.tab.previous") },
    { id: "settingsTabNext", group: "basic", scope: "tabs", fallback: "ArrowRight", label: () => t("ui.shortcuts.tab.next") },
    { id: "settingsTabFirst", group: "basic", scope: "tabs", fallback: "Home", label: () => t("ui.shortcuts.tab.first") },
    { id: "settingsTabLast", group: "basic", scope: "tabs", fallback: "End", label: () => t("ui.shortcuts.tab.last") }
  ];
  const legacyShortcuts = { enter: "Enter", "mod-enter": "Mod+Enter", "alt-enter": "Alt+Enter", "mod-shift-enter": "Mod+Shift+Enter", none: "" };
  const shortcutApple = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  const shortcutKeyNames = { Mod: shortcutApple ? "⌘" : "Ctrl", Alt: shortcutApple ? "⌥" : "Alt", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Plus: "+", Escape: "Esc" };
  const shortcutList = document.getElementById("shortcut-bindings");
  const shortcutStatus = document.getElementById("shortcuts-status");
  // Recording flow: choose an action, press the keys, then confirm or cancel.
  let shortcutRecording;
  const shortcuts = {};
  // Version 1 stored "" for actions that had no default yet; give them one.
  const shortcutDefaultsVersion = 2;
  const legacyEmpty = saved?.shortcutDefaultsVersion !== shortcutDefaultsVersion;
  for (const action of shortcutActions) {
    let value = saved?.shortcuts?.[action.id];
    if (legacyEmpty && value === "" && !Object.values(saved?.shortcuts || {}).includes(action.fallback)) value = action.fallback;
    if (Object.hasOwn(legacyShortcuts, value)) value = legacyShortcuts[value];
    const valid = typeof value === "string" && (value ? !shortcutProblem(action, value) : !action.required) &&
      !(value && Object.values(shortcuts).includes(value));
    shortcuts[action.id] = valid ? value : action.fallback;
  }
  if (new Set(Object.values(shortcuts).filter(Boolean)).size !== Object.values(shortcuts).filter(Boolean).length) {
    for (const action of shortcutActions) shortcuts[action.id] = action.fallback;
  }
  function shortcutFromEvent(event) {
    if (event.ctrlKey && event.metaKey) return "";
    const code = event.code || "";
    const raw = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : event.key;
    if (!raw || ["Control", "Meta", "Shift", "Alt", "AltGraph", "CapsLock", "Process", "Unidentified", "Dead"].includes(raw)) return "";
    const key = raw === " " ? "Space" : raw === "+" ? "Plus" : raw.length === 1 ? raw.toUpperCase() : raw;
    return [event.ctrlKey || event.metaKey ? "Mod" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", key].filter(Boolean).join("+");
  }
  function shortcutProblem(action, binding) {
    const parts = binding.split("+"), key = parts.at(-1);
    if (parts.includes("Mod") || parts.includes("Alt")) return "";
    // Unmodified typing and editing keys would stop working in text fields.
    if (key.length === 1 || key === "Space" || key === "Backspace" || key === "Delete") return "ui.shortcuts.needs.modifier";
    if (key === "Enter" && action.scope !== "prompt") return "ui.shortcuts.needs.modifier";
    if (/^(Arrow|Page)|^(Home|End)$/.test(key) && action.scope !== "tabs") return "ui.shortcuts.needs.modifier";
    return "";
  }
  function shortcutComposing(event) {
    return event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229;
  }
  const state = {
    panelId: typeof saved?.panelId === "string" ? saved.panelId : undefined,
    agentId: typeof saved?.agentId === "string" ? saved.agentId : undefined,
    conversationId: typeof saved?.conversationId === "string" ? saved.conversationId : undefined,
    title: typeof saved?.title === "string" ? saved.title : "Main Agent",
    role: ["main", "work", "verification"].includes(saved?.role) ? saved.role : "main",
    verifiedWorkRunId: typeof saved?.verifiedWorkRunId === "string" ? saved.verifiedWorkRunId : undefined,
    draft: typeof saved?.draft === "string" ? saved.draft : "",
    autoScroll: saved?.autoScroll !== false,
    // Ordinary Enter sends orchestrator mode unless the Human switches this chat to worker mode (direct).
    orchestrateMode: saved?.orchestrateMode !== false,
    uiLanguage: ["auto", "ko", "en"].includes(saved?.uiLanguage) ? saved.uiLanguage : "auto",
    botsEnabled: false,
    botsAvailable: true,
    companionAvailable: true,
    botVisible: saved?.botVisible !== false,
    botAnimations: saved?.botAnimations !== false,
    botCare: restoreBotCare(saved?.botCare),
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
    modelFastModes: normalizeModelFastModes(saved?.modelFastModes),
    model: normalizeModel(saved?.model),
    reasoning: normalizeSettingValue(saved?.reasoning, settingOptions.reasoning),
    agentSettingsScope: ["global", "project", "chat"].includes(saved?.agentSettingsScope) ? saved.agentSettingsScope : undefined,
    agentSettingsSet: typeof saved?.agentSettingsSet === "string" && saved.agentSettingsSet.trim() ? saved.agentSettingsSet.trim() : "Default",
    fastMode: saved?.fastMode === true,
    goalMode: false,
    businessMode: "normal",
    taskMode: "direct",
    workLoopMode: false,
    queueCount: 0,
    contextUsedTokens: safeCountOrUndefined(saved?.contextUsedTokens),
    contextWindowTokens: safeCountOrUndefined(saved?.contextWindowTokens),
    weeklyUsedPercent: safePercentOrUndefined(saved?.weeklyUsedPercent),
    fiveHourUsedPercent: safePercentOrUndefined(saved?.fiveHourUsedPercent),
    weeklyResetsAt: safeResetsAtOrUndefined(saved?.weeklyResetsAt),
    fiveHourResetsAt: safeResetsAtOrUndefined(saved?.fiveHourResetsAt),
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
  let botOutcome;
  let botWaveTimer;
  let botIdleTimer;
  let botIdleSince;
  let botCareTimer;
  const botMenu = document.getElementById("bot-menu");
  let companionSnapshot;
  let botReplyEmotion;
  let companionWorking = 0;
  let companionOutcome;
  let companionOutcomeUntil = 0;
  let companionTimer;
  let companionReactionDismissedUntil = 0;
  let companionPetStart;
  let companionPetDistance = 0;
  function interactCompanion(action) {
    if (state.botsEnabled && state.companionAvailable) vscode.postMessage({ type: "bot.interact", action: action });
  }
  const companionRasterCache = new Map();
  const companionSources = new Map();
  function smoothCompanionSheet(sprite, scale) {
    if (!companionSources.has(sprite.dataset.sheet)) {
      sprite.style.backgroundImage = "";
      companionSources.set(sprite.dataset.sheet, getComputedStyle(sprite).backgroundImage);
    }
    const source = companionSources.get(sprite.dataset.sheet);
    sprite.dataset.source = source;
    const pixels = Math.max(1, Math.round(1254 * scale * window.devicePixelRatio));
    const key = source + ":" + pixels;
    if (sprite.dataset.rasterKey === key) return;
    sprite.dataset.rasterKey = key;
    sprite.style.backgroundImage = source;
    delete sprite.dataset.smoothed;
    if (!companionRasterCache.has(key)) {
      // Resample once at physical display resolution, rather than repeatedly
      // sampling the full atlas with the CSS background minification filter.
      const raster = (async function () {
        const sourceImage = new Image();
        sourceImage.src = source.slice(4, -1).replace(/^["']|["']$/g, "");
        await sourceImage.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = pixels;
        const context = canvas.getContext("2d");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(sourceImage, 0, 0, pixels, pixels);
        return canvas.toDataURL("image/png");
      })();
      companionRasterCache.set(key, raster);
    }
    companionRasterCache.get(key).then(function (url) {
      if (sprite.dataset.rasterKey !== key) return;
      sprite.style.backgroundImage = 'url("' + url + '")';
      sprite.dataset.smoothed = String(pixels);
    }).catch(function (error) {
      companionRasterCache.delete(key);
      if (sprite.dataset.rasterKey === key) delete sprite.dataset.rasterKey;
      console.warn("Companion resampling failed; keeping the source image", error);
    });
  }
  window.addEventListener("resize", function () { renderCompanion(); });
  function renderCompanion() {
    clearTimeout(companionTimer);
    const bubble = document.getElementById("companion-reaction");
    if (!state.companionAvailable || !companionSnapshot || !state.botsEnabled || !state.botVisible || document.hidden) {
      if (bubble) bubble.hidden = true;
      return;
    }
    const now = Date.now();
    const talking = !!botTalkPending || botSpeechVisible;
    const reacting = companionSnapshot.reactionUntil > now && !(talking && companionSnapshot.emotion === "sleepy");
    const asleep = !talking && now - companionSnapshot.lastInteractionAt >= 60000;
    const replyEmotion = botSpeechVisible && !botTalkPending ? botReplyEmotion : undefined;
    const emotion = replyEmotion ? replyEmotion
      : reacting ? companionSnapshot.emotion : asleep && !companionWorking ? "sleepy" : "calm";
    const positions = { happy: [0, 0], shy: [0, 1], love: [1, 1], surprised: [3, 0], playful: [2, 1], sleepy: [3, 2] };
    const sprite = factoryBot.querySelector(".companion-sprite");
    const outcome = !reacting && !companionWorking && companionOutcomeUntil > now ? companionOutcome : undefined;
    const activity = !replyEmotion ? (!reacting || emotion === "calm") && outcome !== "failed" : emotion === "calm";
    const idle = emotion === "calm" && activity && !reacting && !asleep && !companionWorking && !state.running && !outcome;
    const animateIdle = idle && state.botAnimations && !botReducedMotion.matches;
    const beats = [[0, 2800], [1, 150], [0, 1800], [2, 240], [0, 200], [3, 240], [0, 1400]];
    let phase = (now - companionSnapshot.lastInteractionAt) % 6830;
    let idleFrame = 0;
    let frameDelay = 0;
    if (animateIdle) {
      for (const [frame, duration] of beats) {
        if (phase < duration) { idleFrame = frame; frameDelay = duration - phase; break; }
        phase -= duration;
      }
    }
    const motion = replyEmotion ? "" : reacting && companionSnapshot.action === "feed" ? "eating"
      : !reacting && (companionWorking > 0 || state.running) ? "working" : "";
    let motionFrame = 0;
    if (motion && state.botAnimations && !botReducedMotion.matches) {
      const duration = motion === "working" ? 320 : 650;
      const elapsed = Math.max(0, now - companionSnapshot.lastInteractionAt);
      motionFrame = Math.floor(elapsed / duration) % 2;
      frameDelay = duration - elapsed % duration;
    }
    sprite.dataset.motion = motion;
    sprite.dataset.sheet = motion ? "work-food" : idle ? "idle" : activity ? "activities" : "emotions";
    sprite.dataset.frame = motion ? String(motionFrame) : idle ? String(idleFrame) : "";
    let position = positions[emotion] || [0, 0];
    if (activity) position = companionWorking ? [1, 0] : outcome === "completed" ? [0, 1] : asleep ? [1, 1] : [0, 0];
    else if (outcome === "failed") position = [2, 2];
    if (idle) position = [idleFrame % 2, Math.floor(idleFrame / 2)];
    if (motion) position = [motionFrame, motion === "eating" ? 1 : 0];
    // These are illustration sheets, not evenly spaced sprite atlases.
    // Exclude the next row's ear tips and preserve each source rectangle's aspect ratio.
    const rows = (activity || motion) ? [[0, 627], [627, 1254]] : [[0, 410], [414, 810], [812, 1220]];
    const sourceWidth = (activity || motion) ? 627 : 313.5;
    const sourceX = position[0] * sourceWidth;
    const sourceY = rows[position[1]][0];
    const sourceHeight = rows[position[1]][1] - sourceY;
    // Largest opaque character component, excluding floating decorative marks.
    const bodies = activity
      ? [[[98,5,525,617],[711,5,1158,627]],[[82,632,532,1223],[627,733,1217,1197]]]
      : [[[10,8,295,408],[325,13,619,405],[628,77,940,406],[952,9,1240,407]],
        [[12,437,311,797],[328,417,618,804],[646,423,933,810],[952,420,1240,803]],
        [[8,815,314,1202],[326,819,617,1206],[629,882,939,1206],[949,817,1249,1206]]];
    const idleBodies = [[[120,16,563,620],[693,16,1137,620]],[[118,633,563,1234],[692,635,1136,1234]]];
    const motionBodies = [[[88,14,559,624],[695,12,1165,625]],[[86,635,570,1235],[687,635,1168,1235]]];
    const body = (motion ? motionBodies : idle ? idleBodies : bodies)[position[1]][position[0]];
    const scale = Math.min((factoryBot.clientWidth - 4) / (body[2] - body[0]), 64 / (motion ? (motion === "working" ? 613 : 600) : idle ? 604 : body[3] - body[1]));
    sprite.style.left = ((factoryBot.clientWidth - (body[2] - body[0]) * scale) / 2 - (body[0] - sourceX) * scale) + "px";
    sprite.style.top = (factoryBot.clientHeight - (body[3] - sourceY) * scale) + "px";
    sprite.style.width = (sourceWidth * scale) + "px";
    sprite.style.height = (sourceHeight * scale) + "px";
    sprite.style.backgroundSize = (1254 * scale) + "px " + (1254 * scale) + "px";
    sprite.style.backgroundPosition = (-sourceX * scale) + "px " + (-sourceY * scale) + "px";
    smoothCompanionSheet(sprite, scale);
    factoryBot.dataset.emotion = emotion;
    factoryBot.dataset.interaction = reacting ? companionSnapshot.action : "";
    const ko = uiLocale().startsWith("ko");
    const phrases = ko ? { pet: "기분 좋아요!", praise: "칭찬해 주셔서 기뻐요!", feed: "잘 먹겠습니다!", play: "같이 놀아요!", sleep: "잠깐 쉬고 있을게요.", call: emotion === "surprised" ? "앗, 부르셨나요?" : "네, 여기 있어요!" }
      : { pet: "That feels nice!", praise: "Thank you!", feed: "Yum, thank you!", play: "Let's play!", sleep: "Time for a nap.", call: emotion === "surprised" ? "Oh! You called?" : "I'm here!" };
    bubble.textContent = reacting ? (companionWorking && motion !== "eating" ? (ko ? "조금만 기다려 주세요. 작업 중이에요!" : "One moment, I'm working!") : phrases[companionSnapshot.action]) : "";
    syncBotSpeechVisibility();
    factoryBot.title = botDisplayName() + " · " + (companionWorking ? (ko ? "작업 중 " : "Working: ") + companionWorking : emotion);
    factoryBot.setAttribute("aria-label", factoryBot.title);
    const next = reacting ? companionSnapshot.reactionUntil - now : outcome ? companionOutcomeUntil - now : 60000 - (now - companionSnapshot.lastInteractionAt);
    const delay = frameDelay > 0 ? Math.min(frameDelay, next > 0 ? next : Infinity) : next;
    if (delay > 0) companionTimer = setTimeout(function () { renderCompanion(); }, delay + 5);
  }
  botMenu.addEventListener("click", function (event) {
    const button = event.target.closest("[data-companion-action]");
    if (!button || button.disabled) return;
    if (!state.companionAvailable) {
      const action = button.dataset.companionAction;
      botIdleSince = Date.now();
      renderFactoryBot();
      state.botCare = { ...state.botCare, happiness: Math.min(100, state.botCare.happiness + (action === "call" ? 0 : 10)), careCount: state.botCare.careCount + (action === "call" ? 0 : 1) };
      clearTimeout(botGestureTimer);
      factoryBot.dataset.gesture = { pet: "shy", praise: "bow", call: "wave" }[action];
      botGestureTimer = setTimeout(function () { botGestureTimer = undefined; renderFactoryBot(); }, 5000);
      renderBotCare();
      persist();
    } else interactCompanion(button.dataset.companionAction);
    closeBotMenu(true);
  });
  factoryBot.addEventListener("pointerdown", function (event) {
    companionPetStart = { x: event.clientX, y: event.clientY };
    companionPetDistance = 0;
  });
  factoryBot.addEventListener("pointermove", function (event) {
    if (!companionPetStart || !event.buttons) return;
    companionPetDistance += Math.hypot(event.clientX - companionPetStart.x, event.clientY - companionPetStart.y);
    companionPetStart = { x: event.clientX, y: event.clientY };
  });
  factoryBot.addEventListener("pointerleave", function () { companionPetStart = undefined; });

  let botRestingSince;
  let botGestureTimer;
  const botTalkButton = document.getElementById("bot-talk");
  const botSpeech = document.getElementById("bot-speech");
  // Escape the composer's stacking context so long replies stay interactive over the timeline.
  document.body.append(botSpeech, document.getElementById("companion-reaction"));
  const botSpeechText = document.getElementById("bot-speech-text");
  let botTalkPending;
  let botTalkSequence = 0;
  let botDraftRevision = 0;
  let botSpeechVisible = false;
  const botCharacterSelect = document.getElementById("bot-character");
  let botCharacter = "factory";
  let localBotAvailable = false;
  const botPromptDrafts = new Map();
  function receiveBotCharacter(message) {
    if (typeof message.localCompanionAvailable === "boolean") localBotAvailable = message.localCompanionAvailable;
    else if (message.type === "host.initialize") localBotAvailable = message.companionAvailable !== false;
    const next = message.botCharacter || (message.type === "host.initialize" ? (message.companionAvailable === false ? "factory" : "lumi") : botCharacter);
    if (next !== botCharacter) {
      botPromptDrafts.set(botCharacter, { draft: botPromptEditor.value, saved: botPromptSaved });
      botCharacter = next;
      const cached = botPromptDrafts.get(next);
      botPromptSaved = cached?.saved || "";
      botPromptEditor.value = cached?.draft || "";
      botPromptStatus.textContent = "";
      botSpeechVisible = false;
      companionSnapshot = undefined;
      botReplyEmotion = undefined;
    }
    state.companionAvailable = next === "lumi" && localBotAvailable;
    factoryBot.classList.toggle("sd-companion", state.companionAvailable);
    botMenu.querySelectorAll("[data-companion-action]").forEach(button => { button.hidden = false; });
    botCharacterSelect.value = next;
    botCharacterSelect.disabled = !!botPromptPending || !!botTalkPending;
  }
  botCharacterSelect.addEventListener("change", () => {
    botCharacterSelect.disabled = true;
    vscode.postMessage({ type: "bot.character.save", character: botCharacterSelect.value });
  });
  const botModelSelect = document.getElementById("bot-model");
  const botModelStatus = document.getElementById("bot-model-status");
  let botModelSaved = "";
  let botModelOptions = ["gpt-5.6-luna", "claude-haiku-4-5-20251001"];
  function renderBotModels() {
    const models = ["", ...new Set([...botModelOptions, botModelSaved].filter(Boolean))];
    botModelSelect.replaceChildren(...models.map(model => {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model || t("bot.model.auto");
      return option;
    }));
    botModelSelect.value = botModelSaved;
  }
  botModelSelect.addEventListener("focus", () => vscode.postMessage({ type: "models.request" }));
  botModelSelect.addEventListener("change", function () {
    botModelSelect.disabled = true;
    botModelStatus.textContent = t("bot.prompt.saving");
    vscode.postMessage({ type: "bot.model.save", model: botModelSelect.value });
  });
  const botPromptEditor = document.getElementById("bot-prompt");
  const botPromptSave = document.getElementById("bot-prompt-save");
  const botPromptReset = document.getElementById("bot-prompt-reset");
  const botPromptStatus = document.getElementById("bot-prompt-status");
  let botPromptSaved = "";
  let botDefaultPrompt = "";
  let botPromptPending;
  let botPromptSequence = 0;

  function updateBotPromptControls() {
    botCharacterSelect.disabled = !!botPromptPending || !!botTalkPending;
    botPromptSave.disabled = !!botPromptPending || botPromptEditor.value === botPromptSaved;
    botPromptReset.disabled = !!botPromptPending || botPromptEditor.value === botDefaultPrompt;
  }
  function receiveBotPrompt(value) {
    if (typeof value !== "string") return;
    if (!botPromptPending && botPromptEditor.value === botPromptSaved) botPromptEditor.value = value;
    botPromptSaved = value;
    updateBotPromptControls();
  }
  botPromptEditor.addEventListener("input", function () {
    botPromptStatus.textContent = "";
    updateBotPromptControls();
  });
  botPromptReset.addEventListener("click", function () {
    botPromptEditor.value = botDefaultPrompt;
    botPromptEditor.dispatchEvent(new Event("input"));
    botPromptEditor.focus();
  });
  botPromptSave.addEventListener("click", function () {
    if (botPromptSave.disabled || botPromptPending) return;
    botPromptPending = { requestId: "bot-prompt-" + Date.now() + "-" + (++botPromptSequence), prompt: botPromptEditor.value, character: botCharacter };
    botPromptStatus.textContent = t("bot.prompt.saving");
    updateBotPromptControls();
    vscode.postMessage({ type: "bot.prompt.save", ...botPromptPending });
  });
  let botReactionTimer;
  let botGestureKey;
  const botPlayActivities = ["dance", "balance", "stretch", "wave", "read"];
  let botLastPlayActivity;
  let botGlanceTimer;
  let botNextGlanceAt = 0;
  const botReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let elapsedTimerId;
  let followLatest = true;
  let autoScrollFrame;
  let timelineViewportHeight;
  let timelineScrollTop = 0;
  const chatTaskFlow = globalThis.AgentFactoryChat.taskFlow({
    indexedTimeline, state, t, vscode, runStageList, selectQuestionTab, historyEmpty, runDetails,
    runStatus, runStatusToggle, runStatusAgents, runDetailsSummary, runStopButton,
    childAgentStatusLabel
  });
  const messageRenderKeys = new WeakMap();
  const eventVersions = new WeakMap();
  const managedCommandCache = new WeakMap();
  let nextEventVersion = 0;
  let botRenderKey;
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

  const chatAgentSettings = globalThis.AgentFactoryChat.agentSettings({
    state, t, fastModeButton, currentCapabilities, settingOptions, reasoningDisplayLabel, createId,
    uiLocale, normalizeModelFastModes, persist, saveComposerSettings, updateModeControls, vscode,
    modelMenu, createModeIcon, fastModeSetting, closeSettingMenu, executionModeName,
    executionModeExplanation, renderStatusBar,
    get openSettingId() { return openSettingId; },
    get chatProviders() { return chatProviders; }
  });
  globalThis.AgentFactoryI18n.apply(document, uiLocale());
  document.documentElement.lang = uiLocale();
  prompt.value = state.draft;
  renderAll();
  resizePrompt();
  vscode.postMessage({ type: "client.ready" });
  const restoreImages = state.attachments.filter(function (item) { return item.kind === "image"; })
    .map(function (item) { return { id: item.id, name: item.name, target: "composer" }; });
  for (const event of [...state.timeline, ...state.pendingRequests]) {
    for (const item of Array.isArray(event.attachments) ? event.attachments : []) {
      if (item.kind === "image" && restoreImages.length < 100) restoreImages.push({ id: item.id, name: item.name, target: "history" });
    }
  }
  if (restoreImages.length) vscode.postMessage({ type: "attachments.restore", attachments: restoreImages });

  runStatusToggle.addEventListener("click", function () {
    state.runPanelExpanded = !state.runPanelExpanded;
    chatTaskFlow.renderWorkLoopPanel();
    if (state.runPanelExpanded && state.role === "main") {
      vscode.postMessage({ type: "agents.request" });
    }
    persist();
  });
  runStopButton.addEventListener("click", () => cancelRun());

  let syntaxThemeClass = document.body.className;
  new MutationObserver(function () {
    const nextThemeClass = document.body.className;
    if (nextThemeClass === syntaxThemeClass) return;
    syntaxThemeClass = nextThemeClass;
    chatSyntax.syntaxRevision += 1;
    renderTimeline();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  document.addEventListener("pointermove", maybeGlanceAtPointer, { passive: true });
  document.documentElement.addEventListener("pointerleave", clearBotGlance);
  window.addEventListener("blur", clearBotGlance);
  document.addEventListener("visibilitychange", function () {
    clearBotGlance();
    if (document.hidden) {
      botRestingSince = Date.now();
      persist();
    } else if (botRestingSince !== undefined && !companionSnapshot) {
      state.botCare = { ...state.botCare,
        energy: Math.min(100, state.botCare.energy + Math.max(0, Date.now() - botRestingSince) / 30000),
        updatedAt: Date.now() };
      botRestingSince = undefined;
    }
    document.documentElement.dataset.afHidden = String(document.hidden);
    if (document.hidden && elapsedTimerId) {
      clearInterval(elapsedTimerId);
      elapsedTimerId = undefined;
    }
    renderFactoryBot();
    if (!document.hidden) renderRunStatus();
  });
  botReducedMotion.addEventListener("change", function () { clearBotGlance(); renderFactoryBot(); });
  factoryBot.addEventListener("pointerenter", wakeFactoryBot);

  function closeBotMenu(restoreFocus = false) {
    clearTimeout(botCareTimer); botCareTimer = undefined;
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
  window.addEventListener("resize", function () { positionBotSpeech(); positionAboveCompanion(document.getElementById("companion-reaction")); });
  function talkToBot() {
    if (botTalkButton.disabled || botTalkPending || !state.botsEnabled || !prompt.value.trim()) return;
    startBotConversation(prompt.value, true);
  }
  function startBotConversation(text, fromComposer) {
    if (botTalkPending || !state.botsEnabled || !text.trim()) return;
    botReplyEmotion = undefined;
    botTalkPending = { requestId: "bot-" + Date.now() + "-" + (++botTalkSequence),
      text, fromComposer, revision: botDraftRevision };
    if (fromComposer) {
      prompt.value = "";
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    }
    botTalkPending.revision = botDraftRevision;
    persist();
    closeBotMenu();
    prompt.focus({ preventScroll: true });
    showBotSpeech(t("bot.thinking"));
    renderBotTalk();
    vscode.postMessage({ type: "bot.talk", requestId: botTalkPending.requestId, text: botTalkPending.text });
  }
  botTalkButton.addEventListener("click", talkToBot);
  function matchesShortcut(event, binding) {
    return !!binding && !shortcutComposing(event) && shortcutFromEvent(event) === binding;
  }
  function shortcutLabel(binding) {
    return binding ? binding.split("+").map(part => shortcutKeyNames[part] || part).join(" + ") : t("ui.shortcuts.none");
  }
  function shortcutAria(binding) {
    if (!binding) return "";
    const keys = binding.split("+").map(part => part === "Space" ? "Space" : part === "Plus" ? "+" : part);
    return keys.includes("Mod") ? ["Control", "Meta"].map(mod => keys.map(part => part === "Mod" ? mod : part).join("+")).join(" ") : keys.join("+");
  }
  function shortcutButton(text, handler, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    if (className) button.className = className;
    button.addEventListener("click", handler);
    return button;
  }
  function renderShortcutRow(action) {
      const row = document.createElement("div");
      row.id = action.id === "bot" ? "bot-talk-shortcut-row" : "shortcut-row-" + action.id;
      row.dataset.shortcutAction = action.id;
      row.hidden = !!action.bot && !state.botsAvailable;
      const term = document.createElement("dt"), detail = document.createElement("dd");
      const label = document.createElement("label");
      label.textContent = action.label();
      term.append(label);
      const recording = shortcutRecording?.id === action.id;
      const value = document.createElement("kbd");
      value.className = "shortcut-binding";
      value.id = "shortcut-" + action.id;
      value.dataset.binding = recording ? shortcutRecording.binding || "" : shortcuts[action.id];
      if (recording) {
        row.dataset.recording = shortcutRecording.binding ? "pending" : "listening";
        value.textContent = shortcutRecording.binding ? shortcutLabel(shortcutRecording.binding) : t("ui.shortcuts.recording");
        const confirm = shortcutButton(t("ui.shortcuts.confirm"), confirmShortcut, "shortcut-confirm");
        confirm.disabled = !shortcutRecording.binding || !!shortcutRecording.problem;
        detail.append(value, confirm, shortcutButton(t("ui.shortcuts.cancel"), () => cancelShortcut(true), "shortcut-cancel"));
      } else {
        const change = shortcutButton(t("ui.shortcuts.change"), () => startShortcut(action.id), "shortcut-change");
        change.setAttribute("aria-label", t("ui.shortcuts.change.named", action.label()));
        value.textContent = shortcutLabel(shortcuts[action.id]);
        detail.append(value, change);
        if (!action.required) {
          const clear = shortcutButton(t("ui.shortcuts.clear"), () => clearShortcut(action.id), "shortcut-clear");
          clear.disabled = !shortcuts[action.id];
          clear.setAttribute("aria-label", t("ui.shortcuts.clear.named", action.label()));
          detail.append(clear);
        }
      }
      label.htmlFor = value.id;
      row.append(term, detail);
      return row;
  }
  function renderShortcuts() {
    shortcutList.replaceChildren(...shortcutGroups.map(group => {
      const section = document.createElement("section");
      section.className = "shortcut-group";
      section.dataset.shortcutGroup = group.id;
      section.hidden = !!group.bot && !state.botsAvailable;
      const heading = document.createElement("h3");
      heading.id = "shortcut-group-" + group.id;
      heading.textContent = group.label();
      const list = document.createElement("dl");
      list.className = "settings-shortcuts";
      list.setAttribute("aria-labelledby", heading.id);
      list.append(...shortcutActions.filter(action => action.group === group.id).map(renderShortcutRow));
      section.append(heading, list);
      return section;
    }));
    const sendLabel = shortcutLabel(shortcuts.send);
    sendButton.title = t("ui.send.message") + " (" + sendLabel + ")";
    for (const [button, action] of [[sendButton, "send"], [botTalkButton, "bot"]]) {
      if (shortcuts[action]) button.setAttribute("aria-keyshortcuts", shortcutAria(shortcuts[action]));
      else button.removeAttribute("aria-keyshortcuts");
    }
    for (const action of shortcutActions.filter(action => action.button)) {
      const button = botMenu.querySelector(action.button);
      if (shortcuts[action.id]) button.setAttribute("aria-keyshortcuts", shortcutAria(shortcuts[action.id]));
      else button.removeAttribute("aria-keyshortcuts");
    }
    if (shortcuts.botMenu) factoryBot.setAttribute("aria-keyshortcuts", shortcutAria(shortcuts.botMenu));
    else factoryBot.removeAttribute("aria-keyshortcuts");
  }
  function focusShortcutControl(id, selector) {
    document.querySelector('[data-shortcut-action="' + id + '"] ' + selector)?.focus({ preventScroll: true });
  }
  function startShortcut(id) {
    shortcutRecording = { id: id };
    shortcutStatus.textContent = id === "close" ? t("ui.shortcuts.recording.plain") : t("ui.shortcuts.recording.hint", shortcutLabel(shortcuts.close));
    renderShortcuts();
    focusShortcutControl(id, ".shortcut-cancel");
  }
  function cancelShortcut(restoreFocus) {
    if (!shortcutRecording) return;
    const id = shortcutRecording.id;
    shortcutRecording = undefined;
    shortcutStatus.textContent = t("ui.shortcuts.scope");
    renderShortcuts();
    if (restoreFocus) focusShortcutControl(id, ".shortcut-change");
  }
  function confirmShortcut() {
    if (!shortcutRecording?.binding || shortcutRecording.problem) return;
    const id = shortcutRecording.id;
    shortcuts[id] = shortcutRecording.binding;
    shortcutRecording = undefined;
    shortcutStatus.textContent = t("ui.shortcuts.saved", shortcutLabel(shortcuts[id]));
    renderShortcuts();
    persist();
    focusShortcutControl(id, ".shortcut-change");
  }
  function clearShortcut(id) {
    shortcuts[id] = "";
    shortcutStatus.textContent = t("ui.shortcuts.scope");
    renderShortcuts();
    persist();
    focusShortcutControl(id, ".shortcut-change");
  }
  // Capture before every other handler so recorded keys never trigger actions.
  document.addEventListener("keydown", function (event) {
    if (!shortcutRecording) return;
    const listening = !shortcutRecording.binding;
    // The close shortcut cancels, except while recording the close shortcut itself.
    if (shortcutRecording.id !== "close" && shortcutFromEvent(event) === shortcuts.close && !shortcutComposing(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelShortcut(true);
      return;
    }
    if (!listening || shortcutComposing(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const binding = shortcutFromEvent(event);
    if (!binding || event.repeat) return;
    const action = shortcutActions.find(item => item.id === shortcutRecording.id);
    const problem = shortcutProblem(action, binding);
    if (problem) { shortcutStatus.textContent = t(problem); return; }
    const owner = shortcutActions.find(item => item.id !== action.id && shortcuts[item.id] === binding);
    shortcutRecording.binding = binding;
    shortcutRecording.problem = owner ? "conflict" : "";
    shortcutStatus.textContent = owner ? t("ui.shortcuts.conflict.named", owner.label()) : t("ui.shortcuts.pending", shortcutLabel(binding));
    renderShortcuts();
    focusShortcutControl(action.id, owner ? ".shortcut-cancel" : ".shortcut-confirm");
  }, true);
  document.addEventListener("pointerdown", function (event) {
    if (shortcutRecording && !event.target.closest?.('[data-shortcut-action="' + shortcutRecording.id + '"]')) cancelShortcut(false);
  }, true);
  document.getElementById("shortcuts-reset").addEventListener("click", () => {
    shortcutRecording = undefined;
    for (const action of shortcutActions) shortcuts[action.id] = action.fallback;
    shortcutStatus.textContent = t("ui.shortcuts.scope");
    renderShortcuts();
    persist();
  });
  function runShortcut(action) {
    if (action.submit) {
      const { action: mode, workflow, goal } = action.submit;
      if (submissionOptionDisabled(mode, goal)) return;
      closeSettingMenu(false);
      submit(mode, workflow, goal);
      return;
    }
    if (action.history) {
      const details = document.getElementById(action.history);
      if (details.hidden) return;
      if (openSettingId !== "submission") openSetting("submission");
      details.open = true;
      details.querySelector("summary").focus({ preventScroll: true });
      return;
    }
    if (action.questionTab) {
      if (state.role !== "main") return;
      openQuestionMenu(action.questionTab);
      return;
    }
    if (action.id === "botMenu") { factoryBot.click(); return; }
    const button = botMenu.querySelector(action.button);
    if (!button || button.disabled || button.hidden) return;
    // Menu actions restore focus to the bot; a shortcut keeps the Human's place.
    const focused = document.activeElement;
    button.click();
    if (focused && focused !== document.body && document.contains(focused)) focused.focus({ preventScroll: true });
  }
  function runGlobalShortcut(event, action) {
    if (document.querySelector("dialog[open]")) return false;
    if (action.bot && (!state.botsEnabled || factoryBot.hidden)) return false;
    event.preventDefault();
    if (!event.repeat) runShortcut(action);
    return true;
  }
  function moveFocus(step) {
    const root = document.querySelector("dialog[open]") || document;
    const items = [...root.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")].filter(item =>
      !item.disabled && item.tabIndex >= 0 && !item.closest("[hidden], [inert]") && item.getClientRects().length);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    items[index < 0 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length].focus();
  }
  function emulateEscape() {
    const target = document.activeElement || document.body;
    const escape = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
    if (!target.dispatchEvent(escape)) return;
    const dialog = document.querySelector("dialog[open]");
    if (dialog && dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
  }
  // Routes trusted keys first: rebound basic controls, displaced default keys
  // and every chat-wide action.
  window.addEventListener("keydown", function (event) {
    if (shortcutRecording || !event.isTrusted || shortcutComposing(event)) return;
    const binding = shortcutFromEvent(event);
    if (!binding) return;
    const action = shortcutActions.find(item => shortcuts[item.id] === binding);
    if (action?.native) {
      if (binding === action.native) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action.id === "close") { if (!event.repeat) emulateEscape(); }
      else moveFocus(action.id === "focusNext" ? 1 : -1);
      return;
    }
    const displaced = shortcutActions.some(item => item.native === binding);
    if (action && !action.scope) {
      if (runGlobalShortcut(event, action) && displaced) event.stopImmediatePropagation();
      return;
    }
    if (displaced && !action) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  prompt.addEventListener("keydown", function (event) {
    if (!matchesShortcut(event, shortcuts.bot)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) talkToBot();
  }, true);
  renderShortcuts();
  document.getElementById("bot-speech-close").addEventListener("click", function () {
    botSpeechVisible = false;
    renderBotTalk();
    prompt.focus({ preventScroll: true });
  });

  function showBotSpeech(text) {
    botSpeechText.textContent = text;
    botSpeechVisible = true;
    renderBotTalk();
  }

  function positionBotSpeech() {
    if (botSpeech.hidden) return;
    const box = factoryBot.getBoundingClientRect();
    botSpeech.style.width = Math.min(300, window.innerWidth - 16) + "px";
    botSpeech.style.maxHeight = Math.max(1, box.top - 16) + "px";
    botSpeechText.style.maxHeight = Math.max(1, box.top - 42) + "px";
    positionAboveCompanion(botSpeech);
  }
  function positionAboveCompanion(bubble) {
    if (bubble.hidden) return;
    const box = factoryBot.getBoundingClientRect();
    bubble.style.maxHeight = Math.max(1, box.top - 16) + "px";
    bubble.style.left = Math.max(8, Math.min(window.innerWidth - bubble.offsetWidth - 8, box.right - bubble.offsetWidth)) + "px";
    bubble.style.top = Math.max(8, box.top - bubble.offsetHeight - 8) + "px";
    bubble.dataset.placement = "above";
  }

  // Conversation owns the speech surface while thinking or showing an answer.
  // Consume suppressed greetings so closing the answer cannot bring them back.
  function syncBotSpeechVisibility() {
    const reaction = document.getElementById("companion-reaction");
    const until = companionSnapshot?.reactionUntil || 0;
    if (botTalkPending || botSpeechVisible) {
      companionReactionDismissedUntil = Math.max(companionReactionDismissedUntil, until);
    }
    reaction.hidden = !botVisualsActive() || !!botTalkPending || botSpeechVisible ||
      until <= Math.max(Date.now(), companionReactionDismissedUntil);
    positionAboveCompanion(reaction);
  }

  function botDisplayName() {
    return t(state.companionAvailable ? "bot.name.lumi" : "bot.name.factory");
  }

  function renderBotIdentity() {
    renderBotModels();
    const name = botDisplayName();
    botMenu.querySelector("strong").textContent = t("bot.named.care", name);
    botMenu.setAttribute("aria-label", t("bot.named.care", name));
    document.getElementById("settings-tab-bot").textContent = t("ui.bot");
    document.getElementById("bot-current-character").textContent = t("bot.current.character", name);
    botPromptEditor.setAttribute("aria-label", t("bot.named.prompt", name));
    renderShortcuts();
  }

  function renderBotTalk() {
    const label = t("bot.named.talk", botDisplayName());
    botTalkButton.querySelector('[data-i18n="bot.talk"]').textContent = label;
    botTalkButton.setAttribute("aria-label", label);
    botTalkButton.title = label;
    botCharacterSelect.disabled = !!botPromptPending || !!botTalkPending;
    botTalkButton.disabled = !state.botsEnabled || !prompt.value.trim() || !!botTalkPending;
    botSpeech.hidden = !botSpeechVisible || !botVisualsActive();
    syncBotSpeechVisibility();
    positionBotSpeech();
    renderCompanion();
  }
  document.addEventListener("pointerdown", function (event) {
    if (!botMenu.contains(event.target) && !factoryBot.contains(event.target)) closeBotMenu();
  });
  const chatNotes = globalThis.AgentFactoryChat.notes({
    saved, persist, vscode, prompt, t
  });

  const chatHistory = globalThis.AgentFactoryChat.history({
    handleSettingMenuKeydown, vscode, submissionMenu, questionButton, t, closeQuestionMenu,
    renderAssistantMarkdown: chatMarkdown.renderAssistantMarkdown, assistantDisplayText, historyEmpty
  });

  function historyEmpty(key) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = t(key);
    return empty;
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !botSpeech.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      botSpeechVisible = false;
      renderBotTalk();
      factoryBot.focus();
      return;
    }
    if (event.key === "Escape" && !botMenu.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeBotMenu(true);
    }
  }, true);
  botMenu.addEventListener("click", function (event) {
    const button = event.target.closest("[data-bot-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.botAction;
    if (action === "play" && botTalkPending) return;
    if (state.companionAvailable && ["feed", "play", "sleep"].includes(action)) {
      interactCompanion(action);
      closeBotMenu(true);
      if (action === "play") startBotConversation(t("bot.play.prompt"), false);
      return;
    }
    if (!["feed", "play", "sleep"].includes(action)) return;
    updateBotCare();
    const care = state.botCare;
    state.botCare = { ...care,
      fullness: Math.min(100, care.fullness + (action === "feed" ? 25 : 0)),
      happiness: Math.min(100, care.happiness + (action === "play" ? 20 : action === "feed" ? 5 : 0)),
      energy: Math.max(0, care.energy - (action === "play" ? 5 : 0)),
      careCount: care.careCount + 1 };
    closeBotMenu(true);
    clearBotGlance();
    clearTimeout(botGestureTimer);
    botGestureTimer = undefined;
    if (action === "sleep") {
      botIdleSince = Date.now() - 60000;
      renderFactoryBot();
    } else {
      let gesture = action;
      if (action === "play") {
        const choices = botPlayActivities.filter(activity =>
          activity !== botLastPlayActivity && activity !== factoryBot.dataset.gesture);
        gesture = choices[Math.floor(Math.random() * choices.length)];
        botLastPlayActivity = gesture;
      }
      delete factoryBot.dataset.gesture;
      factoryBot.getBoundingClientRect();
      factoryBot.dataset.gesture = gesture;
      botGestureTimer = window.setTimeout(function () {
        botGestureTimer = undefined;
        renderFactoryBot();
      }, 8000);
    }
    renderBotCare();
    persist();
    if (action === "play") startBotConversation(t("bot.play.prompt"), false);
  });
  factoryBot.addEventListener("click", function () {
    const pet = companionPetStart && companionPetDistance >= 20;
    companionPetStart = undefined;
    if (pet) { interactCompanion("pet"); return; }
    const opening = botMenu.hidden;
    wakeFactoryBot();
    clearTimeout(botReactionTimer);
    delete factoryBot.dataset.reacting;
    botMenu.hidden = !opening;
    if (opening) { botSpeechVisible = false; renderBotTalk(); }
    renderBotCare();
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
    botDraftRevision++;
    renderBotTalk();
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
    if (shortcuts.newLine !== "Shift+Enter" && !shortcutComposing(event) && shortcutFromEvent(event) === "Shift+Enter" &&
      !shortcutActions.some(action => action.scope === "prompt" && shortcuts[action.id] === "Shift+Enter")) {
      event.preventDefault();
      return;
    }
    if (shortcuts.newLine !== "Shift+Enter" && matchesShortcut(event, shortcuts.newLine)) {
      event.preventDefault();
      if (!document.execCommand("insertText", false, "\n")) {
        prompt.setRangeText("\n", prompt.selectionStart, prompt.selectionEnd, "end");
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    if (
      matchesShortcut(event, shortcuts.send) &&
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
    // Let the native picker return to the existing draft and selection.
    prompt.focus({ preventScroll: true });
    document.getElementById("attachment-file-input").click();
  });
  document.getElementById("attachment-file-input").addEventListener("change", async function (event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    await addBrowserFiles(files);
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
    const distance = timeline.scrollHeight - timeline.clientHeight - top;
    if (top < timelineScrollTop && distance > 1) {
      // Clamping and anchoring keep the bottom; moving away from it is a reader scrolling up.
      followLatest = false;
    } else if (timelineViewportHeight === timeline.clientHeight) {
      // Layout changes can emit scroll events before ResizeObserver runs.
      // Preserve the previous follow intent until the new viewport is handled.
      followLatest = distance <= 24;
    }
    timelineScrollTop = top;
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
      if (chatWorkUnits.unitDialog.open || document.getElementById("image-converter").open) return;
      if (!chatNotes.notesPanel.hidden) {
        event.preventDefault();
        chatNotes.setNotesOpen(false);
        return;
      }
      // Let the native picker consume Escape before closing its settings dialog.
      if (CSS.supports("selector(select:open)") && document.querySelector("#model-menu select:open, #status-settings select:open")) return;
      if (!statusSettings.hidden) { event.preventDefault(); closeStatusSettings(); return; }
      if (document.getElementById("conversation-reader").open) return;
      const history = document.querySelector(".task-history[open]") || document.getElementById("task-history");
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
      // A fresh press retries a cancellation that did not stop the run.
      if (!event.repeat) cancelRun(true);
    }
  });

  document.addEventListener("click", function (event) {
    const history = document.getElementById("task-history");
    if (!event.target.closest("#task-history")) history.open = false;
    if (!event.target.closest("#contract-list")) chatHistory.contractList.open = false;
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
    let images = Array.from(event.clipboardData.files || []).filter(function (file) {
      return Boolean(browserImageMediaType(file));
    });
    // Some screenshot tools expose the image only as a clipboard item, leaving files empty.
    if (!images.length) images = Array.from(event.clipboardData.items || []).filter(function (item) {
      return item.kind === "file";
    }).map(function (item) { return item.getAsFile(); }).filter(function (file) {
      return file && browserImageMediaType(file);
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
          const scopeControl = document.getElementById("agent-default-scope");
          if (scopeControl && state.agentSettingsScope) scopeControl.value = state.agentSettingsScope;
        }
        const status = document.getElementById("agent-preset-status"); status.hidden = !message.error; status.textContent = message.error || "";
        if (!message.error && chatAgentSettings.pendingPresetAction === "save") {
          document.getElementById("agent-preset-create").open = false;
          document.getElementById("agent-preset-name").value = "";
        }
        chatAgentSettings.pendingPresetAction = "";
        if (!message.error && message.settings && message.scope && message.name) chatAgentSettings.applyAgentSettingsToChat(message.settings, message.scope, message.name);
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
        if (state.agentSettingsScope === "project" && !message.settings.projectAvailable) state.agentSettingsScope = "global";
        if (!state.agentSettingsScope) state.agentSettingsScope = message.settings.projectAvailable ? "project" : "global";
        chatAgentSettings.renderAgentDefaults();
        // Existing chat values are an independent snapshot and do not follow later default changes.
        updateModeControls();
        break;
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
        if (!state.running) state.cancellationRequested = false;
        state.model = normalizeModel(message.model);
        state.agentModels = message.agentModels || state.agentModels || {};
        state.modelFastModes = normalizeModelFastModes(message.modelFastModes || state.modelFastModes);
        state.reasoning = normalizeSettingValue(message.reasoning, settingOptions.reasoning);
        state.agentSettingsScope = ["global", "project", "chat"].includes(message.agentSettingsScope) ? message.agentSettingsScope : state.agentSettingsScope;
        state.agentSettingsSet = typeof message.agentSettingsSet === "string" && message.agentSettingsSet.trim() ? message.agentSettingsSet.trim() : state.agentSettingsSet;
        state.businessMode = "normal";
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
            if (!message.pendingMessageIds.includes(item.id)) item.rejected = true;
          }
        }
        if (state.running && !state.runStartedAt) {
          state.runStartedAt = Date.now();
        } else if (!state.running) {
          state.runStartedAt = undefined;
          if (chatTaskFlow.currentTaskFlows().length === 0) state.runPanelExpanded = false;
        }
        state.botsAvailable = message.botsAvailable !== false;
        state.companionAvailable = message.companionAvailable !== false;
        if (!state.companionAvailable) companionSnapshot = undefined;
        factoryBot.classList.toggle("sd-companion", state.companionAvailable);
        botMenu.querySelectorAll("[data-companion-action]").forEach(button => { button.hidden = false; });
        state.botsEnabled = state.botsAvailable && message.botsEnabled !== false;
        document.getElementById("settings-tab-bot").style.display = state.botsAvailable ? "" : "none";
        renderShortcuts();
        receiveBotCharacter(message);
        if (typeof message.botDefaultPrompt === "string") botDefaultPrompt = message.botDefaultPrompt;
        receiveBotPrompt(message.botPrompt);
        if (typeof message.botModel === "string") botModelSaved = message.botModel;
        renderBotModels();
        state.statusItems = normalizeStatusItems(message.statusItems);
        updateModeControls();
        vscode.postMessage({ type: "providers.request" });
        if (state.agentId && state.role === "main") vscode.postMessage({ type: "goal.control", action: "get" });
        renderTimeline();
        renderStatusBar();
        renderStatusCatalog();
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
        renderStatusBar();
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
        // The conversation's provider decides which model routes remain selectable.
        if (openSettingId === "model") renderSettingMenu("model", modelMenu);
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
        renderStatusBar();
        break;
      case "models.list":
        if (Array.isArray(message.models)) {
          botModelOptions = message.models.filter(model => /^(gpt-|codex-|claude-)[A-Za-z0-9._-]+$/.test(model));
          renderBotModels();
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
        void encodeAttachmentImage(message);
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
          renderStatusBar();
          botOutcome = "failed"; renderFactoryBot();
        }
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
      case "conversation.clearing":
        setConversationClearing(message.busy === true);
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
      case "notes.list.result":
      case "notes.save.result":
        chatNotes.receiveNotes(message);
        break;
      case "contracts.list": {
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
          metadata.textContent = contract.id + " · v" + contract.version;
          button.title = contract.title + " · " + metadata.textContent;
          button.append(title, metadata);
          button.addEventListener("click", () => vscode.postMessage({ type: "contract.open", id: contract.id }));
          list.append(button);
        }
        chatHistory.positionTaskHistory();
        break;
      }
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
          state.historyNextBefore = message.history.nextBefore;
          const restored = message.history.messages.filter(function (item) {
            return item && ["user", "assistant", "interview"].includes(item.type) &&
              typeof item.id === "string" && typeof item.runId === "string" && typeof item.text === "string";
          });
          if (!state.timeline.some(function (item) { return ["user", "assistant", "interview", "activity"].includes(item.type); })) {
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
          updateModeControls();
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
          for (const snapshot of message.workflows) {
            snapshots.set(key(snapshot), snapshot);
            // The decision took effect once the loop left its stop; a refresh of the same stop changes nothing.
            if (snapshot.status !== "needs-human-decision") chatTaskFlow.workflowDecisionsPending.delete(snapshot.loopId);
          }
          state.workflows = [...snapshots.values()].slice(-100);
        }
        state.childAgents = Array.isArray(message.agents) ? message.agents.filter(isChildAgent) : [];
        state.workUnits = summarizeChildAgents(state.childAgents);
        renderAgentsList();
        renderRunStatus();
        chatTaskFlow.renderWorkLoopPanel();
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
        renderStatusBar();
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
          const key = message.runId + "\u0000" + message.stream + "\u0000" + message.id;
          const entry = state.timeline.find(function (item) { return item.streaming && item.streamKey === key; });
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
        receiveBotCharacter(message);
        if (typeof message.botDefaultPrompt === "string") botDefaultPrompt = message.botDefaultPrompt;
        receiveBotPrompt(message.botPrompt);
        if (typeof message.botModel === "string") botModelSaved = message.botModel;
        renderBotModels();
        renderFactoryBot();
        break;
      case "bot.reply.partial":
        if (state.botsEnabled && botTalkPending && message.requestId === botTalkPending.requestId && typeof message.text === "string") {
          botSpeechText.textContent = message.text;
          renderBotTalk();
        }
        break;
      case "bot.reply": {
        if (!state.botsEnabled || !botTalkPending || message.requestId !== botTalkPending.requestId) break;
        const pending = botTalkPending;
        botTalkPending = undefined;
        const success = message.failed !== true && typeof message.text === "string" && message.text.trim().length > 0;
        if (!success && pending.fromComposer && prompt.value === "" && botDraftRevision === pending.revision) {
          prompt.value = pending.text;
          prompt.dispatchEvent(new Event("input", { bubbles: true }));
          persist();
        }
        botReplyEmotion = success && ["calm", "happy", "shy", "love", "surprised", "playful", "sleepy"].includes(message.emotion) ? message.emotion : undefined;
        const replyMoods = { calm: "calm", happy: "cheerful", shy: "curious", love: "cheerful", surprised: "curious", playful: "cheerful", sleepy: "calm" };
        if (botReplyEmotion) factoryBot.dataset.mood = replyMoods[botReplyEmotion];
        showBotSpeech(success ? message.text : t("bot.talk.failed"));
        renderFactoryBot();
        break;
      }
      case "bot.model.saved":
        botModelSelect.disabled = false;
        botModelSaved = message.model;
        renderBotModels();
        botModelStatus.textContent = t(message.failed ? "bot.model.failed" : "bot.prompt.saved");
        break;
      case "bot.prompt.saved": {
        if (!botPromptPending || message.requestId !== botPromptPending.requestId) break;
        const submitted = botPromptPending;
        botPromptPending = undefined;
        if (submitted.character !== botCharacter) {
          if (!message.failed) botPromptDrafts.set(submitted.character, { draft: submitted.prompt, saved: submitted.prompt });
          updateBotPromptControls();
          break;
        }
        if (!message.failed && typeof message.prompt === "string") {
          botPromptSaved = message.prompt;
          if (botPromptEditor.value === submitted.prompt) botPromptEditor.value = message.prompt;
          botPromptStatus.textContent = t("bot.prompt.saved");
        } else botPromptStatus.textContent = t("bot.prompt.failed");
        updateBotPromptControls();
        break;
      }
      case "bot.companion":
        if (!state.companionAvailable) break;
        companionSnapshot = message.companion;
        companionWorking = message.working;
        companionOutcome = message.outcome;
        companionOutcomeUntil = message.outcomeUntil || 0;
        state.botCare = { ...companionSnapshot };
        botIdleSince = companionSnapshot.lastInteractionAt;
        renderFactoryBot();
        break;
      case "bot.mood":
        if (!state.botsEnabled || (botSpeechVisible && botReplyEmotion)) break;
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
        renderPendingQueue();
        state.queueCount = safeCount(message.count);
        chatWorkUnits.renderWorktree();
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
        state.fiveHourUsedPercent = safePercentOrUndefined(message.fiveHourUsedPercent);
        state.weeklyResetsAt = safeResetsAtOrUndefined(message.weeklyResetsAt);
        state.fiveHourResetsAt = safeResetsAtOrUndefined(message.fiveHourResetsAt);
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
    const message = {
      id: createId(),
      text,
      attachments: (choiceAnswer === null ? state.attachments : []).map(function (attachment) {
        const { previewUri, pending, ...reference } = attachment;
        return reference;
      }),
      execution: {
        ...(state.role === "main" ? { taskMode: action, businessMode: workflow } : {}),
        agentModels: state.role === "main" ? chatAgentSettings.effectiveDelegatedModels() : undefined,
        agentPermissions: state.role === "main" ? Object.fromEntries(["main", "work", "verification"].map(role => [role, state.executionMode || "cli-default"])) : undefined,
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
    if (event.type === "interview") {
      const position = indexedTimeline().positions.get(event.id);
      if (position === undefined || state.timeline.slice(position + 1).some(item => item.type === "user" || item.type === "interview")) return false;
      return !event.choiceAnswer && !state.running && !state.pendingRequests?.length && state.runtimeAvailable;
    }
    return indexedTimeline().latestTurn === event && !event.choiceAnswer && !state.running && !state.pendingRequests?.length && state.runtimeAvailable;
  }

  function renderStructuredInterview(content, event) {
    const question = event.question;
    if (!question || !Array.isArray(question.options)) return;
    const korean = /[가-힣]/.test(question.text + question.options.map(option => option.label + option.pros + option.cons).join(""));
    const heading = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = (korean ? "질문" : "Question") + ` [${question.current}/${question.total}]: ` + question.text;
    heading.append(strong);
    const table = document.createElement("table");
    table.className = "interview-options";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of (korean ? ["선택지", "결정", "장점", "단점"] : ["Option", "Decision", "Advantages", "Disadvantages"])) {
      const cell = document.createElement("th");
      cell.textContent = label;
      headRow.append(cell);
    }
    head.append(headRow);
    table.append(head);
    const body = document.createElement("tbody");
    for (const [index, option] of question.options.entries()) {
      const row = document.createElement("tr");
      const choice = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "interview-choice";
      button.textContent = question.yesNo ? option.label : String(index + 1);
      button.setAttribute("aria-label", `${index + 1}: ${option.label}`);
      button.disabled = !canAnswerInterview(event);
      button.addEventListener("click", function () {
        if (!canAnswerInterview(event)) return;
        if (submit("direct", "normal", false, option.value)) {
          event.choiceAnswer = option.value;
          renderAll();
          persist();
        }
      });
      choice.append(button);
      row.append(choice);
      for (const value of [option.label, option.pros, option.cons]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    table.append(body);
    content.append(heading, table);
    const recommended = question.options.find(option => option.value === question.recommendedValue);
    if (recommended) {
      const note = document.createElement("p");
      const label = document.createElement("strong");
      label.textContent = korean ? "권고: " : "Recommendation: ";
      note.append(label, recommended.label);
      content.append(note);
    }
  }

  function renderInterviewChoices(content, event) {
    if (event.phase === "commentary") return;
    for (const table of content.querySelectorAll("table")) {
      // Explanatory paragraphs may separate an explicitly designated question and its table.
      let preceding = table.previousElementSibling;
      let designated = false;
      while (preceding && /^(?:P|H[1-6])$/.test(preceding.tagName)) {
        const heading = preceding.textContent.trim();
        if (/^(?:질문|Question)\s*\[\d+\s*\/\s*\d+(?:\s*,[^\]\n]+)?\]\s*:/i.test(heading)) {
          designated = true;
          break;
        }
        if (/^H[1-6]$/.test(preceding.tagName) || /^(?:권고|이전 결정|Recommendation|Previous decision)\s*:/i.test(heading)) break;
        preceding = preceding.previousElementSibling;
      }
      if (!designated) continue;
      if (!/^(?:선택지?|Option)$/i.test(table.querySelector("th")?.textContent.trim() || "")) continue;
      const rows = Array.from(table.querySelectorAll("tbody tr"));
      if (rows.length < 2 || rows.length > 3 || rows.some((row, index) => row.cells[0]?.textContent.trim() !== String(index + 1))) continue;
      table.classList.add("interview-options");
      const yesNo = rows.length === 2 && rows[0].cells[1]?.textContent.trim() === "Yes" && rows[1].cells[1]?.textContent.trim() === "No";
      for (const row of rows) {
        const number = row.cells[0].textContent.trim();
        const button = document.createElement("button");
        button.type = "button";
        button.className = "interview-choice";
        button.textContent = yesNo ? row.cells[1].textContent.trim() : number;
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
    renderStatusBar();
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
      index = { id: ++nextTimelineIndex, length: 0, activities: new Map(), positions: new Map(), questions: [], latestTurn: undefined, flows: new Map(), flowRevision: 0 };
      timelineIndexes.set(state.timeline, index);
    }
    // Existing entries keep their type/turn identity; ingestion replaces the array
    // for history merges and resets. Append-only updates visit only the new tail.
    for (; index.length < state.timeline.length; index.length++) {
      const event = state.timeline[index.length];
      const type = event.type;
      if (!index.positions.has(event.id)) index.positions.set(event.id, index.length);
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

  // A complete message supersedes the oldest live preview of the same run and phase whose text it extends.
  function liveAssistantPreview(complete) {
    const normalize = function (text) { return String(text || "").replace(/\s+/g, " ").trim(); };
    const full = normalize(complete.text);
    return state.timeline.findIndex(function (entry) {
      return entry.streaming && entry.runId === complete.runId && entry.phase === complete.phase &&
        (complete.phase === "final" || full.startsWith(normalize(entry.text)));
    });
  }

  // Growing previews re-render only their own content once per frame instead of the whole timeline.
  const pendingPreviews = new Set();
  let previewFrame;
  function schedulePreviewRender(entry) {
    pendingPreviews.add(entry);
    if (previewFrame !== undefined || document.hidden) return;
    previewFrame = requestAnimationFrame(function () {
      previewFrame = undefined;
      let rendered = false;
      for (const item of pendingPreviews) {
        const element = messageElements.get(item.id);
        const key = element && messageRenderKeys.get(element);
        const content = element && element.querySelector(":scope > .message-content");
        if (!content || !key || !state.timeline.includes(item)) {
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

  // Previews skip syntax highlighting, image resolution and structured extraction; the complete message does them once.
  // Finished blocks (before the last blank line outside a code fence) render once; only the growing tail re-renders,
  // so a long answer costs O(new text) per frame instead of O(whole answer).
  const previewCaches = new WeakMap();
  function renderPreviewMarkdown(container, text, entry) {
    text = assistantDisplayText(text);
    if (!chatMarkdown.markdown) {
      container.textContent = text;
      return;
    }
    let cache = entry && previewCaches.get(entry);
    if (!cache || cache.container !== container || !text.startsWith(cache.stableText)) {
      container.classList.add("markdown-body");
      const stable = document.createElement("div");
      const tail = document.createElement("div");
      stable.className = tail.className = "markdown-preview-part";
      container.replaceChildren(stable, tail);
      cache = { container, stable, tail, stableText: "" };
      if (entry) previewCaches.set(entry, cache);
    }
    const boundary = stablePreviewBoundary(text, cache.stableText.length);
    if (boundary > cache.stableText.length) {
      cache.stable.append(...previewFragment(text.slice(cache.stableText.length, boundary)).childNodes);
      cache.stableText = text.slice(0, boundary);
    }
    cache.tail.replaceChildren(...previewFragment(text.slice(boundary)).childNodes);
  }

  function stablePreviewBoundary(text, from) {
    let boundary = from;
    let fenced = false;
    let lineStart = from;
    while (lineStart < text.length) {
      const lineEnd = text.indexOf("\n", lineStart);
      if (lineEnd < 0) break;
      const line = text.slice(lineStart, lineEnd);
      if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
      else if (!fenced && !line.trim() && lineStart > from) boundary = lineEnd + 1;
      lineStart = lineEnd + 1;
    }
    return boundary;
  }

  function previewFragment(text) {
    const fragment = document.createElement("div");
    fragment.innerHTML = chatMarkdown.markdown.render(text);
    chatMarkdown.renderMath(fragment);
    for (const img of fragment.querySelectorAll("img[src]")) {
      if (/^(?:file:\/\/|\/|\.\.?\/)/i.test(img.getAttribute("src"))) img.removeAttribute("src");
    }
    for (const link of fragment.querySelectorAll("a")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    return fragment;
  }

  function dropLivePreviews(runId) {
    const before = state.timeline.length;
    state.timeline = state.timeline.filter(function (entry) { return !entry.streaming || (runId !== undefined && entry.runId !== runId); });
    if (state.timeline.length !== before) scheduleTimelineRender();
  }

  function upsertActivity(id, category, phase, text, diff, title, output) {
    let existing = indexedTimeline().activities.get(id);
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
    const uris = dataTransfer.getData("text/uri-list").split(/\r?\n/).filter(function (uri) {
      return uri && !uri.startsWith("#");
    });
    // URI drops (including VS Code Explorer and Finder) must be opened by the Extension Host.
    // A Webview-only reference cannot stage image bytes or provide a usable local runtime path.
    if (uris.length) {
      vscode.postMessage({ type: "attachments.addUris", uris });
      return;
    }
    await addBrowserFiles(files);
  }

  function hasAttachmentData(dataTransfer) {
    if (!dataTransfer) {
      return false;
    }
    const types = Array.from(dataTransfer.types || []);
    return types.includes("Files") || types.includes("text/uri-list");
  }

  async function addBrowserFiles(files) {
    for (const file of files) {
      if (!file.name || file.name.length > 255 || /[\\/\x00-\x1f]/.test(file.name) || [".", ".."].includes(file.name)) {
        appendNotice("error", t("ui.local.file.read.failed"));
        continue;
      }
      if (browserImageMediaType(file)) {
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
  }

  function browserImageMediaType(file) {
    const accepted = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    if (accepted.includes(file.type)) return file.type;
    if (file.type) return undefined;
    return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" })
      [String(file.name || "").split(".").pop().toLowerCase()];
  }

  async function addBrowserImages(files) {
    for (const file of files) {
      const mediaType = browserImageMediaType(file);
      const imageCount = state.attachments.filter(function (item) { return item.kind === "image"; }).length;
      const imageBytes = state.attachments.filter(function (item) { return item.kind === "image"; })
        .reduce(function (total, item) { return total + (item.size || 0); }, 0);
      if (!mediaType || file.size < 1) {
        appendNotice("error", t("ui.attach.up.to.8.png.jpeg.gif.or.webp.images.with.a.maximum.of.10.mib.each.and.20.mib.total"));
        continue;
      }
      const id = createId();
      addAttachments([{ id, name: file.name || "image", kind: "image", previewUri: URL.createObjectURL(file), mediaType, size: file.size, pending: true }]);
      try {
        const dataUrl = await readDataUrl(file);
        vscode.postMessage({ type: "attachments.createImage", id, name: file.name || "image", mediaType, size: file.size, data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
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
    chatTaskFlow.renderWorkLoopPanel();
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
    chatTerminal.renderTerminalCommand(details, event.text, event.phase);
    chatTerminal.renderCommandOutput(details, event.output, false);
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
      chatTerminal.renderTerminalCommand(raw, event.text, event.phase, event.title);
      chatTerminal.renderCommandOutput(raw, event.output, Boolean(event.title));
      raw.querySelectorAll("details").forEach(function (item, index) {
        item.dataset.disclosureKey = event.id + ":" + index;
      });
      details.append(raw);
    }
    container.append(details);
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
    const pageKey = [start, end, state.timeline.length, uiLocale()].join(":");
    if (pages.dataset.renderKey !== pageKey) {
      pages.dataset.renderKey = pageKey;
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
    }
    const managedByEvent = managedActivities(visibleEvents);
    const assistantContext = JSON.stringify([state.role, state.childAgents.map(agent => [agent.agentId, agent.role])]);
    const commandContexts = new Map(state.childAgents.map(agent => [agent.agentId, JSON.stringify(agent)]));
    for (const event of visibleEvents) {
      const managedGroup = managedByEvent.get(event.id);
      if (managedGroup && managedGroup.events[0] !== event) continue;
      retainedIds.add(event.id);
      const existing = existingMessages.get(event.id);
      const renderKey = [eventVersion(event), chatSyntax.syntaxRevision, uiLocale(),
        event.type === "assistant" ? assistantContext : null,
        event.type === "assistant" || event.type === "interview" ? canAnswerInterview(event) : null,
        event.type === "assistant" && event.runId === state.pendingDecisionRunId && event.runId
          ? JSON.stringify([state.pendingDecisionRunId, state.pendingDecisionCanApprove, state.decisionSubmitting, state.running, state.runtimeAvailable]) : null,
        managedGroup ? state.role + ":" + (commandContexts.get(managedGroup.managed.agentId) || "") : null,
        managedGroup ? JSON.stringify([managedGroup.managed, managedGroup.events.map(eventVersion)]) : null];
      const previousKey = existing && messageRenderKeys.get(existing);
      if (previousKey && renderKey.every((value, index) => value === previousKey[index])) {
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
          details: Array.from(element.querySelectorAll("details")).map(function (details, index) { return { key: details.dataset.disclosureKey || details.className + ":" + index, open: details.open, hidden: details.hidden, loaded: chatTerminal.lazyCommandOutputs.has(details) && Boolean(details.querySelector("pre")) }; }),
          scroll: Array.from(element.querySelectorAll("pre")).map(function (pre) { return { top: pre.scrollTop, left: pre.scrollLeft }; })
        });
      }
      const message = document.createElement("article");
      message.className = "message message-" + (event.type === "interview" ? "assistant" : event.type);
      message.dataset.id = event.id;
      const compaction = event.type === "activity" && event.category === "tool" &&
        ["Context compaction", "컨텍스트 압축", t("ui.context.compaction")].includes(event.title);
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
        message.classList.add("message-activity-" + (event.category || "tool"));
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
      if (event.type === "activity" && !compaction && event.category !== "command" && !(event.category === "file" && event.diff)) {
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
        renderStructuredInterview(content, event);
      } else if (event.type === "assistant") {
        const taskContent = chatTaskFlow.extractTaskFlows(assistantDisplayText(localizedText(event.text, event.localization)));
        const extracted = event.phase !== "commentary" && globalThis.agentFactoryExecutionReferences
          ? globalThis.agentFactoryExecutionReferences.extract(taskContent.text, chatMarkdown.markdown)
          : { text: taskContent.text, references: [] };
        if (extracted.references.length) {
          chatMarkdown.renderAssistantMarkdown(content, extracted.before);
          chatMarkdown.renderExecutionReferences(content, extracted.references);
          chatMarkdown.appendAssistantMarkdown(content, extracted.after);
        } else {
          chatMarkdown.renderAssistantMarkdown(content, extracted.text);
        }
        for (const flow of taskContent.flows) content.append(chatTaskFlow.createTaskFlow(flow));
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
          chatTerminal.renderTerminalCommand(content, event.text, event.phase, event.title);
          chatTerminal.renderCommandOutput(content, event.output, Boolean(event.title));
        }
      } else if (event.type === "activity" && event.category === "file" && event.diff) {
        chatSyntax.renderGitDiff(content, event.diff, event.text, event.phase);
      } else {
        content.textContent = event.text;
        if (event.type === "activity" && message.dataset.category === "tool" && event.text) content.title = event.text;
      }
      if (event.type === "user") renderSubmission(content, event.submission);
      if (event.type === "user" && Array.isArray(event.attachments)) renderHistoryAttachments(content, event.attachments);
      message.append(content);
      const display = displayStates.get(event.id);
      if (display) {
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
          details: Array.from(element.querySelectorAll("details")).map((details, index) => ({ key: details.dataset.disclosureKey || details.className + ":" + index, open: details.open, hidden: details.hidden, loaded: chatTerminal.lazyCommandOutputs.has(details) && Boolean(details.querySelector("pre")) })),
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

  function renderRunStatus() {
    runElapsed.hidden = !state.running;
    const hasUnfinishedTasks = chatTaskFlow.displayTaskFlows().some(chatTaskFlow.unfinishedFlow);
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
    runStatusLabel.textContent = state.cancellationRequested ? t("ui.cancellation.requested") : localizedText(state.runProgress, state.runProgressLocalization) || t("ui.working");
    runStatusLabel.title = state.cancellationRequested ? t("ui.cancellation.requested") : localizedText(state.runProgress, state.runProgressLocalization) || t("ui.working");
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
    createId, t, vscode, state, renderAttachments, updateSendButton, persist
  });

  function bindAttachmentConversion(element, attachment) {
    if (attachment.kind !== "image" || attachment.pending || !attachment.uri) return;
    element.tabIndex = 0;
    const open = function (event) {
      event.preventDefault();
      event.stopPropagation();
      chatImageConverter.openImageConverter(attachment);
    };
    element.addEventListener("contextmenu", open);
    element.addEventListener("keydown", function (event) {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) open(event);
    });
  }

  async function encodeAttachmentImage(message) {
    let canvas;
    try {
      const image = new Image();
      image.src = message.source;
      await image.decode();
      canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context || !canvas.width || !canvas.height) throw new Error("Invalid image");
      if (message.mediaType === "image/jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(image, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, message.mediaType, 0.92));
      if (!blob || blob.type !== message.mediaType) throw new Error("Unsupported encoder");
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      vscode.postMessage({ type: "attachment.converted", id: message.id, name: message.name,
        mediaType: blob.type, size: blob.size, data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
    } catch {
      vscode.postMessage({ type: "attachment.conversionFailed", id: message.id });
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  }

  function renderAttachments() {
    attachmentList.replaceChildren();
    for (const attachment of state.attachments) {
      const chip = document.createElement("div");
      chip.className = "attachment-chip" + (attachment.kind === "image" ? " attachment-image" : "");
      chip.title = attachment.uri || attachment.name;
      bindAttachmentConversion(chip, attachment);
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
      bindAttachmentConversion(item, attachment);
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

  function positionQuestionMenu() {
    if (questionMenu.hidden) return;
    const anchor = questionButton.getBoundingClientRect();
    const width = Math.min(440, window.innerWidth - 16);
    questionMenu.style.width = width + "px";
    questionMenu.style.left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)) + "px";
    questionMenu.style.bottom = Math.max(8, window.innerHeight - anchor.top + 8) + "px";
    questionMenu.style.maxHeight = Math.max(48, Math.min(320, anchor.top - 16)) + "px";
  }
  window.addEventListener("resize", positionQuestionMenu);
  const questionPositionObserver = new ResizeObserver(positionQuestionMenu);
  questionPositionObserver.observe(promptSurface);
  questionPositionObserver.observe(questionButton);

  function selectQuestionTab(name, focus = true, requestHistory = true) {
    if (name === "history" && state.role !== "main") name = "questions";
    for (const tab of questionTabs) {
      const selected = tab.dataset.questionTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
      if (selected && focus) tab.focus();
    }
    if (name === "questions") {
      renderQuestionList();
    } else if (requestHistory) {
      chatHistory.conversationList.replaceChildren(historyEmpty("ui.conversation.loading"));
      vscode.postMessage({ type: "conversations.request" });
    }
  }

  for (const tab of questionTabs) {
    tab.addEventListener("click", function () { selectQuestionTab(tab.dataset.questionTab); });
    tab.addEventListener("keydown", function (event) {
      const available = questionTabs.filter(item => !item.hidden);
      const index = available.indexOf(tab);
      let next;
      if (matchesShortcut(event, shortcuts.settingsTabNext)) next = (index + 1) % available.length;
      if (matchesShortcut(event, shortcuts.settingsTabPrevious)) next = (index + available.length - 1) % available.length;
      if (matchesShortcut(event, shortcuts.settingsTabFirst)) next = 0;
      if (matchesShortcut(event, shortcuts.settingsTabLast)) next = available.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      selectQuestionTab(available[next].dataset.questionTab);
    });
  }

  function openQuestionMenu(tabName = "questions") {
    closeSettingMenu(false);
    closeSessionMenu(false);
    renderQuestionList();
    questionMenu.hidden = false;
    questionButton.setAttribute("aria-expanded", "true");
    selectQuestionTab(tabName);
    positionQuestionMenu();
  }

  function closeQuestionMenu(restoreFocus) {
    questionMenu.hidden = true;
    questionButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) {
      questionButton.focus();
    }
  }

  function renderQuestionList() {
    const index = indexedTimeline();
    const questions = index.questions;
    if (questionSourceId !== index.id) {
      questionSourceId = index.id;
      questionPageStart = 0;
      questionListKey = undefined;
      questionElements.clear();
    }
    const pageSize = 100;
    questionPageStart = Math.min(questionPageStart, Math.max(0, Math.floor((questions.length - 1) / pageSize) * pageSize));
    const visible = questions.slice(questionPageStart, questionPageStart + pageSize);
    const key = [index.id, questionPageStart, questions.length, uiLocale(), ...visible.map(eventVersion)].join(":");
    if (questionListKey === key) return;
    questionListKey = key;
    const fragment = document.createDocumentFragment();
    const retained = new Set();
    function pageButton(direction, label, enabled, offset) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "question-item question-page";
      button.dataset.questionPage = direction;

      button.textContent = t(label);
      button.disabled = !enabled;
      button.addEventListener("click", function (event) {
        // Replacing the page detaches this button before the outside-click handler.
        event.stopPropagation();
        questionPageStart += offset;
        renderQuestionList();
        questionList.querySelector("[data-question-id]")?.focus();
      });
      button.addEventListener("keydown", handleQuestionListKeydown);
      fragment.append(button);
    }
    if (questions.length > pageSize) pageButton("previous", "ui.history.previous", questionPageStart > 0, -pageSize);
    visible.forEach(function (question) {
      retained.add(question.id);
      let item = questionElements.get(question.id);
      if (!item) {
        item = document.createElement("button");
        item.type = "button";
        item.className = "question-item";
        item.dataset.questionId = question.id;

        const text = document.createElement("span");
        text.className = "question-item-text";
        item.append(text);
        item.addEventListener("click", function () {
          closeQuestionMenu(false);
          jumpToQuestion(question.id);
        });
        item.addEventListener("keydown", handleQuestionListKeydown);
        const row = document.createElement("div");
        row.className = "question-row";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "question-copy setting-button";
        copy.append(createModeIcon("M9 9h12v12H9z M6 15H3V3h12v3", "question-copy-icon"));
        copy.addEventListener("click", function () {
          const position = indexedTimeline().positions.get(question.id);
          const current = position === undefined ? undefined : state.timeline[position];
          if (typeof current?.text === "string" && current.text.length) {
            vscode.postMessage({ type: "message.copy", text: current.text });
          }
        });
        copy.addEventListener("keydown", handleQuestionListKeydown);
        row.append(item, copy);
        questionElements.set(question.id, item);
      }
      const copy = item.parentElement.querySelector(".question-copy");
      copy.title = t("ui.copy.question");
      copy.setAttribute("aria-label", t("ui.copy.question"));
      copy.disabled = typeof question.text !== "string" || !question.text.length;
      const attachmentNames = (Array.isArray(question.attachments) ? question.attachments : [])
        .map(function (attachment) { return attachment.name; }).filter(Boolean);
      item.firstElementChild.textContent = question.text?.trim() || (attachmentNames.length ? t("ui.attachments.c53076") + attachmentNames.join(", ") : t("ui.message.with.attachments"));
      fragment.append(item.parentElement);
    });
    if (questions.length > pageSize) pageButton("next", "ui.history.next", questionPageStart + pageSize < questions.length, pageSize);
    if (!questions.length) fragment.append(sessionEmpty(t("ui.no.user.questions.yet")));
    questionList.replaceChildren(fragment);
    for (const id of questionElements.keys()) if (!retained.has(id)) questionElements.delete(id);
  }

  function handleQuestionListKeydown(event) {
    const copy = event.currentTarget.classList.contains("question-copy");
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const row = event.currentTarget.closest(".question-row");
      const target = row?.querySelector(event.key === "ArrowRight" ? ".question-copy:not(:disabled)" : ".question-item");
      if (target) { event.preventDefault(); target.focus(); }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(questionList.querySelectorAll(copy ? ".question-copy:not(:disabled)" : ".question-item:not(:disabled)"));
    const index = items.indexOf(event.currentTarget);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    event.preventDefault();
    items[(index + offset + items.length) % items.length]?.focus();
  }

  function jumpToQuestion(id) {
    const position = indexedTimeline().positions.get(id);
    if (position === undefined || state.timeline[position].type !== "user") return;
    cancelAnimationFrame(autoScrollFrame);
    followLatest = false;
    if (!messageElements.has(id)) {
      const end = Math.min(state.timeline.length, (Math.floor(position / 200) + 1) * 200);
      timelineEndId = end === state.timeline.length ? undefined : state.timeline[end - 1].id;
      renderTimeline();
    }
    const target = messageElements.get(id);
    if (!target) return;
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
    const items = Array.from(event.currentTarget.parentElement.querySelectorAll('[role="option"]:not(:disabled)'));
    const index = items.indexOf(event.currentTarget);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    event.preventDefault();
    items[(index + offset + items.length) % items.length]?.focus();
  }

  function updateQuestionControl() {
    const count = indexedTimeline().questions.length;
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
    if (!state.botsEnabled) return;
    if (!companionSnapshot) botIdleSince = Date.now();
    if (["drowsy", "sleeping"].includes(factoryBot.dataset.state)) renderFactoryBot();
  }

  function botVisualsActive() {
    return state.botsEnabled && state.botVisible && !document.hidden;
  }

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

  function updateBotCare() {
    if (companionSnapshot) return;
    const care = state.botCare;
    const now = Date.now();
    const minutes = Math.max(0, (now - care.updatedAt) / 60000);
    if (minutes < 1) return;
    // Hidden/disabled time is rest, not neglect. Evaluate elapsed time lazily.
    const resting = !botVisualsActive() || ["sleeping", "offline"].includes(factoryBot.dataset.state) || minutes > 5;
    state.botCare = { ...care,
      fullness: Math.max(0, care.fullness - (resting ? 0 : minutes * .5)),
      happiness: Math.max(0, care.happiness - (resting ? 0 : minutes * .25)),
      energy: Math.max(0, Math.min(100, care.energy + minutes * (resting ? 2 : -.5))),
      updatedAt: now };
  }

  function renderBotCare() {
    clearTimeout(botCareTimer); botCareTimer = undefined;
    updateBotCare();
    if (botMenu.hidden || !botVisualsActive()) return;
    for (const key of ["fullness", "happiness", "energy"]) {
      const value = Math.round(state.botCare[key]);
      document.getElementById("bot-" + key).value = value;
      document.getElementById("bot-" + key + "-value").textContent = String(value);
    }
    document.getElementById("bot-care-growth").textContent = t("bot.growth", 1 + Math.floor(state.botCare.careCount / 5), state.botCare.careCount);
    // One minute timer only while the care panel is visible. Reuse gesture ticks otherwise.
    botCareTimer = window.setTimeout(renderBotCare, 60000);
  }

  function factoryBotKey() {
    return [state.botsEnabled, state.botVisible, state.botAnimations, state.pendingDecisionRunId,
      state.runtimeAvailable, state.running, botOutcome, uiLocale()].join(":");
  }

  function updateBotGesture(mode) {
    const mood = factoryBot.dataset.mood || "calm";
    const key = mode + ":" + mood;
    if (key !== botGestureKey || mode !== "idle") {
      clearTimeout(botGestureTimer);
      botGestureTimer = undefined;
      botGestureKey = key;
    }
    if (mode !== "idle" || !botVisualsActive() || !state.botAnimations || botReducedMotion.matches) {
      clearTimeout(botGestureTimer);
      botGestureTimer = undefined;
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
    const care = state.botCare;
    if (care.careCount >= 5) pools.calm = pools.calm.concat(["dance", "balance"]);
    const preferred = care.energy < 30 ? ["breathe", "read"]
      : care.fullness < 30 ? ["look", "breathe"]
      : care.happiness < 35 ? ["shy", "look", "read"] : pools[mood] || pools.calm;
    const choices = preferred.filter(function (gesture) {
      return gesture !== factoryBot.dataset.gesture;
    });
    factoryBot.dataset.gesture = choices[Math.floor(Math.random() * choices.length)];
    botGestureTimer = window.setTimeout(function () {
      botGestureTimer = undefined;
      renderFactoryBot();
    }, 8000);
  }

  function renderFactoryBot() {
    renderBotIdentity();
    if (!state.botsEnabled) { botTalkPending = undefined; botSpeechVisible = false; botSpeechText.textContent = ""; }
    renderBotTalk();
    renderBotCare();
    botRenderKey = factoryBotKey();
    document.getElementById("bots-disabled").checked = !state.botsEnabled;
    factoryBot.hidden = !state.botsEnabled || !state.botVisible;
    const dock = document.getElementById("companion-dock");
    dock.hidden = factoryBot.hidden;
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
      renderCompanion();
      return;
    }
    factoryBot.dataset.animations = String(state.botAnimations);
    let mode = companionWorking > 0 ? "working" : state.pendingDecisionRunId ? "waiting"
      : !state.runtimeAvailable ? "offline"
      : state.running ? "working"
      : botOutcome === "completed" ? "complete"
      : botOutcome === "failed" ? "error" : "idle";
    clearTimeout(botIdleTimer);
    botIdleTimer = undefined;
    if (mode === "idle") {
      if (state.botCare.energy < 15 && botIdleSince === undefined) botIdleSince = Date.now() - 60000;
      if (botIdleSince === undefined) botIdleSince = Date.now();
      const elapsed = Date.now() - botIdleSince;
      if (botTalkPending || botSpeechVisible) mode = "idle";
      else if (elapsed >= 60000) mode = "sleeping";
      else {
        if (elapsed >= 45000) mode = "drowsy";
        if (botVisualsActive()) botIdleTimer = window.setTimeout(renderFactoryBot, (elapsed < 45000 ? 45000 : 60000) - elapsed);
      }
    } else {
      botIdleSince = companionSnapshot ? companionSnapshot.lastInteractionAt : undefined;
    }
    const labels = { drowsy: t("ui.getting.sleepy"), sleeping: t("ui.sleeping"), idle: t("ui.ready"), working: t("ui.working"), waiting: t("ui.waiting.for.your.reply"), complete: t("ui.completed"), error: t("ui.needs.attention"), offline: t("ui.resting.runtime.offline") };
    factoryBot.dataset.state = mode;
    if (botMenu) {
      const available = mode === "idle" || mode === "drowsy" || mode === "sleeping";
      botMenu.querySelectorAll("[data-bot-action], [data-companion-action]").forEach(button => { button.disabled = !available && (!state.companionAvailable || button.hasAttribute("data-bot-action")); });
      document.getElementById("bot-menu-note").hidden = available;
      if (!state.botVisible) closeBotMenu();
    }
    if (mode !== "idle" || !state.botVisible || !state.botAnimations || botReducedMotion.matches) clearBotGlance();
    updateBotGesture(mode);
    factoryBot.title = botDisplayName() + " · " + labels[mode] + (factoryBot.dataset.brain === "luna" ? t("ui.luna.none") : factoryBot.dataset.brain === "unavailable" ? t("ui.local.animation.luna.unavailable") : "");
    factoryBot.setAttribute("aria-label", factoryBot.title);
    renderCompanion();
    if (mode === "complete" && !botWaveTimer) {
      botWaveTimer = window.setTimeout(function () {
        botWaveTimer = undefined;
        if (botOutcome === "completed") botOutcome = undefined;
        renderFactoryBot();
      }, 2400);
    }
  }

  function renderStatusBar() {
    if (botRenderKey !== factoryBotKey()) renderFactoryBot();
    if (statusDragId) { statusRenderPending = true; return; }
    const focusedId = statusBar.contains(document.activeElement) ? document.activeElement.dataset.itemId : undefined;
    const catalog = statusCatalog();
    const retained = new Set();
    let previous;
    for (const itemId of state.statusItems.filter(statusItemAvailable)) {
      retained.add(itemId);
      let item = statusElements.get(itemId);
      if (!item) {
        item = document.createElement("span");
        item.draggable = true;
        item.tabIndex = 0;
        item.dataset.itemId = itemId;
        bindStatusDrag(item, itemId, false);
        item.addEventListener("click", function () {
          if (itemId === "agents" && state.role === "main") openAgentsMenu();
        });
        item.addEventListener("keydown", function (event) {
          if (itemId === "agents" && state.role === "main" && ["Enter", " "].includes(event.key)) {
            event.preventDefault();
            openAgentsMenu();
          } else if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            moveStatus(itemId, event.key === "ArrowLeft" ? -1 : 1);
          }
        });
        statusElements.set(itemId, item);
      }
      const label = statusLabel(itemId);
      const renderKey = JSON.stringify([label, catalog[itemId], uiLocale(),
        itemId === "runtime" ? state.runtimeAvailable : null,
        itemId === "agents" ? [state.role, state.workUnitsKnown, state.workUnits.activeUnits, state.workUnits.totalCalled, agentsMenu.hidden] : null,
        itemId === "context" ? [state.contextUsedTokens, state.contextWindowTokens] : null]);
      const sibling = previous ? previous.nextElementSibling : statusBar.firstElementChild;
      if (sibling !== item) statusBar.insertBefore(item, sibling);
      previous = item;
      if (statusRenderKeys.get(item) === renderKey) continue;
      statusRenderKeys.set(item, renderKey);
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
    for (const [id, item] of statusElements) {
      if (!retained.has(id)) { item.remove(); statusElements.delete(id); }
    }
    if (focusedId && document.activeElement?.dataset.itemId !== focusedId) statusBar.querySelector('[data-item-id="' + focusedId + '"]')?.focus();
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
      id.textContent = chatTaskFlow.childTaskName(agent);
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
    const activeStatuses = new Set(["accepted", "queued", "starting", "running", "verifying", "cancelling"]);
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
      verifying: t("flow.status.verifying"),
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

  statusSettingsButton.addEventListener("click", function () {
    if (!statusSettings.hidden) { closeStatusSettings(); return; }
    chatAgentSettings.renderGeneralSettings();
    statusSettings.hidden = false;
    statusSettingsButton.setAttribute("aria-expanded", "true");
    renderStatusCatalog();
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
  function selectSettingsTab(tab) {
    chatAgentSettings.renderAgentDefaults();
    for (const item of settingsTabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden = !selected;
    }
    renderStatusCatalog();
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
      const index = settingsTabs.indexOf(tab);
      let next;
      if (matchesShortcut(event, shortcuts.settingsTabNext)) next = (index + 1) % settingsTabs.length;
      if (matchesShortcut(event, shortcuts.settingsTabPrevious)) next = (index + settingsTabs.length - 1) % settingsTabs.length;
      if (matchesShortcut(event, shortcuts.settingsTabFirst)) next = 0;
      if (matchesShortcut(event, shortcuts.settingsTabLast)) next = settingsTabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      selectSettingsTab(settingsTabs[next]);
    });
  }
  document.getElementById("bots-disabled").addEventListener("change", function (event) {
    if (!state.botsAvailable) return;
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
      case "fiveHour": case "fiveHourRemaining": return safePercentOrUndefined(state.fiveHourUsedPercent) !== undefined;
      case "weekly": case "weeklyRemaining": return safePercentOrUndefined(state.weeklyUsedPercent) !== undefined;
      case "fiveHourReset": return safeResetsAtOrUndefined(state.fiveHourResetsAt) !== undefined;
      case "weeklyReset": return safeResetsAtOrUndefined(state.weeklyResetsAt) !== undefined;
      case "agents": case "agentsTotal": return main && state.workUnitsKnown;
      case "goalTokens": return main && !goalError && safeCountOrUndefined(nativeGoal?.tokensUsed) !== undefined;
      case "goalTime": return main && !goalError && safeCountOrUndefined(nativeGoal?.timeUsedSeconds) !== undefined;
      case "goalBudget": return main && !goalError && safeCountOrUndefined(nativeGoal?.tokenBudget) !== undefined;
      case "goal": return main && !goalError && Boolean(nativeGoal || supported.goal);
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
      model: t("ui.model.b32422") + (supported.model ? chatAgentSettings.effectiveAgentValue("main", "model") || t("ui.default") : t("ui.unknown")),
      reasoning: t("ui.reasoning.529e9c") + (supported.reasoning ? reasoningDisplayLabel(chatAgentSettings.effectiveAgentValue("main", "reasoningEffort")) : t("ui.unknown")),
      fast: t("ui.fast.314aef") + (supported.fast ? state.fastMode ? t("ui.on") : t("ui.off") : t("ui.unknown")),
      task: main ? t("ui.task") + taskModeNames()[enterAction()]?.replaceAll(t("ui.verification"), t("ui.verify")) : t("ui.task.main.only"),
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
      renderPendingQueue();
    };
    queue.hidden = !expanded;
    if (!expanded) {
      if (queue.childNodes.length) queue.replaceChildren();
      pendingQueueRows.clear();
      return;
    }
    const nodes = [];
    const description = queue.querySelector(".pending-queue-description") || document.createElement("p");
    description.className = "pending-queue-description";
    description.textContent = state.pendingDecisionRunId ? t("ui.queued.messages.will.run.together.after.your.decision") : t("ui.queued.messages.retain.their.execution.action.only.matching.actions.run.together");
    nodes.push(description);
    if (pending.some(function (item) { return !item.rejected; }) && !state.running && !state.pendingDecisionRunId) {
      const resume = queue.querySelector("[data-queue-resume]") || document.createElement("button");
      resume.dataset.queueResume = "true";
      resume.type = "button";
      resume.textContent = t("ui.check.run.status.and.resume.queue");
      resume.onclick = function () { vscode.postMessage({ type: "queue.resume" }); };
      nodes.push(resume);
    }
    if (pending.some(function (item) { return !item.rejected; }) && state.running && !state.pendingDecisionRunId) {
      // Stopping the current run dispatches the queue next; unlike Escape it always retries.
      const sendNow = queue.querySelector("[data-queue-send-now]") || document.createElement("button");
      sendNow.dataset.queueSendNow = "true";
      sendNow.type = "button";
      sendNow.textContent = t("ui.stop.current.run.and.send.queued.messages.now");
      sendNow.onclick = function () { cancelRun(true); };
      nodes.push(sendNow);
    }
    const ids = new Set(pending.map(function (item) { return item.id; }));
    for (const id of pendingQueueRows.keys()) {
      if (!ids.has(id)) pendingQueueRows.delete(id);
    }
    pending.forEach(function (item) {
      const key = JSON.stringify([uiLocale(), item.text, item.attachments.map(function (attachment) { return attachment.name; }), submissionFromExecution(item.execution), Boolean(item.rejected)]);
      const cached = pendingQueueRows.get(item.id);
      if (cached?.key === key) {
        const recover = cached.nodes[1];
        if (recover) recover.disabled = hasComposerContent();
        nodes.push(...cached.nodes);
        return;
      }
      const rowNodes = [];
      const entry = document.createElement("div");
      entry.textContent = item.text + (item.attachments.length ? " · " + item.attachments.map(function (attachment) { return attachment.name; }).join(", ") : "");
      renderSubmission(entry, submissionFromExecution(item.execution));
      rowNodes.push(entry);
      if (item.rejected) {
        const recover = document.createElement("button");
        recover.type = "button";
        recover.textContent = t("ui.submission.unconfirmed.restore.to.input");
        recover.dataset.queueRecover = "true";
        recover.disabled = hasComposerContent();
        recover.addEventListener("click", function () {
          if (hasComposerContent()) return;
          const request = state.pendingRequests.find(function (pending) { return pending.id === item.id; });
          if (!request) return;
          state.pendingRequests = state.pendingRequests.filter(function (request) { return request.id !== item.id; });
          state.draft = request.text;
          prompt.value = request.text;
          state.attachments = request.attachments;
          state.taskMode = "direct";
          state.businessMode = "normal";
          state.model = request.execution.model;
          state.agentModels = request.execution.agentModels || {};
          state.reasoning = request.execution.reasoningEffort;
          state.fastMode = request.execution.fast;
          renderAll();
          resizePrompt();
          persist();
        });
        rowNodes.push(recover);
      }
      pendingQueueRows.set(item.id, { key, nodes: rowNodes });
      nodes.push(...rowNodes);
    });
    // Remove obsolete nodes first so retained buttons keep their focus.
    const retained = new Set(nodes);
    for (const node of Array.from(queue.childNodes)) {
      if (!retained.has(node)) node.remove();
    }
    let cursor = queue.firstChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else queue.insertBefore(node, cursor);
    }
  }

  function updateSendButton() {
    sendButton.disabled = conversationClearing || !state.runtimeAvailable || !state.capabilities || Boolean(chatWorkUnits.conversationWorktree?.worktree?.workUnit && chatWorkUnits.conversationWorktree.worktree.phase === "merged");
  }

  function updateRunControls() {
    chatWorkUnits.renderWorktree();
    renderPendingQueue();
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
    const sendKey = shortcutLabel(shortcuts.send);
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
    fastModeButton.setAttribute("aria-pressed", String(state.fastMode));
    fastModeButton.setAttribute("aria-label", state.fastMode ? t("ui.fast.mode.on") : t("ui.fast.mode.off"));
    fastModeButton.title = state.fastMode ? t("ui.fast.mode.on") : t("ui.fast.mode.off");
    fastModeValue.textContent = state.fastMode ? t("ui.on") : t("ui.off");
    promptSurface.classList.toggle("is-astra", /(?:^|[-/])astra(?:$|-)/i.test(chatAgentSettings.effectiveAgentValue("main", "model")));
    const modelText = (chatAgentSettings.effectiveAgentValue("main", "model") ? chatAgentSettings.modelOptionLabel(chatAgentSettings.effectiveAgentValue("main", "model")) : t("ui.default")) + " · " + reasoningDisplayLabel(chatAgentSettings.effectiveAgentValue("main", "reasoningEffort"));
    if (modelLabel.textContent !== modelText) modelLabel.textContent = modelText;
    modelButton.title = t("ui.models.and.reasoning");
    modelButton.setAttribute("aria-label", modelButton.title);
    if (openSettingId === "submission") renderSubmissionMenu(submissionMenu);
    updateComposerControls();
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
      const item = shortcutActions.find(action => action.id === id);
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
        option.title = option.disabled ? t("ui.requires.a.compatible.runtime") : t("submission.send", label) + (shortcuts[shortcutId] ? " (" + shortcutLabel(shortcuts[shortcutId]) + ")" : "");
        if (shortcuts[shortcutId]) option.setAttribute("aria-keyshortcuts", shortcutAria(shortcuts[shortcutId]));
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
    if (setting === "model") chatAgentSettings.renderModelSettings(menu);
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
      chatHistory.contractList.open = false;
      document.getElementById("task-history").open = false;
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

  function persistNow() {
    const next = persistenceSnapshot({
      shortcuts: { ...shortcuts },
      shortcutDefaultsVersion: shortcutDefaultsVersion,
      startedMessageIds: state.startedMessageIds,
      pendingRequests: state.pendingRequests,
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
      uiLanguage: state.uiLanguage,
      botVisible: state.botVisible,
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
      timeline: state.timeline.filter(function (event) { return !event.streaming; }).slice(-200).map(function (event) {
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
      modelFastModes: state.modelFastModes,
      model: state.model,
      reasoning: state.reasoning,
      agentSettingsScope: state.agentSettingsScope,
      agentSettingsSet: state.agentSettingsSet,
      fastMode: state.fastMode,
      contextUsedTokens: state.contextUsedTokens,
      contextWindowTokens: state.contextWindowTokens,
      weeklyUsedPercent: state.weeklyUsedPercent,
      fiveHourUsedPercent: state.fiveHourUsedPercent,
      weeklyResetsAt: state.weeklyResetsAt,
      fiveHourResetsAt: state.fiveHourResetsAt,
      runProgress: state.runProgress,
      runProgressLocalization: state.runProgressLocalization,
      runStartedAt: state.runStartedAt,
      runPanelExpanded: state.runPanelExpanded,
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
      modelFastModes: state.modelFastModes,
      model: state.model || undefined,
      reasoning: state.reasoning || undefined,
      agentSettingsScope: state.agentSettingsScope,
      agentSettingsSet: state.agentSettingsSet,
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
    renderShortcuts();
    inputFeedback.textContent = localizedText(inputFeedback.textContent, feedback);
    renderAll();
    renderStatusCatalog();
    chatAgentSettings.renderModelSettings(modelMenu);
    renderSubmissionMenu(submissionMenu);
    chatAgentSettings.renderGeneralSettings();
    renderQuestionList();
    renderSessionList();
    renderAgentsList();
    renderFactoryBot();
    persist();
  });
})();
