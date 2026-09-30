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

  const markdown = typeof globalThis.markdownit === "function"
    ? globalThis.markdownit({ html: false, linkify: true, typographer: false }).use(markdownMath).use(markdownSafeMarkup)
    : undefined;
  // Heavy renderers load beside markdown-it only when a message needs them.
  const vendorBase = document.querySelector('script[src*="markdown-it.min.js"]')?.src;
  const scriptNonce = document.currentScript?.nonce;
  const vendorLoads = new Map();
  const mermaidImages = new Map();
  let mermaidQueue = Promise.resolve();
  let mermaidSequence = 0;
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
  const sudoPanel = document.createElement("form");
  sudoPanel.className = "sudo-panel";
  sudoPanel.hidden = true;
  sudoPanel.setAttribute("aria-label", t("sudo.title"));
  const sudoTitle = document.createElement("strong");
  const sudoCommand = document.createElement("code");
  const sudoContext = document.createElement("span");
  sudoContext.className = "sudo-context";
  const sudoPassword = document.createElement("input");
  sudoPassword.type = "password";
  sudoPassword.autocomplete = "off";
  sudoPassword.setAttribute("aria-label", t("sudo.password"));
  const sudoSubmit = document.createElement("button");
  sudoSubmit.type = "submit";
  const sudoCancel = document.createElement("button");
  sudoCancel.type = "button";
  const sudoStatus = document.createElement("span");
  sudoStatus.setAttribute("role", "status");
  sudoPanel.append(sudoTitle, sudoCommand, sudoContext, sudoPassword, sudoSubmit, sudoCancel, sudoStatus);
  inputFeedback.after(sudoPanel);
  let sudoChallenge = null;
  sudoCancel.onclick = function () {
    if (sudoChallenge) vscode.postMessage({ type: "sudo.reply", id: sudoChallenge.id, cancelled: true });
    closeSudoPanel();
  };
  sudoPanel.onsubmit = async function (event) {
    event.preventDefault();
    const challenge = sudoChallenge;
    if (!challenge || !sudoPassword.value) return;
    const secret = sudoPassword.value;
    sudoPassword.value = "";
    sudoSubmit.disabled = true;
    sudoCancel.disabled = true;
    sudoStatus.textContent = t("sudo.encrypting");
    try {
      const pem = challenge.publicKey.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
      const keyBytes = Uint8Array.from(atob(pem), ch => ch.charCodeAt(0));
      const publicKey = await crypto.subtle.importKey("spki", keyBytes, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
      const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
      const rawKey = await crypto.subtle.exportKey("raw", aes);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(secret));
      const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawKey);
      new Uint8Array(rawKey).fill(0);
      const b64 = bytes => {
        const value = new Uint8Array(bytes);
        let binary = "";
        for (let index = 0; index < value.length; index += 8192) binary += String.fromCharCode(...value.subarray(index, index + 8192));
        return btoa(binary);
      };
      vscode.postMessage({ type: "sudo.reply", id: challenge.id, key: b64(wrappedKey), iv: b64(iv), data: b64(encrypted) });
      sudoStatus.textContent = t("sudo.running");
    } catch {
      sudoStatus.textContent = t("sudo.encryption.failed");
      sudoSubmit.disabled = false;
      sudoCancel.disabled = false;
    }
  };
  function closeSudoPanel() {
    sudoChallenge = null;
    sudoPassword.value = "";
    sudoStatus.textContent = "";
    sudoPanel.hidden = true;
    sudoCancel.disabled = false;
  }

  const modelMenu = document.getElementById("model-menu");
  const fastModeButton = document.getElementById("fast-mode-button");
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
  const worktreeButton = document.getElementById("worktree-button");
  const worktreeMenu = document.getElementById("worktree-menu");
  worktreeButton.addEventListener("click", () => openSetting("worktree"));
  let conversationWorktree;
  let worktreeBusy = false;
  let worktreeSupported = false;
  for (const action of ["create", "merge", "refresh"]) {
    document.getElementById("worktree-" + action)?.addEventListener("click", () => {
      if (action !== "refresh") closeSettingMenu(false);
      else vscode.postMessage({ type: "worktree.repositories" });
      vscode.postMessage({ type: "worktree." + action });
    });
    document.getElementById("worktree-" + action)?.addEventListener("keydown", handleSettingMenuKeydown);
  }
  const unitDialog = document.getElementById("unit-create-dialog");
  const unitForm = document.getElementById("unit-create-form");
  const unitRepository = document.getElementById("unit-repository");
  const unitName = document.getElementById("unit-name");
  const unitBase = document.getElementById("unit-base");
  const unitError = document.getElementById("unit-create-error");
  const unitStatus = document.getElementById("unit-create-status");
  let unitRepositories = [], unitBusy = false;
  function unitSelectRepository() {
    const repo = unitRepositories.find(r => r.path === unitRepository.value);
    unitBase.replaceChildren();
    for (const branch of repo?.branches || []) { const option = document.createElement("option"); option.value = branch; option.textContent = branch; unitBase.append(option); }
    if (repo?.defaultBranch) unitBase.value = repo.defaultBranch;
  }
  function unitSetBusy(busy) {
    unitBusy = busy;
    for (const control of unitForm.querySelectorAll("input, select, textarea, button")) control.disabled = busy;
    document.getElementById("unit-create-submit").disabled = busy;
    unitForm.setAttribute("aria-busy", String(busy));
  }
  function openUnitCreate(repository) {
    closeSettingMenu(false);
    unitForm.reset(); unitError.hidden = true;
    unitRepository.replaceChildren();
    for (const repo of unitRepositories) { const option = document.createElement("option"); option.value = repo.path; option.textContent = repo.path; unitRepository.append(option); }
    unitRepository.value = repository;
    unitSelectRepository();
    unitSetBusy(false); unitStatus.textContent = "";
    unitDialog.showModal(); unitName.focus();
  }
  unitRepository.addEventListener("change", unitSelectRepository);
  document.getElementById("unit-create-cancel").addEventListener("click", () => unitDialog.close());
  unitDialog.addEventListener("cancel", event => { if (unitBusy) event.preventDefault(); });
  unitDialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const controls = [...unitDialog.querySelectorAll("input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)")];
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  unitDialog.addEventListener("close", () => worktreeButton.focus());
  unitForm.addEventListener("submit", event => {
    event.preventDefault();
    if (unitBusy || !unitForm.reportValidity()) return;
    unitError.hidden = true; unitStatus.textContent = t("unit.creating");
    unitSetBusy(true);
    vscode.postMessage({ type: "worktree.create", repository: unitRepository.value, name: unitName.value.trim(), base: unitBase.value });
  });
  function positionWorktreeMenu() {
    if (worktreeMenu.hidden) return;
    const anchor = worktreeButton.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(320, window.innerWidth - margin * 2);
    worktreeMenu.style.width = width + "px";
    worktreeMenu.style.left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin)) + "px";
    worktreeMenu.style.bottom = Math.max(margin, window.innerHeight - anchor.top + 8) + "px";
    worktreeMenu.style.maxHeight = Math.max(48, anchor.top - margin * 2) + "px";
  }
  window.addEventListener("resize", positionWorktreeMenu);
  const worktreePositionObserver = new ResizeObserver(positionWorktreeMenu);
  worktreePositionObserver.observe(document.getElementById("worktree-picker"));
  worktreePositionObserver.observe(promptSurface);

  // GitHub deploy: the host detects manually dispatchable workflows; the dialog collects
  // their declared inputs and requires a review step before anything is dispatched.
  let deployTarget, deployError = "", deployLoading = false, deployRun, deployRepository = "", deployWorkflow, deployValues, deployBusy = false;
  const deployDialog = document.getElementById("deploy-dialog");
  const deployForm = document.getElementById("deploy-form");
  const deployFields = document.getElementById("deploy-fields");
  const deployErrorNode = document.getElementById("deploy-error");
  const deployStatusNode = document.getElementById("deploy-status");
  function deployAvailable() { return Boolean(deployTarget?.workflows?.length || deployRun); }
  function deployActive() { return Boolean(deployRun && deployRun.status !== "completed"); }
  function deployStateLabel(run) {
    if (run.status !== "completed") return t("deploy.state.running", run.status);
    return run.conclusion === "success" ? t("deploy.state.success") : t("deploy.state.failed", run.conclusion || run.status);
  }
  function renderDeploy() {
    const controls = document.getElementById("deploy-controls");
    if (!controls) return;
    controls.hidden = state.role !== "main" || (!deployAvailable() && !deployError);
    const summary = document.getElementById("deploy-summary");
    summary.textContent = deployLoading ? t("deploy.detecting") : deployError || (deployTarget ? deployTarget.repository + " · " + deployTarget.ref : "");
    const list = document.getElementById("deploy-workflows");
    list.replaceChildren();
    for (const workflow of deployTarget?.workflows || []) {
      for (const secret of workflow.missingSecrets || []) {
        const setup = document.createElement("button");
        setup.type = "button"; setup.className = "setting-option"; setup.setAttribute("role", "menuitem");
        setup.textContent = t("deploy.token.setup", secret);
        setup.title = t("deploy.token.setup.title", secret);
        setup.dataset.deploySecret = secret;
        setup.addEventListener("click", () => { closeSettingMenu(false); vscode.postMessage({ type: "deploy.token", secret: secret }); });
        setup.addEventListener("keydown", handleSettingMenuKeydown);
        list.append(setup);
      }
      const button = document.createElement("button");
      button.type = "button"; button.className = "setting-option"; button.setAttribute("role", "menuitem");
      button.textContent = t("deploy.workflow", workflow.name);
      button.title = workflow.path;
      button.disabled = deployActive() || Boolean(workflow.missingSecrets?.length);
      button.addEventListener("click", () => openDeploy(workflow));
      button.addEventListener("keydown", handleSettingMenuKeydown);
      list.append(button);
    }
    const link = document.getElementById("deploy-run-link");
    link.hidden = !deployRun;
    if (deployRun) link.textContent = t("deploy.run.link", deployRun.workflow, deployStateLabel(deployRun));
    document.getElementById("deploy-refresh").disabled = deployLoading;
  }
  function requestDeployTargets() {
    deployLoading = true; deployError = "";
    renderDeploy();
    vscode.postMessage({ type: "deploy.detect" });
  }
  document.getElementById("deploy-refresh").addEventListener("click", requestDeployTargets);
  document.getElementById("deploy-refresh").addEventListener("keydown", handleSettingMenuKeydown);
  document.getElementById("deploy-run-link").addEventListener("click", () => { if (deployRun?.url) vscode.postMessage({ type: "link.open", href: deployRun.url }); });
  document.getElementById("deploy-run-link").addEventListener("keydown", handleSettingMenuKeydown);
  function deploySetBusy(busy) {
    deployBusy = busy;
    for (const control of deployForm.querySelectorAll("input, select, button")) control.disabled = busy;
    deployForm.setAttribute("aria-busy", String(busy));
  }
  function openDeploy(workflow) {
    closeSettingMenu(false);
    deployWorkflow = workflow; deployValues = undefined;
    document.getElementById("deploy-target").textContent = t("deploy.target", deployTarget.repository, deployTarget.ref, workflow.name);
    deployFields.replaceChildren();
    for (const input of workflow.inputs) {
      const label = document.createElement("label");
      const caption = document.createElement("span");
      caption.textContent = input.name + (input.required ? " *" : "");
      let control;
      if (input.type === "boolean") {
        label.className = "deploy-checkbox";
        control = document.createElement("input"); control.type = "checkbox";
        control.checked = input.default === "true";
      } else if (input.type === "choice") {
        control = document.createElement("select");
        for (const value of input.options || []) { const option = document.createElement("option"); option.value = option.textContent = value; control.append(option); }
        if (input.default) control.value = input.default;
      } else {
        control = document.createElement("input");
        control.type = input.type === "number" ? "number" : "text";
        control.autocomplete = "off";
        control.value = input.default ?? input.suggestion ?? "";
        if (input.suggestion) control.pattern = "\\d+\\.\\d+\\.\\d+";
      }
      control.dataset.deployInput = input.name;
      control.required = input.required && input.type !== "boolean";
      if (input.type === "boolean") label.append(control, caption); else label.append(caption, control);
      if (input.description) { const hint = document.createElement("small"); hint.textContent = input.description; label.append(hint); }
      deployFields.append(label);
    }
    deployErrorNode.hidden = true; deployStatusNode.textContent = "";
    deploySetBusy(false);
    deployDialog.showModal();
    deployFields.querySelector("input, select")?.focus();
  }
  function collectDeployValues() {
    const values = {};
    for (const control of deployFields.querySelectorAll("[data-deploy-input]")) {
      values[control.dataset.deployInput] = control.type === "checkbox" ? control.checked : control.value.trim();
    }
    return values;
  }
  deployForm.addEventListener("submit", event => {
    event.preventDefault();
    if (deployBusy || !deployWorkflow) return;
    deployErrorNode.hidden = true;
    {
      for (const control of deployFields.querySelectorAll("[data-deploy-input]")) {
        if (control.required && !control.value.trim()) { control.focus(); deployErrorNode.textContent = t("deploy.required", control.dataset.deployInput); deployErrorNode.hidden = false; return; }
        if (control.pattern && control.value && !new RegExp("^(?:" + control.pattern + ")$").test(control.value.trim())) {
          control.focus(); deployErrorNode.textContent = t("deploy.invalid.version", control.dataset.deployInput); deployErrorNode.hidden = false; return;
        }
      }
      // One confirmation: the dialog itself shows the target and values.
      deployValues = collectDeployValues();
    }
    deploySetBusy(true);
    deployStatusNode.textContent = t("deploy.dispatching");
    vscode.postMessage({ type: "deploy.run", workflowId: deployWorkflow.id, inputs: deployValues });
  });
  document.getElementById("deploy-cancel").addEventListener("click", () => deployDialog.close());
  deployDialog.addEventListener("cancel", event => { if (deployBusy) event.preventDefault(); });
  deployDialog.addEventListener("close", () => worktreeButton.focus());
  function worktreeLocationDescription() {
    const tree = conversationWorktree?.worktree;
    const isolated = tree && tree.phase !== "merged";
    return t(isolated ? "worktree.isolated" : "worktree.workspace") +
      (conversationWorktree?.workingDirectory ? " · " + conversationWorktree.workingDirectory : "") +
      (conversationWorktree?.branch ? " · " + conversationWorktree.branch : "") +
      (conversationWorktree?.conflicts?.length ? " · " + t("worktree.conflicts", conversationWorktree.conflicts.join(", ")) : "");
  }

  function renderWorktree() {
    const controls = document.getElementById("worktree-controls");
    if (!controls) return;
    const unavailable = !worktreeSupported || state.role !== "main";
    const pickerHidden = state.role !== "main" || (unavailable && !deployAvailable());
    document.getElementById("worktree-picker").hidden = pickerHidden;
    controls.hidden = unavailable;
    renderDeploy();
    if (pickerHidden && openSettingId === "worktree") closeSettingMenu(false);
    const tree = conversationWorktree?.worktree;
    const isolated = tree && tree.phase !== "merged";
    worktreeButton.classList.toggle("is-connected", Boolean(isolated));
    worktreeButton.title = t("worktree.isolated");
    worktreeButton.setAttribute("aria-label", t("worktree.isolated"));
    const summary = document.getElementById("worktree-summary");
    summary.hidden = !isolated;
    summary.textContent = isolated ? (tree.name || tree.branch) + " · " + tree.branch : "";
    const busy = worktreeBusy || state.running || (state.pendingRequests || []).length > 0 || state.queueCount > 0;
    const create = document.getElementById("worktree-create");
    const merge = document.getElementById("worktree-merge");
    create.hidden = true;
    merge.hidden = (!isolated && !(tree?.workUnit && !tree.cleaned)) || tree?.phase === "creating";
    prompt.readOnly = Boolean(tree?.workUnit && tree.phase === "merged");
    updateSendButton();
    create.disabled = merge.disabled = busy;
    document.getElementById("worktree-refresh").disabled = worktreeBusy;
  }
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
    project: [t("worktree.location"), worktreeLocationDescription()],
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
    { id: "openConversationHistory", group: "history", fallback: "Alt+Shift+H", history: "conversation-history", label: () => t("ui.conversation.history") },
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
  let syntaxRevision = 0;
  let themeUpdate = 0;
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
  const taskFlowParseCache = new WeakMap();
  let taskFlowSnapshot;
  const messageRenderKeys = new WeakMap();
  const eventVersions = new WeakMap();
  const managedCommandCache = new WeakMap();
  const lazyCommandOutputs = new WeakMap();
  let nextEventVersion = 0;
  let botRenderKey;
  const statusElements = new Map();
  const statusRenderKeys = new WeakMap();
  const dirtyCommandBlocks = new Set();
  const dirtyOutputBlocks = new Set();
  let measureAllCommands = false;
  let measureAllOutputs = false;
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
  const notesPanel = document.getElementById("notes-panel");
  const notesToggle = document.getElementById("notes-toggle");
  const notesScopeTabs = Array.from(document.querySelectorAll("[data-notes-scope]"));
  let selectedNotesScope = saved?.notesScope === "global" ? "global" : "workspace";
  try { const cached = localStorage.getItem("agentFactory.notes.scope"); if (cached === "global" || cached === "workspace") selectedNotesScope = cached; } catch { /* Persisted Webview state is the fallback. */ }
  let selectedNoteFolder = "", noteRecords = [], noteFolders = [], noteMoving = null;

  const notesTitle = document.getElementById("notes-title");
  const notesBody = document.getElementById("notes-body");
  const notesStatus = document.getElementById("notes-status");
  const notesResize = document.getElementById("notes-resize");
  let notesResizeStart;
  function resizeNotes(width) {
    const available = notesPanel.parentElement.clientWidth;
    notesPanel.style.width = Math.max(Math.min(200, available - 42), Math.min(width, available - 42)) + "px";
  }
  notesResize.addEventListener("pointerdown", function (event) {
    notesResizeStart = { x: event.clientX, width: notesPanel.getBoundingClientRect().width };
    notesResize.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  notesResize.addEventListener("pointermove", function (event) {
    if (notesResizeStart) resizeNotes(notesResizeStart.width + notesResizeStart.x - event.clientX);
  });
  notesResize.addEventListener("lostpointercapture", function () { notesResizeStart = null; });
  notesResize.addEventListener("keydown", function (event) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    resizeNotes(notesPanel.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 16 : -16));
    event.preventDefault();
  });
  let noteDraft = saved?.noteDraft || null;
  let noteSending = null;
  let noteDirty = Boolean(noteDraft);
  let noteSaveTimer;
  let noteFailed = false;
  if (noteDraft) selectedNotesScope = noteDraft.scope;
  renderNotesScope();
  notesToggle.addEventListener("click", () => setNotesOpen(notesPanel.hidden));
  document.getElementById("notes-close").addEventListener("click", () => setNotesOpen(false));
  notesPanel.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); setNotesOpen(false); }
  });
  function renderNotesScope() {
    for (const tab of notesScopeTabs) {
      const selected = tab.dataset.notesScope === selectedNotesScope;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    document.getElementById("notes-content").setAttribute("aria-labelledby", "notes-tab-" + selectedNotesScope);
  }
  function selectNotesScope(tab) {
    if (noteSending || noteMoving || noteDirty || tab.disabled || tab.dataset.notesScope === selectedNotesScope) return;
    selectedNotesScope = tab.dataset.notesScope;
    selectedNoteFolder = "";
    try { localStorage.setItem("agentFactory.notes.scope", selectedNotesScope); } catch { /* Webview state is also saved. */ }
    persist();
    renderNotesScope();
    loadNotes();
  }
  for (const [index, tab] of notesScopeTabs.entries()) {
    tab.addEventListener("click", () => selectNotesScope(tab));
    tab.addEventListener("keydown", function (event) {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? notesScopeTabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + notesScopeTabs.length) % notesScopeTabs.length;
      if (notesScopeTabs[next].disabled) return;
      selectNotesScope(notesScopeTabs[next]);
      notesScopeTabs[next].focus();
    });
  }
  document.getElementById("notes-new").addEventListener("click", function () {
    if (noteMoving) return;
    if (noteSending || noteDirty) return;
    noteDraft = { folder: selectedNoteFolder, scope: selectedNotesScope, id: crypto.randomUUID(), title: "", body: "", revision: 0 };
    noteDirty = true;
    noteFailed = false;
    renderNoteEditor();
    saveNote();
    notesTitle.focus();
  });
  document.getElementById("notes-back").addEventListener("click", function () {
    noteDraft = null;
    persist();
    loadNotes();
  });
  for (const field of [notesTitle, notesBody]) field.addEventListener("input", function () {
    if (!noteDraft) return;
    noteDraft.title = notesTitle.value;
    noteDraft.body = notesBody.value;
    noteDirty = true;
    persist();
    refreshNoteControls();
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(saveNote, 200);
  });
  document.getElementById("notes-copy").addEventListener("click", function () {
    vscode.postMessage({ type: "message.copy", text: notesBody.value });
  });
  document.getElementById("notes-insert").addEventListener("click", function () {
    prompt.value += (prompt.value && notesBody.value ? "\n\n" : "") + notesBody.value;
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    setNotesOpen(false);
    prompt.focus();
  });
  document.getElementById("notes-save-copy").addEventListener("click", function () {
    if (!noteDraft) return;
    noteDraft.id = crypto.randomUUID();
    noteDraft.revision = 0;
    noteDirty = true;
    noteFailed = false;
    saveNote();
  });
  function setNotesOpen(open) {
    notesPanel.hidden = !open;
    notesToggle.hidden = open;
    notesToggle.setAttribute("aria-expanded", String(open));
    if (open) {
      if (noteDraft) { renderNoteEditor(); if (noteDirty && !noteFailed) saveNote(); }
      else loadNotes();
    } else { saveNote(); notesToggle.focus(); }
  }
  function refreshNoteControls() {
    const pending = Boolean(noteSending || noteDirty);
    document.getElementById("notes-new").disabled = pending;
    for (const tab of notesScopeTabs) tab.disabled = pending;
    document.getElementById("notes-back").disabled = pending;
    document.getElementById("notes-save-copy").hidden = !noteFailed;
    if (!noteFailed) notesStatus.textContent = t(pending ? "notes.saving" : "notes.saved");
  }
  function renderNoteEditor() {
    document.getElementById("notes-list-view").hidden = false;
    document.getElementById("notes-editor").hidden = !noteDraft;
    if (noteDraft) {
      document.getElementById("notes-list-view").hidden = true;
      selectedNotesScope = noteDraft.scope;
      renderNotesScope();
      notesTitle.value = noteDraft.title;
      notesBody.value = noteDraft.body;
    }
    refreshNoteControls();
  }
  function loadNotes() {
    noteDraft = null;
    noteDirty = false;
    noteFailed = false;
    renderNoteEditor();
    persist();
    document.getElementById("notes-list").replaceChildren();
    notesStatus.textContent = t("notes.loading");
    vscode.postMessage({ type: "notes.list", scope: selectedNotesScope });
  }
  function saveNote() {
    clearTimeout(noteSaveTimer);
    if (!noteDraft || !noteDirty || noteSending || noteFailed) return;
    noteSending = { ...noteDraft };
    noteDirty = false;
    const { scope, ...note } = noteSending;
    vscode.postMessage({ type: "notes.save", scope, note });
    refreshNoteControls();
  }
  document.getElementById("notes-folder-form").addEventListener("submit", event => {
    event.preventDefault();
    const input = document.getElementById("notes-folder-name");
    if (!input.value.trim() || noteMoving) return;
    vscode.postMessage({type: "notes.folder", scope: selectedNotesScope, folder: [selectedNoteFolder, input.value.trim()].filter(Boolean).join("/")});
    input.value = "";
  });
  function moveNote(id, folder) {
    const note = noteRecords.find(n => n.id === id);
    if (!note || noteMoving || noteDraft || (note.folder || "") === folder) return;
    noteMoving = {id, scope: selectedNotesScope};
    notesStatus.textContent = t("notes.saving");
    vscode.postMessage({type: "notes.save", scope: selectedNotesScope, note: {...note, folder}});
  }
  function folderDropTarget(element, folder) {
    element.addEventListener("dragover", event => {
      if (!event.dataTransfer.types.includes("application/x-agent-factory-note")) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; element.classList.add("notes-drop-target");
    });
    element.addEventListener("dragleave", () => element.classList.remove("notes-drop-target"));
    element.addEventListener("drop", event => {
      event.preventDefault(); event.stopPropagation(); element.classList.remove("notes-drop-target");
      moveNote(event.dataTransfer.getData("application/x-agent-factory-note"), folder);
    });
  }
  const expandedNoteFolders = { global: new Set(), workspace: new Set() };
  function renderNoteFolders() {
    const list = document.getElementById("notes-list"), crumbs = document.getElementById("notes-breadcrumb");
    list.replaceChildren(); crumbs.replaceChildren();
    const root = document.createElement("button"); root.type = "button"; root.textContent = t("notes.folder.root");
    root.addEventListener("click", () => {selectedNoteFolder = ""; renderNoteFolders();}); folderDropTarget(root, ""); crumbs.append(root);
    const containers = new Map([["", list]]);
    const folders = new Set(noteFolders);
    for (const path of [...noteFolders, ...noteRecords.map(note => note.folder || "")]) {
      const parts = path.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
    }
    function selectFolder(folder) {
      selectedNoteFolder = folder;
      root.setAttribute("aria-current", String(!folder));
      for (const summary of list.querySelectorAll("summary[data-folder]")) {
        summary.setAttribute("aria-current", String(summary.dataset.folder === folder));
      }
    }
    for (const folder of [...folders].sort()) {
      const branch = document.createElement("details"); branch.className = "notes-branch";
      branch.open = expandedNoteFolders[selectedNotesScope].has(folder);
      const summary = document.createElement("summary"); summary.className = "notes-folder";
      summary.textContent = folder.split("/").at(-1); summary.dataset.folder = folder;
      summary.addEventListener("click", () => selectFolder(folder));
      const scope = selectedNotesScope;
      branch.addEventListener("toggle", () => {
        if (!branch.isConnected) return;
        if (branch.open) expandedNoteFolders[scope].add(folder);
        else expandedNoteFolders[scope].delete(folder);
      });
      folderDropTarget(summary, folder);
      const children = document.createElement("div"); children.className = "notes-children";
      branch.append(summary, children);
      containers.get(folder.split("/").slice(0, -1).join("/")).append(branch);
      containers.set(folder, children);
    }
    selectFolder(selectedNoteFolder);
    for (const note of noteRecords) {
      const row = document.createElement("div"); row.className = "notes-entry";
      const button = document.createElement("button"); button.type = "button"; button.textContent = note.title || t("notes.untitled"); button.draggable = true; button.dataset.noteId = note.id;
      button.addEventListener("dragstart", event => {event.dataTransfer.setData("application/x-agent-factory-note", note.id); event.dataTransfer.effectAllowed = "move";});
      button.addEventListener("click", () => {if(noteMoving) return; noteDraft = {...note, scope:selectedNotesScope}; noteDirty = false; renderNoteEditor(); notesBody.focus();});
      row.append(button);
      containers.get(note.folder || "").append(row);
    }
    if (!list.childElementCount) list.textContent = t("notes.empty");
  }
  function receiveNotes(message) {
    if (message.type === "notes.list.result") {
      if (message.scope !== selectedNotesScope || noteDraft) return;
      const list = document.getElementById("notes-list");
      list.replaceChildren();
      notesStatus.textContent = message.error ? t("notes.failed", message.error) : "";
      if (message.error) return;
      noteRecords = message.notes; noteFolders = message.folders || [];
      renderNoteFolders();
      return;
    }
    if (noteMoving && message.scope === noteMoving.scope && message.id === noteMoving.id) {
      noteMoving = null;
      if (message.error) { notesStatus.textContent = t("notes.failed", message.error); renderNoteFolders(); }
      else loadNotes();
      return;
    }
    if (!noteSending || message.scope !== noteSending.scope || message.id !== noteSending.id) return;
    noteSending = null;
    if (message.error) {
      noteDirty = true;
      noteFailed = true;
      notesStatus.textContent = t("notes.failed", message.error);
    } else {
      noteDraft.revision = message.note.revision;
      if (noteDirty) saveNote();
    }
    persist();
    refreshNoteControls();
  }

  const contractList = document.getElementById("contract-list");
  contractList.querySelector("summary").addEventListener("keydown", handleSettingMenuKeydown);
  contractList.addEventListener("toggle", function () {
    if (this.open) {
      document.getElementById("task-history").open = false;
      document.getElementById("conversation-history").open = false;
      document.getElementById("contract-list-list").replaceChildren(historyEmpty("contracts.loading"));
      vscode.postMessage({ type: "contracts.request" });
    }
    positionTaskHistory();
  });
  document.querySelector("#task-history > summary").addEventListener("keydown", handleSettingMenuKeydown);
  document.getElementById("task-history").addEventListener("toggle", positionTaskHistory);
  window.addEventListener("resize", positionTaskHistory);
  new ResizeObserver(positionTaskHistory).observe(submissionMenu);

  const conversationHistory = document.getElementById("conversation-history");
  const conversationList = document.getElementById("conversation-history-list");
  const conversationReader = document.getElementById("conversation-reader");
  const conversationMessages = document.getElementById("conversation-reader-messages");
  const conversationOlder = document.getElementById("conversation-reader-older");
  let conversationReadId = 0;
  let selectedConversationId;
  let conversationBefore;
  let conversationAppending = false;
  conversationList.append(historyEmpty("ui.conversation.empty"));
  conversationHistory.querySelector("summary").addEventListener("keydown", handleSettingMenuKeydown);
  conversationHistory.addEventListener("toggle", function () {
    if (conversationHistory.open) {
      contractList.open = false;
      document.getElementById("task-history").open = false;
      conversationList.replaceChildren(historyEmpty("ui.conversation.loading"));
      vscode.postMessage({ type: "conversations.request" });
    }
    positionTaskHistory();
  });
  document.getElementById("task-history").addEventListener("toggle", function () {
    if (this.open) { conversationHistory.open = false; contractList.open = false; }
  });
  document.getElementById("conversation-reader-close").addEventListener("click", () => conversationReader.close());
  conversationReader.addEventListener("close", function () {
    conversationReadId++;
    submissionButton.focus();
  });
  conversationOlder.addEventListener("click", function () { readSavedConversation(true); });

  function historyEmpty(key) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = t(key);
    return empty;
  }

  function readSavedConversation(append) {
    conversationAppending = append;
    conversationOlder.disabled = true;
    if (!append) conversationMessages.replaceChildren(historyEmpty("ui.conversation.loading"));
    vscode.postMessage({ type: "conversation.read", conversationId: selectedConversationId,
      requestId: "conversation-read-" + (++conversationReadId), ...(append && conversationBefore ? { before: conversationBefore } : {}) });
  }

  function showConversationList(message) {
    conversationList.replaceChildren();
    if (message.error) {
      const error = historyEmpty("ui.conversation.empty");
      error.textContent = t("ui.conversation.failed", message.error);
      conversationList.append(error);
      return;
    }
    for (const entry of message.conversations || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "setting-option conversation-history-entry";
      const date = new Date(entry.startedAt);
      button.textContent = t("ui.conversation.entry", Number.isNaN(date.getTime()) ? entry.startedAt : date.toLocaleString(), entry.runCount);
      button.addEventListener("click", function () {
        selectedConversationId = entry.conversationId;
        conversationBefore = undefined;
        conversationOlder.hidden = true;
        closeSettingMenu(false);
        conversationReader.showModal();
        readSavedConversation(false);
      });
      conversationList.append(button);
    }
    if (!conversationList.children.length) conversationList.append(historyEmpty("ui.conversation.empty"));
    positionTaskHistory();
  }

  function showSavedConversation(message) {
    if (!conversationReader.open || message.requestId !== "conversation-read-" + conversationReadId) return;
    conversationOlder.disabled = false;
    if (message.error) {
      const error = historyEmpty("ui.conversation.empty");
      error.textContent = t("ui.conversation.failed", message.error);
      if (conversationAppending) conversationMessages.prepend(error);
      else conversationMessages.replaceChildren(error);
      return;
    }
    if (!conversationAppending) conversationMessages.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const item of message.history.messages) {
      const article = document.createElement("article");
      const role = document.createElement("strong");
      role.textContent = item.type === "user" ? t("ui.conversation.user") : "Agent";
      const content = document.createElement("div");
      if (item.type === "assistant") renderAssistantMarkdown(content, assistantDisplayText(item.text));
      else { content.className = "history-user-text"; content.textContent = item.text; }
      article.append(role, content);
      fragment.append(article);
    }
    conversationMessages.prepend(fragment);
    conversationBefore = message.history.nextBefore;
    conversationOlder.hidden = !conversationBefore;
    if (!conversationMessages.children.length && !conversationBefore) conversationMessages.append(historyEmpty("ui.conversation.empty"));
  }

  function positionTaskHistory() {
    for (const id of ["contract-list", "task-history", "conversation-history"]) positionHistory(id);
  }

  function positionHistory(id) {
    const history = document.getElementById(id);
    const summary = history.querySelector("summary");
    summary.setAttribute("aria-expanded", String(history.open));
    if (!history.open || submissionMenu.hidden) return;
    const list = document.getElementById(id + "-list");
    const bounds = submissionMenu.getBoundingClientRect();
    const leftSpace = bounds.left - 20;
    const rightSpace = window.innerWidth - bounds.right - 20;
    const inline = Math.max(leftSpace, rightSpace) < 240;
    list.classList.toggle("is-flyout", !inline);
    if (inline) {
      list.style.removeProperty("left");
      list.style.removeProperty("top");
      list.style.removeProperty("height");
      list.style.removeProperty("max-height");
      list.style.removeProperty("width");
      return;
    }
    const onLeft = leftSpace >= rightSpace;
    const width = Math.min(440, onLeft ? leftSpace : rightSpace);
    list.style.left = (onLeft ? bounds.left - width - 8 : bounds.right + 8) + "px";
    list.style.top = bounds.top + "px";
    list.style.height = bounds.height + "px";
    list.style.width = width + "px";
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
    let bytes = 0;
    for (const file of files) {
      if (!file.name || file.name.length > 255 || /[\\/\x00-\x1f]/.test(file.name) || [".", ".."].includes(file.name)) {
        appendNotice("error", t("ui.local.file.read.failed"));
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
      if (unitDialog.open || document.getElementById("image-converter").open) return;
      if (!notesPanel.hidden) {
        event.preventDefault();
        setNotesOpen(false);
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
    if (!event.target.closest("#contract-list")) contractList.open = false;
    if (!event.target.closest("#conversation-history")) document.getElementById("conversation-history").open = false;
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
      return file.type.startsWith("image/");
    });
    // Some screenshot tools expose the image only as a clipboard item, leaving files empty.
    if (!images.length) images = Array.from(event.clipboardData.items || []).filter(function (item) {
      return item.kind === "file" && item.type.startsWith("image/");
    }).map(function (item) { return item.getAsFile(); }).filter(Boolean);
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
        agentPresetBusy = false;
        if (message.error) {
          pendingPresetName = "";
          const scopeControl = document.getElementById("agent-default-scope");
          if (scopeControl && state.agentSettingsScope) scopeControl.value = state.agentSettingsScope;
        }
        const status = document.getElementById("agent-preset-status"); status.hidden = !message.error; status.textContent = message.error || "";
        if (!message.error && message.settings && message.scope && message.name) applyAgentSettingsToChat(message.settings, message.scope, message.name);
        renderAgentDefaults();
        renderAgentPresets();
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
        renderAgentDefaults();
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
          if (currentTaskFlows().length === 0) state.runPanelExpanded = false;
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
        void updateSyntaxTheme(message.selection || {});
        break;
      case "worktree.created":
        unitSetBusy(false); unitStatus.textContent = "";
        if (message.error) {
          unitError.textContent = message.error; unitError.hidden = false;
          if (message.created) document.getElementById("unit-create-submit").disabled = true;
        } else unitDialog.close();
        break;
      case "deploy.targets":
        deployLoading = false;
        deployTarget = message.target;
        deployError = message.error || "";
        renderWorktree();
        break;
      case "deploy.status":
        if (message.error) {
          if (deployDialog.open) { deploySetBusy(false); deployStatusNode.textContent = ""; deployErrorNode.textContent = message.error; deployErrorNode.hidden = false; }
          else deployError = message.error;
        } else if (message.run) {
          deployRun = message.run; deployRepository = message.repository || deployRepository;
          if (deployDialog.open) { deploySetBusy(false); deployDialog.close(); }
        }
        renderWorktree();
        break;
      case "worktree.repositories": {
        unitRepositories = message.repositories;
        const list = document.getElementById("worktree-repositories");
        list.replaceChildren();
        for (const repo of message.repositories) {
          const button = document.createElement("button"); button.type = "button"; button.className = "setting-option";
          button.setAttribute("role", "menuitem"); button.classList.add("worktree-repository");
          button.title = repo.path;
          const name = document.createElement("strong"); name.textContent = repo.path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || repo.path;
          const path = document.createElement("span"); path.className = "worktree-repository-path"; path.textContent = repo.path;
          const action = document.createElement("span"); action.className = "worktree-repository-action"; action.textContent = "+ " + t("worktree.create");
          button.append(name, path, action);
          button.addEventListener("click", () => { openUnitCreate(repo.path); });
          button.addEventListener("keydown", handleSettingMenuKeydown); list.append(button);
        }
        if (!message.repositories.length) {
          const empty = document.createElement("p"); empty.className = "worktree-summary"; empty.textContent = t("worktree.empty"); list.append(empty);
        }
        positionWorktreeMenu();
        break;
      }
      case "composer.prefill":
        prompt.value = message.text;
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
        break;
      case "worktree.updated":
        if (typeof message.supported === "boolean") worktreeSupported = message.supported;
        if (typeof message.busy === "boolean") worktreeBusy = message.busy;
        conversationWorktree = message.value;
        renderWorktree();
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
        receiveProviders(message);
        break;
      case "providers.catalog":
        providerCatalog = message.catalog;
        providerVersionsRequested = false;
        renderProviderSettings();
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
        showConversionResult(message);
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
        sudoChallenge = message;
        sudoPanel.setAttribute("aria-label", t("sudo.title"));
        sudoPassword.setAttribute("aria-label", t("sudo.password"));
        sudoTitle.textContent = t("sudo.title");
        sudoCommand.textContent = message.command.map(arg => JSON.stringify(arg)).join(" ");
        sudoContext.textContent = t("sudo.context", message.cwd || "", message.agentId || "", message.runId || "");
        sudoSubmit.textContent = t("sudo.run");
        sudoCancel.textContent = t("sudo.cancel");
        sudoSubmit.disabled = false;
        sudoPanel.hidden = false;
        sudoPanel.scrollIntoView({ block: "nearest" });
        break;
      case "sudo.closed":
        closeSudoPanel();
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
        receiveNotes(message);
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
        positionTaskHistory();
        break;
      }
      case "conversations.list":
        showConversationList(message);
        break;
      case "conversation.read.result":
        showSavedConversation(message);
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
            return entry.type === "assistant" && !entry.streaming && entry.runId === message.runId && entry.text === message.text &&
              entry.phase === (message.phase === "commentary" ? "commentary" : "final");
          })) break;
          if (isDuplicateCancellation(state.timeline.at(-1), { ...message, type: "assistant" })) break;
          const incomingFlows = extractTaskFlows(message.text).flows;
          if (incomingFlows.length) {
            const snapshots = new Map(currentTaskFlows().map(flow => [flow.id, flow]));
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
          renderWorkLoopPanel();
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
        renderWorktree();
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
        renderWorkLoopPanel();
        persist(false);
        break;
    }
  });

  function submit(action = "direct", workflow = "normal", asGoal = false, choiceAnswer = null) {
    if (conversationClearing || (conversationWorktree?.worktree?.workUnit && conversationWorktree.worktree.phase === "merged")) return;
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
        agentModels: state.role === "main" ? effectiveDelegatedModels() : undefined,
        agentPermissions: state.role === "main" ? Object.fromEntries(["main", "work", "verification"].map(role => [role, state.executionMode || "cli-default"])) : undefined,
        // Preserve an explicit selection so the host can reject an unavailable
        // provider instead of silently falling back to another model.
        model: effectiveAgentValue("main", "model") || undefined,
        reasoningEffort: currentCapabilities().reasoning ? effectiveAgentValue("main", "reasoningEffort") || undefined : undefined,
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
    return indexedTimeline().latestTurn === event && !event.choiceAnswer && !state.running && !state.pendingRequests?.length && state.runtimeAvailable;
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
        let parsed = taskFlowParseCache.get(event);
        if (!parsed || parsed.text !== text) {
          parsed = { text, flows: extractTaskFlows(text).flows };
          taskFlowParseCache.set(event, parsed);
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
    if (!markdown) {
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
    fragment.innerHTML = markdown.render(text);
    renderMath(fragment);
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
      if (!accepted.includes(file.type) || file.size < 1) {
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
      const renderKey = [eventVersion(event), syntaxRevision, uiLocale(),
        event.type === "assistant" ? assistantContext : null,
        event.type === "assistant" ? canAnswerInterview(event) : null,
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
          details: Array.from(element.querySelectorAll("details")).map(function (details, index) { return { key: details.dataset.disclosureKey || details.className + ":" + index, open: details.open, hidden: details.hidden, loaded: lazyCommandOutputs.has(details) && Boolean(details.querySelector("pre")) }; }),
          scroll: Array.from(element.querySelectorAll("pre")).map(function (pre) { return { top: pre.scrollTop, left: pre.scrollLeft }; })
        });
      }
      const message = document.createElement("article");
      message.className = "message message-" + event.type;
      message.dataset.id = event.id;
      const compaction = event.type === "activity" && event.category === "tool" &&
        ["Context compaction", "컨텍스트 압축", t("ui.context.compaction")].includes(event.title);
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
      } else if (event.type === "assistant") {
        const taskContent = extractTaskFlows(assistantDisplayText(localizedText(event.text, event.localization)));
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
          if (previous) {
            details.open = previous.open;
            details.hidden = previous.hidden && !previous.open;
            if (previous.open || previous.loaded) lazyCommandOutputs.get(details)?.();
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
          details: Array.from(element.querySelectorAll("details")).map((details, index) => ({ key: details.dataset.disclosureKey || details.className + ":" + index, open: details.open, hidden: details.hidden, loaded: lazyCommandOutputs.has(details) && Boolean(details.querySelector("pre")) })),
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
      commandDisclosureObserver = new ResizeObserver(function () {
        measureAllCommands = true;
        scheduleCommandDisclosureMeasurement();
      });
      commandDisclosureObserver.observe(timeline);
    }
    scheduleCommandDisclosureMeasurement(commandBlock);
    void applySyntaxHighlighting(commandCode, command, "bash").then(function () {
      scheduleCommandDisclosureMeasurement(commandBlock);
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

  function scheduleCommandDisclosureMeasurement(block) {
    if (block) dirtyCommandBlocks.add(block);
    if (commandDisclosureFrame) return;
    commandDisclosureFrame = requestAnimationFrame(function () {
      commandDisclosureFrame = undefined;
      const blocks = measureAllCommands ? timeline.querySelectorAll(".terminal-command-block") : dirtyCommandBlocks;
      const updates = [];
      for (const block of blocks) {
        if (!block.isConnected) continue;
        const text = block.querySelector(".bash-command-text");
        const toggle = block.querySelector(".bash-command-toggle");
        if (!text || !toggle || text.classList.contains("is-expanded")) continue;
        updates.push([toggle, text.scrollHeight <= text.clientHeight + 1]);
      }
      dirtyCommandBlocks.clear();
      measureAllCommands = false;
      for (const [toggle, hidden] of updates) if (toggle.hidden !== hidden) toggle.hidden = hidden;
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
    const text = output || t("ui.no.output");
    block.classList.toggle("is-empty", !output);
    // Bound preview work by both lines and bytes; full evidence stays available on demand.
    let previewText = text.slice(0, 2048).split("\n").slice(0, 8).join("\n");
    const truncated = previewText.length < text.length;
    if (truncated) previewText += "\x1b[0m…";
    const preview = createCommandOutput(previewText);
    preview.classList.add("terminal-output-preview");
    const details = document.createElement("details");
    details.className = "terminal-output-details";
    const summary = document.createElement("summary");
    summary.textContent = t("ui.view.run.result");
    details.append(summary);
    let loaded = false;
    function loadOutput() {
      if (loaded) return;
      loaded = true;
      details.append(createCommandOutput(text));
    }
    lazyCommandOutputs.set(details, loadOutput);
    summary.addEventListener("click", function () {
      if (!details.open) loadOutput();
    });
    details.addEventListener("toggle", function () {
      if (details.open) loadOutput();
      scheduleCommandOutputMeasurement(block);
    });
    block.dataset.truncated = String(truncated);
    block.append(preview, details);
    container.append(block);
    if (!commandOutputObserver) {
      commandOutputObserver = new ResizeObserver(function () {
        measureAllOutputs = true;
        scheduleCommandOutputMeasurement();
      });
      commandOutputObserver.observe(timeline);
    }
    scheduleCommandOutputMeasurement(block);
  }

  function scheduleCommandOutputMeasurement(block) {
    if (block) dirtyOutputBlocks.add(block);
    if (commandOutputFrame) return;
    commandOutputFrame = requestAnimationFrame(function () {
      commandOutputFrame = undefined;
      const blocks = measureAllOutputs ? timeline.querySelectorAll(".terminal-output-block") : dirtyOutputBlocks;
      const updates = [];
      for (const block of blocks) {
        if (!block.isConnected) continue;
        const preview = block.querySelector(".terminal-output-preview");
        const details = block.querySelector(".terminal-output-details");
        updates.push([details, !details.open && block.dataset.truncated !== "true" && !block.classList.contains("terminal-output-collapsed") && preview.scrollHeight <= preview.clientHeight + 1]);
      }
      dirtyOutputBlocks.clear();
      measureAllOutputs = false;
      for (const [details, hidden] of updates) if (details.hidden !== hidden) details.hidden = hidden;
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
          if (revision !== syntaxRevision || !code.isConnected) return;
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
      if (revision !== syntaxRevision || !element.isConnected || highlighted.length === 0) return;
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

  // Math is tokenized before Markdown escapes so TeX backslashes survive; KaTeX renders MathML, which needs no inline styles under the CSP.
  function markdownMath(md) {
    const escape = md.utils.escapeHtml;
    md.block.ruler.before("fence", "math_block", function (state, startLine, endLine, silent) {
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
      const close = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\]" : "";
      if (!close) return false;
      let content = first.slice(2).trimEnd();
      let line = startLine;
      let closed = content.endsWith(close);
      if (closed) content = content.slice(0, -2);
      while (!closed) {
        if (++line >= endLine) return false;
        const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trimEnd();
        closed = text.endsWith(close);
        content += "\n" + (closed ? text.slice(0, -2) : text);
      }
      if (!content.trim()) return false;
      if (silent) return true;
      const token = state.push("math_block", "div", 0);
      token.block = true;
      token.content = content.trim();
      token.map = [startLine, line + 1];
      state.line = line + 1;
      return true;
    }, { alt: ["paragraph", "reference", "blockquote", "list"] });
    md.inline.ruler.before("escape", "math_inline", function (state, silent) {
      const src = state.src;
      const start = state.pos;
      const open = src.startsWith("\\(", start) ? "\\(" : src.startsWith("$$", start) ? "$$" : src[start] === "$" ? "$" : "";
      if (!open) return false;
      const close = open === "\\(" ? "\\)" : open;
      const from = start + open.length;
      // Currency and shell variables stay text: `$` must hug its content and not close before a digit.
      if (open === "$" && (!src[from] || /\s/.test(src[from]))) return false;
      let end = from;
      while ((end = src.indexOf(close, end)) !== -1) {
        if (open !== "\\(" && src[end - 1] === "\\") { end += 1; continue; }
        if (open === "$" && (/\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || ""))) { end += 1; continue; }
        break;
      }
      // Never reach across a code span.
      if (end === -1 || end === from || src.slice(from, end).includes("`")) return false;
      if (!silent) {
        const token = state.push("math_inline", "span", 0);
        token.content = src.slice(from, end);
        token.info = open === "$$" ? "display" : "";
      }
      state.pos = end + close.length;
      return true;
    });
    md.renderer.rules.math_inline = function (tokens, index) {
      const token = tokens[index];
      return '<span class="math-inline"' + (token.info ? ' data-display="true"' : "") + ' data-tex="' + escape(token.content) + '">' + escape(token.content) + "</span>";
    };
    md.renderer.rules.math_block = function (tokens, index) {
      return '<div class="math-block" data-tex="' + escape(tokens[index].content) + '">' + escape(tokens[index].content) + "</div>\n";
    };
  }

  // Model HTML stays escaped except attribute-free inline formatting tags, and table alignment
  // becomes a class because the webview CSP drops inline style attributes.
  function markdownSafeMarkup(md) {
    const safeTags = new Set(["u", "mark", "sub", "sup", "kbd", "ins", "del", "s", "small", "br"]);
    md.inline.ruler.after("escape", "safe_inline_tag", function (state, silent) {
      if (state.src.charCodeAt(state.pos) !== 0x3C) return false;
      const match = /^<(\/?)([a-z]+)\s*(\/?)>/i.exec(state.src.slice(state.pos));
      if (!match) return false;
      const tag = match[2].toLowerCase();
      if (!safeTags.has(tag) || (match[1] && tag === "br")) return false;
      if (!silent) {
        const token = state.push("safe_inline_tag", tag, 0);
        token.meta = { closing: Boolean(match[1]) };
        token.markup = match[0];
      }
      state.pos += match[0].length;
      return true;
    });
    md.renderer.rules.safe_inline_tag = function (tokens, index) {
      const token = tokens[index];
      return token.tag === "br" ? "<br>" : "<" + (token.meta.closing ? "/" : "") + token.tag + ">";
    };
    // Unmatched opening or closing tags fall back to their literal text.
    md.core.ruler.push("safe_inline_tag_balance", function (state) {
      for (const block of state.tokens) {
        if (block.type !== "inline" || !block.children) continue;
        const open = [];
        const unmatched = new Set();
        for (const token of block.children) {
          if (token.type !== "safe_inline_tag" || token.tag === "br") continue;
          if (!token.meta.closing) open.push(token);
          else if (open.length && open[open.length - 1].tag === token.tag) open.pop();
          else unmatched.add(token);
        }
        for (const token of open) unmatched.add(token);
        for (const token of unmatched) { token.type = "text"; token.content = token.markup; }
      }
    });
    md.core.ruler.push("table_align_class", function (state) {
      for (const token of state.tokens) {
        const style = token.attrGet && token.attrGet("style");
        const align = style && /text-align:(left|center|right)/.exec(style);
        if (!align) continue;
        token.attrs = token.attrs.filter(function (attr) { return attr[0] !== "style"; });
        token.attrJoin("class", "align-" + align[1]);
      }
    });
  }

  function loadVendorScript(file, name) {
    if (globalThis[name]) return Promise.resolve(globalThis[name]);
    if (!vendorBase) return Promise.reject(new Error(file));
    if (!vendorLoads.has(file)) {
      vendorLoads.set(file, new Promise(function (resolve, reject) {
        const script = document.createElement("script");
        script.nonce = scriptNonce;
        script.src = new URL(file, vendorBase).href;
        script.onload = function () { globalThis[name] ? resolve(globalThis[name]) : reject(new Error(file)); };
        script.onerror = function () { vendorLoads.delete(file); reject(new Error(file)); };
        document.head.append(script);
      }));
    }
    return vendorLoads.get(file);
  }

  // Unrendered TeX stays visible as source until KaTeX is available; previews render only once it has loaded.
  function renderMath(root) {
    const nodes = Array.from(root.querySelectorAll(".math-inline[data-tex], .math-block[data-tex]"));
    if (!nodes.length) return;
    const apply = function (katex) {
      for (const node of nodes) {
        const tex = node.dataset.tex;
        if (tex === undefined) continue;
        try {
          katex.render(tex, node, { displayMode: node.classList.contains("math-block") || node.dataset.display === "true", output: "mathml", throwOnError: false, strict: "ignore", trust: false });
          delete node.dataset.tex;
        } catch {
          node.classList.add("math-error");
        }
      }
    };
    if (globalThis.katex) apply(globalThis.katex);
    else void loadVendorScript("katex.min.js", "katex").then(apply, function () {});
  }

  // Diagrams become data: SVG images: the document CSP blocks Mermaid's inline <style>, an image document does not.
  function renderMermaid(root) {
    for (const code of root.querySelectorAll("pre > code.language-mermaid:not([data-mermaid])")) {
      const source = code.textContent;
      code.dataset.mermaid = "pending";
      const place = function (src) {
        const pre = code.parentElement;
        if (!pre || pre.tagName !== "PRE") return;
        const figure = document.createElement("figure");
        figure.className = "mermaid-diagram";
        const image = document.createElement("img");
        image.alt = source;
        image.src = src;
        figure.append(image);
        pre.replaceWith(figure);
      };
      if (mermaidImages.has(source)) { place(mermaidImages.get(source)); continue; }
      mermaidQueue = mermaidQueue.then(function () {
        return loadVendorScript("mermaid.min.js", "mermaid");
      }).then(async function (mermaid) {
        if (!mermaidImages.has(source)) {
          const light = document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light");
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: light ? "default" : "dark", htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: getComputedStyle(document.body).fontFamily });
          const { svg } = await mermaid.render("af-mermaid-" + ++mermaidSequence, source);
          mermaidImages.set(source, svgImageSource(svg));
        }
        place(mermaidImages.get(source));
      }).catch(function () {
        code.dataset.mermaid = "failed";
      });
    }
  }

  function svgImageSource(markup) {
    const svg = new DOMParser().parseFromString(markup, "text/html").querySelector("svg");
    const box = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    if (box.length === 4 && box[2] > 0 && box[3] > 0) {
      svg.setAttribute("width", String(Math.ceil(box[2])));
      svg.setAttribute("height", String(Math.ceil(box[3])));
      svg.removeAttribute("style");
    }
    const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(svg));
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    return "data:image/svg+xml;base64," + btoa(binary);
  }

  function finishAssistantMarkdown(container) {
    renderMath(container);
    renderMermaid(container);
    for (const img of container.querySelectorAll("img[src]")) {
      const href = img.getAttribute("src");
      if (img.dataset.localImage || !/^(?:file:\/\/|\/|\.\.?\/)/i.test(href)) continue;
      img.dataset.localImage = href;
      img.removeAttribute("src");
      vscode.postMessage({ type: "image.resolve", href });
    }
    for (const code of container.querySelectorAll("pre > code")) {
      if (code.dataset.highlighted === "true" || code.dataset.mermaid) continue;
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

  function extractTaskFlows(text) {
    const flows = [];
    const rest = text.replace(/^```task-flow\s*\n([\s\S]*?)^```\s*$/gm, function (block, json) {
      try {
        const flow = JSON.parse(json);
        const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
        const validText = value => typeof value === "string" && value.trim();
        const statuses = ["pending", "running", "verifying", "completed", "failed", "blocked", "cancelled"];
        if (!validId(flow.id) || !validText(flow.title) || !Array.isArray(flow.tasks) || !flow.tasks.length) return block;
        if (!flow.tasks.every(task => task && validId(task.id) && validText(task.title) && statuses.includes(task.status) &&
          (task.description === undefined || (typeof task.description === "string")) &&
          (task.agentId === undefined || validId(task.agentId)) && (task.runId === undefined || validId(task.runId)))) return block;
        if (new Set(flow.tasks.map(task => task.id)).size !== flow.tasks.length) return block;
        flows.push(flow);
        return "";
      } catch { return block; }
    });
    return { text: rest, flows };
  }

  function currentTaskFlows() {
    const index = indexedTimeline();
    const inputs = [index, index.flowRevision, state.taskFlows,
      state.childAgents, state.workflows, t("ui.verification")];
    if (taskFlowSnapshot && inputs.every((value, index) => value === taskFlowSnapshot.inputs[index])) {
      return taskFlowSnapshot.flows;
    }
    const flows = new Map(index.flows);
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
      if (count === 0) continue;
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

  function createTaskHistoryEntry(flow) {
    const item = document.createElement("li");
    const disclosure = document.createElement("details");
    disclosure.className = "task-history-disclosure";
    disclosure.dataset.historyId = flow.id;
    const heading = document.createElement("summary");
    const name = document.createElement("span");
    name.className = "task-history-name";
    name.textContent = flow.title;
    const count = document.createElement("span");
    count.className = "task-history-count";
    count.textContent = t("flow.task.count", summarizeTaskFlow(flow, true).total);
    heading.append(name, count);
    disclosure.append(heading, createTaskFlow(flow, true));
    item.append(disclosure);
    return item;
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
    const contractList = document.getElementById("contract-list");
    const flows = displayTaskFlows();
    const active = flows.filter(unfinishedFlow);
    const history = flows.filter(flow => !unfinishedFlow(flow));
    const boundRuns = new Set(flows.flatMap(flow => flow.tasks.map(task => task.agentId + "/" + task.runId)));
    const legacyHistory = state.childAgents.filter(agent => acceptedTaskAgent(agent) &&
      ["completed", "failed", "cancelled"].includes(agent.status) && !boundRuns.has(agent.agentId + "/" + agent.runId) &&
      !(state.workflows || []).some(snapshot => snapshot.workflow?.id === agent.taskBinding?.workflowId));
    const historyPanel = document.getElementById("task-history");
    const historyList = document.getElementById("task-history-list");
    contractList.hidden = state.role !== "main";
    if (contractList.hidden) contractList.open = false;
    historyPanel.hidden = state.role !== "main";
    document.getElementById("conversation-history").hidden = state.role !== "main";
    if (historyPanel.hidden) historyPanel.open = false;
    const historySignature = JSON.stringify([history, state.childAgents, t("flow.status.pending")]);
    if (historyList.dataset.signature !== historySignature) {
      historyList.dataset.signature = historySignature;
      const expanded = new Set(Array.from(historyList.querySelectorAll(".task-history-disclosure[open]"), item => item.dataset.historyId));
      const list = document.createElement("ul");
      list.className = "task-history-entries";
      list.append(...history.map(createTaskHistoryEntry), ...legacyHistory.map(agent => {
        const item = document.createElement("li");
        item.append(createRunStage(agent));
        return item;
      }));
      for (const item of list.querySelectorAll(".task-history-disclosure")) item.open = expanded.has(item.dataset.historyId);
      historyList.replaceChildren(history.length || legacyHistory.length ? list : historyEmpty("ui.task.history.empty"));
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
    if (typeof title === "string" && title.trim()) return title;
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

  let conversionDraft;
  const converter = document.getElementById("image-converter");
  const conversionFormat = document.getElementById("image-converter-format");
  const conversionSubmit = document.getElementById("image-converter-submit");
  const conversionReveal = document.getElementById("image-converter-reveal");
  const conversionStatus = document.getElementById("image-converter-status");
  document.getElementById("image-converter-close").addEventListener("click", () => converter.close());
  converter.addEventListener("cancel", event => { if (conversionDraft?.busy) event.preventDefault(); });
  conversionSubmit.addEventListener("click", function () {
    if (!conversionDraft || conversionDraft.busy) return;
    conversionDraft.requestId = createId();
    conversionDraft.busy = true;
    conversionSubmit.disabled = conversionFormat.disabled = true;
    document.getElementById("image-converter-close").disabled = true;
    conversionReveal.hidden = true;
    conversionStatus.dataset.error = "false";
    conversionStatus.textContent = t("attachment.convert.busy");
    vscode.postMessage({ type: "attachment.convert", id: conversionDraft.attachment.id,
      name: conversionDraft.attachment.name, requestId: conversionDraft.requestId, mediaType: conversionFormat.value });
  });
  conversionReveal.addEventListener("click", function () {
    if (conversionDraft?.saved) vscode.postMessage({ type: "attachment.revealConverted", id: conversionDraft.requestId });
  });
  function openImageConverter(attachment) {
    conversionDraft = { attachment, busy: false };
    document.getElementById("image-converter-name").textContent = attachment.name;
    document.getElementById("image-converter-name").title = attachment.name;
    const preview = document.getElementById("image-converter-preview");
    const icon = document.getElementById("image-converter-icon");
    preview.hidden = !attachment.previewUri;
    icon.hidden = Boolean(attachment.previewUri);
    preview.onerror = function () { preview.hidden = true; icon.hidden = false; };
    if (attachment.previewUri) preview.src = attachment.previewUri;
    else preview.removeAttribute("src");
    const sourceType = attachment.mediaType || ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" })[attachment.name.split(".").pop().toLowerCase()];
    conversionFormat.replaceChildren();
    for (const [label, mediaType] of [["PNG", "image/png"], ["JPG", "image/jpeg"], ["WebP", "image/webp"]]) {
      if (mediaType === sourceType) continue;
      const option = document.createElement("option"); option.value = mediaType; option.textContent = label;
      conversionFormat.append(option);
    }
    conversionStatus.textContent = "";
    conversionStatus.dataset.error = "false";
    conversionReveal.hidden = true;
    conversionSubmit.disabled = conversionFormat.disabled = false;
    document.getElementById("image-converter-close").disabled = false;
    converter.showModal();
    conversionFormat.focus();
  }
  function showConversionResult(message) {
    if (!conversionDraft || conversionDraft.requestId !== message.id) return;
    conversionDraft.busy = false;
    conversionDraft.saved = Boolean(message.path && !message.error);
    if (conversionDraft.saved) {
      // Detach only from the draft; the original file and sent history remain intact.
      state.attachments = state.attachments.filter(attachment => attachment.id !== conversionDraft.attachment.id);
      renderAttachments();
      updateSendButton();
      persist();
    }
    conversionSubmit.disabled = conversionFormat.disabled = false;
    document.getElementById("image-converter-close").disabled = false;
    conversionReveal.hidden = !conversionDraft.saved;
    conversionStatus.dataset.error = String(Boolean(message.error));
    conversionStatus.textContent = message.error || t("attachment.convert.saved", message.path);
  }

  function bindAttachmentConversion(element, attachment) {
    if (attachment.kind !== "image" || attachment.pending || !attachment.uri) return;
    element.tabIndex = 0;
    const open = function (event) {
      event.preventDefault();
      event.stopPropagation();
      openImageConverter(attachment);
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

  function openQuestionMenu() {
    closeSettingMenu(false);
    closeSessionMenu(false);
    renderQuestionList();
    questionMenu.hidden = false;
    positionQuestionMenu();
    questionButton.setAttribute("aria-expanded", "true");
    questionList.querySelector("[data-question-id]")?.focus();
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
    renderGeneralSettings();
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
    renderAgentDefaults();
    for (const item of settingsTabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden = !selected;
    }
    renderStatusCatalog();
    renderAccountUsage();
    if (tab.dataset.settingsTab === "providers" && !providerVersionsRequested) {
      providerVersionsRequested = true;
      providerCatalog = null;
      renderProviderSettings();
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
      case "project": return Boolean(state.projectName || conversationWorktree?.workingDirectory);
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
      project: t(conversationWorktree?.worktree && conversationWorktree.worktree.phase !== "merged" ? "worktree.status.tree" : "worktree.status.home"),
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
      model: t("ui.model.b32422") + (supported.model ? effectiveAgentValue("main", "model") || t("ui.default") : t("ui.unknown")),
      reasoning: t("ui.reasoning.529e9c") + (supported.reasoning ? reasoningDisplayLabel(effectiveAgentValue("main", "reasoningEffort")) : t("ui.unknown")),
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
    sendButton.disabled = conversationClearing || !state.runtimeAvailable || !state.capabilities || Boolean(conversationWorktree?.worktree?.workUnit && conversationWorktree.worktree.phase === "merged");
  }

  function updateRunControls() {
    renderWorktree();
    renderPendingQueue();
    updateExecutionControl();
    updateComposerControls();
    renderRunStatus();
    renderWorkLoopPanel();
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
    if (openSettingId === "model" && document.getElementById("agent-default-scope").value === "chat") renderModelSettings(modelMenu);
    updateExecutionControl();
    const supported = currentCapabilities();
    modelButton.parentElement.hidden = false;
    submissionButton.hidden = state.role !== "main";
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
    promptSurface.classList.toggle("is-astra", /(?:^|[-/])astra(?:$|-)/i.test(effectiveAgentValue("main", "model")));
    const modelText = (effectiveAgentValue("main", "model") ? modelOptionLabel(effectiveAgentValue("main", "model")) : t("ui.default")) + " · " + reasoningDisplayLabel(effectiveAgentValue("main", "reasoningEffort"));
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
    if (setting === "worktree" && state.role === "main") requestDeployTargets();
    const button = settingButton(setting);
    const menu = settingMenu(setting);
    renderSettingMenu(setting, menu);
    menu.hidden = false;
    if (setting === "worktree") positionWorktreeMenu();
    button.setAttribute("aria-expanded", "true");
    const selected = menu.querySelector('[aria-checked="true"]:not(:disabled)');
    (selected || menu.querySelector("button:not(:disabled), select:not(:disabled), details:not([hidden]) > summary"))?.focus();
  }

  function agentSettingRole(role) {
    return role === "main" ? state.role || "main" : role;
  }
  function effectiveAgentValue(role, field) {
    const own = role === "main" ? (field === "model" ? state.model : state.reasoning) : state.agentModels?.[role]?.[field];
    return own || "";
  }
  function effectiveDelegatedModels() {
    return Object.fromEntries(["work", "workLight", "verification"].map(role => [role, Object.fromEntries(
      ["model", "reasoningEffort"].map(field => [field, effectiveAgentValue(role, field) || undefined]))]));
  }
  function createAgentSettingControl(role, label, field, current, onChange, lockRoute = true) {
    const wrapper = document.createElement("label");
    const fieldLabel = field === "model" ? t("ui.model") : t("ui.reasoning");
    const caption = document.createElement("span");
    caption.className = "agent-model-caption";
    caption.textContent = fieldLabel;
    wrapper.append(caption);
    const explicitValues = field === "model" ? [...new Set([...settingOptions.model, current].filter(value => typeof value === "string" && value.length > 0))] : settingOptions.reasoning.filter(Boolean);
    const values = explicitValues;
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
      control.id = "agent-model-" + role + "-" + createId();
      wrapper.htmlFor = control.id; // The vendor tabs below are buttons; keep the label on the select.
      renderModelPicker(wrapper, control, values, current || "", role === "main" && lockRoute);
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
    if (isReasoning) {
      control.addEventListener("input", function () {
        if (control.disabled) return;
        showEffort();
      });
      control.addEventListener("change", function () {
        if (control.disabled) return;
        showEffort();
        onChange(selectedValue());
      });
    } else control.addEventListener("change", function () {
      if (control.disabled) return;
      onChange(selectedValue());
    });
    if (slider) {
      slider.append(control);
      wrapper.append(slider);
    } else wrapper.append(control);
    return wrapper;
  }

  // Vendor tabs group a long catalog. A route is the CLI that runs the model: Codex, Claude Code
  // or Antigravity (gemini-* and antigravity/<id>, which may be another vendor's model).
  const MODEL_VENDORS = [["openai", "OpenAI"], ["anthropic", "Anthropic"], ["google", "Google"]];
  function modelRoute(model) {
    return model.startsWith("antigravity/") || model.startsWith("gemini-") ? "antigravity" : model.startsWith("claude-") ? "claude" : "codex";
  }
  function modelVendor(model) {
    const id = model.replace(/^antigravity\//, "");
    return id.startsWith("claude-") ? "anthropic" : id.startsWith("gemini-") ? "google" : "openai";
  }
  function modelOptionLabel(model) {
    return model.startsWith("antigravity/") ? model.slice("antigravity/".length) + " · Antigravity" : model;
  }

  function hasStartedModelConversation() {
    return Boolean(state.running || state.pendingRequests?.some(item => !item.rejected) ||
      state.startedMessageIds?.length || state.timeline?.some(item => item.type === "user" || item.type === "assistant"));
  }

  function renderModelPicker(wrapper, control, values, current, lockRoute) {
    const models = values.filter(Boolean);
    wrapper.classList.add("agent-model-picker");
    // A started conversation keeps its provider; other routes apply to a new or cleared chat.
    const locked = lockRoute && hasStartedModelConversation()
      ? currentCapabilities().sessionProvider || (current ? modelRoute(current) : undefined)
      : undefined;
    const tabs = document.createElement("span");
    tabs.className = "model-vendor-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", t("ui.model.vendor"));
    let active = current ? modelVendor(current) : (MODEL_VENDORS.find(([vendor]) => models.some(m => modelVendor(m) === vendor)) || MODEL_VENDORS[0])[0];
    let entries = [];
    let selectedModel = current || "";
    const show = () => {
      for (const tab of tabs.children) tab.setAttribute("aria-selected", String(tab.dataset.vendor === active));
      // Native select popups may ignore hidden on options/optgroups. Exclude other
      // vendors from the actual select, retaining the nodes for subsequent tabs.
      control.replaceChildren(...entries.filter(element => !element.dataset.vendor || element.dataset.vendor === active));
      control.value = selectedModel;
    };
    for (const [vendor, name] of MODEL_VENDORS) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "model-vendor-tab";
      tab.dataset.vendor = vendor;
      tab.setAttribute("role", "tab");
      tab.textContent = name;
      tab.disabled = !models.some(model => modelVendor(model) === vendor && (!locked || modelRoute(model) === locked || model === current));
      tab.addEventListener("click", () => {
        if (tab.disabled || control.disabled) return;
        active = vendor;
        show();
        control.focus();
        try { control.showPicker?.(); } catch { /* Not every host allows opening a select programmatically. */ }
      });
      tabs.append(tab);
    }
    for (const [vendor] of MODEL_VENDORS) {
      const own = models.filter(model => modelVendor(model) === vendor);
      const routes = [...new Set(own.map(modelRoute))];
      for (const route of routes) {
        for (const model of own.filter(item => modelRoute(item) === route)) {
          const option = document.createElement("option");
          option.value = model;
          option.dataset.vendor = vendor;
          option.textContent = modelOptionLabel(model);
          option.selected = model === current;
          if (locked && route !== locked && model !== current) {
            option.disabled = true;
            option.title = t("ui.model.route.new.chat");
          }
          control.append(option);
        }
      }
    }
    // Long names are truncated in the closed select; the title keeps the full name and route.
    const describe = () => { control.title = control.value ? modelOptionLabel(control.value) : ""; };
    control.addEventListener("change", () => { selectedModel = control.value; describe(); if (control.value) { active = modelVendor(control.value); show(); } });
    describe();
    entries = [...control.children];
    show();
    wrapper.append(tabs);
  }

  function agentSettingsApplyError(values) {
    const nextOwn = values?.[state.role === "main" ? "main" : state.role] || {};
    const nextModel = nextOwn.model || state.model || settingOptions.model.find(Boolean);
    const locked = hasStartedModelConversation() && (currentCapabilities().sessionProvider || modelRoute(state.model));
    if (locked && modelRoute(nextModel) !== locked) return t("ui.model.route.new.chat");
    if (currentCapabilities().model !== true && nextModel !== state.model) return t("ui.model.route.new.chat");
    return "";
  }

  function applyAgentSettingsToChat(values, scope, name) {
    const error = agentSettingsApplyError(values);
    const status = document.getElementById("agent-preset-status");
    if (error) { status.hidden = false; status.textContent = error; return false; }
    const nextOwn = values?.[state.role === "main" ? "main" : state.role] || {};
    state.model = nextOwn.model || state.model || settingOptions.model.find(Boolean);
    state.reasoning = nextOwn.reasoningEffort || state.reasoning || "medium";
    if (state.role === "main") state.agentModels = {
      ...state.agentModels,
      ...(values.work ? {work: {...values.work}} : {}),
      ...(values.workLight || values.work ? {workLight: {...(values.work || {}), ...(values.workLight || {})}} : {}),
      ...(values.verification ? {verification: {...values.verification}} : {})
    };
    state.agentSettingsScope = scope;
    state.agentSettingsSet = name;
    const scopeControl = document.getElementById("agent-default-scope");
    if (scopeControl) scopeControl.value = scope;
    status.textContent = "";
    status.hidden = true;
    persist();
    saveComposerSettings();
    updateModeControls();
    return true;
  }

  function renderAgentDefaults() {
    const container = document.getElementById("agent-default-fields");
    const scopeControl = document.getElementById("agent-default-scope");
    if (!container || !scopeControl) return;
    const settings = state.agentDefaults || {};
    if (!settings.projectAvailable && scopeControl.value === "project") scopeControl.value = "global";
    scopeControl.querySelector('option[value="project"]').disabled = !settings.projectAvailable;
    const scope = scopeControl.value;
    if (scope === "chat") return; // Chat overrides are the model menu's own rows.
    container.replaceChildren();
    container.classList.add("aligned-settings");
    renderAgentPresets();
    const columns = document.createElement("div");
    columns.className = "agent-settings-columns";
    columns.setAttribute("aria-hidden", "true");
    for (const key of ["ui.agent", "ui.model", "ui.reasoning"]) {
      const column = document.createElement("span"); column.textContent = t(key); columns.append(column);
    }
    container.append(columns);
    for (const role of ["main", "work", "workLight", "verification"]) {
      const row = document.createElement("div"); row.className = "agent-model-row";
      row.dataset.agentRole = role;
      const heading = document.createElement("strong"); heading.textContent = t("ui.role." + role); heading.className = "agent-model-name"; heading.prepend(createAgentRoleIcon(role)); row.append(heading);
      for (const field of ["model", "reasoningEffort"]) {
        const current = settings[scope]?.[role]?.[field] || "";
        row.append(createAgentSettingControl(role, t("ui.role." + role), field, current, value => {
          const nextSettings = {...(settings[scope] || {}), [role]: {...(settings[scope]?.[role] || {}), [field]: value}};
          const error = agentSettingsApplyError(nextSettings);
          if (error) {
            const status = document.getElementById("agent-preset-status"); status.hidden = false; status.textContent = error;
            renderAgentDefaults();
            return;
          }
          state.agentDefaults[scope] = nextSettings;
          vscode.postMessage({ type: "agent.defaults.save", scope, role, field, value });
          autoSavePresetField(role, field, value);
          applyAgentSettingsToChat(nextSettings, scope, document.getElementById("agent-preset-select").value || "Default");
        }, false));
      }
      container.append(row);
    }
    if (agentPresetBusy) for (const control of container.querySelectorAll("input, select, button")) control.disabled = true;
  }

  function autoSavePresetField(role, field, value) {
    const name = document.getElementById("agent-preset-select").value;
    if (!name) return;
    vscode.postMessage({type: "agent.preset.field", scope: document.getElementById("agent-default-scope").value, name, role, field, value});
  }
  let agentPresetBusy = false;
  let pendingPresetName = "";
  function renderAgentPresets() {
    const select = document.getElementById("agent-preset-select");
    const scope = document.getElementById("agent-default-scope").value;
    const presets = (state.agentDefaults?.presets || []).filter(preset => preset.scope === scope);
    const desired = pendingPresetName || (state.agentSettingsScope === scope ? state.agentSettingsSet : "") || select.value;
    const selected = presets.some(preset => preset.name === desired) ? desired : presets.find(preset => preset.isDefault)?.name || "";
    select.replaceChildren();
    const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = t("preset.choose"); select.append(placeholder);
    for (const preset of presets) {
      const option = document.createElement("option"); option.value = preset.name; option.textContent = preset.isDefault ? t("preset.default") : preset.name; select.append(option);
    }
    select.value = Array.from(select.options).some(option => option.value === selected) ? selected : "";
    if (select.value === pendingPresetName) pendingPresetName = "";
    select.disabled = agentPresetBusy;
    document.getElementById("agent-preset-delete").disabled = agentPresetBusy || !select.value || presets.find(preset => preset.name === select.value)?.isDefault === true;
    document.getElementById("agent-preset-save").disabled = agentPresetBusy || !document.getElementById("agent-preset-name").value.trim();
    document.getElementById("agent-preset-name").disabled = agentPresetBusy;
    document.getElementById("agent-default-scope").disabled = agentPresetBusy;
  }
  function performPresetAction(action) {
    if (agentPresetBusy) return;
    const name = document.getElementById(action === "save" ? "agent-preset-name" : "agent-preset-select").value.trim();
    if (!name) return;
    const scope = document.getElementById("agent-default-scope").value;
    if (action === "apply") {
      const preset = state.agentDefaults?.presets?.find(item => item.scope === scope && item.name === name);
      if (!preset) return;
      const error = agentSettingsApplyError(preset.settings || {});
      if (error) {
        const status = document.getElementById("agent-preset-status"); status.hidden = false; status.textContent = error;
        return;
      }
    }
    if (action === "save" || action === "update" || action === "apply") pendingPresetName = name;
    agentPresetBusy = true;
    const status = document.getElementById("agent-preset-status"); status.hidden = false; status.textContent = t("preset.busy");
    renderAgentDefaults();
    renderAgentPresets();
    if (scope === "chat" && action !== "delete") saveComposerSettings();
    vscode.postMessage({type: "agent.preset", action, scope: document.getElementById("agent-default-scope").value, name});
  }
  for (const action of ["save", "delete"]) document.getElementById("agent-preset-" + action).addEventListener("click", () => performPresetAction(action));
  document.getElementById("agent-preset-name").addEventListener("input", renderAgentPresets);
  document.getElementById("agent-preset-select").addEventListener("change", () => performPresetAction("apply"));

  document.getElementById("agent-default-scope")?.addEventListener("change", event => {
    if (openSettingId !== "model") { renderAgentDefaults(); return; }
    document.getElementById("agent-preset-select").value = "";
    renderModelSettings(modelMenu, true);
    event.currentTarget.focus(); // Re-rendering moves the select; keep keyboard focus on it.
    performPresetAction("apply");
  });

  function createAgentRoleIcon(role) {
    const paths = {
      main: "M4 5h16v11H9l-5 4V5Zm4 4h8m-8 3h5",
      work: "M9 7V4h6v3M3 7h18v13H3V7Zm0 5h18m-11 0v3h4v-3",
      workLight: "M9 7V4h6v3M3 7h18v13H3V7Zm5 7h8",
      verification: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6"
    };
    return createModeIcon(paths[role] || paths.main, "agent-role-icon");
  }

  function renderModelSettings(menu, preserveScope = false) {
    // Scope and default controls are persistent nodes; park them so they stay in the document.
    document.getElementById("agent-scope-parts").append(document.getElementById("agent-scope-row"), document.getElementById("agent-defaults-content"));
    document.getElementById("agent-defaults-content").append(document.getElementById("agent-preset-content"));
    document.getElementById("agent-scope-parts").append(document.getElementById("agent-preset-picker"), document.getElementById("agent-preset-create"), document.getElementById("agent-preset-delete"));
    menu.replaceChildren();
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", t("ui.models.and.reasoning"));
    const header = document.createElement("div");
    header.className = "agent-settings-heading";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "agent-settings-close";
    close.setAttribute("aria-label", t("ui.close.agent.settings"));
    close.append(createModeIcon("m6 6 12 12M18 6 6 18", "agent-settings-close-icon"));
    close.addEventListener("click", function () { closeSettingMenu(true); });
    // One panel edits every scope: this chat's overrides, or the project/global defaults beneath them.
    // Keep the preset, scope and close controls together in one compact heading.
    const scopeControl = document.getElementById("agent-default-scope");
    if (!preserveScope && state.agentSettingsScope && (state.agentSettingsScope !== "project" || state.agentDefaults?.projectAvailable)) scopeControl.value = state.agentSettingsScope;
    header.append(document.getElementById("agent-scope-row"), document.getElementById("agent-preset-picker"), document.getElementById("agent-preset-create"), document.getElementById("agent-preset-delete"), close);
    menu.classList.add("aligned-settings");
    menu.append(header);
    renderAgentPresets();
    if (scopeControl.value !== "chat") {
      menu.append(document.getElementById("agent-defaults-content"));
      renderAgentDefaults();
      return;
    }
    const columns = document.createElement("div");
    columns.className = "agent-settings-columns";
    columns.setAttribute("aria-hidden", "true");
    for (const text of [t("ui.agent"), t("ui.model"), t("ui.reasoning")]) {
      const column = document.createElement("span");
      column.textContent = text;
      columns.append(column);
    }
    menu.append(columns);
    const roles = state.role === "main" ? [["main", t("ui.role.main")], ["work", t("ui.role.work")], ["workLight", t("ui.role.workLight")], ["verification", t("ui.role.verification")]] : [["main", state.role === "work" ? t("ui.work") : t("ui.verification")]];
    let initialized = false;
    for (const [role, label] of roles) {
      const row = document.createElement("div");
      row.className = "agent-model-row";
      row.dataset.agentRole = role;
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", label);
      const legend = document.createElement("strong");
      legend.className = "agent-model-name";
      legend.textContent = label;
      legend.prepend(createAgentRoleIcon(state.role === "main" ? role : state.role));
      row.append(legend);
      for (const field of ["model", "reasoningEffort"]) {
        const own = role === "main" ? (field === "model" ? state.model : state.reasoning) : state.agentModels?.[role]?.[field];
        // The light Work profile starts from the Work profile, never from Main's model.
        const current = own || effectiveAgentValue(role, field) || (role === "workLight" ? effectiveAgentValue("work", field) : "") || (field === "model" ? state.model || settingOptions.model.find(Boolean) || "" : state.reasoning || "medium");
        if (!own && current) {
          if (role === "main") state[field === "model" ? "model" : "reasoning"] = current;
          else state.agentModels = { ...state.agentModels, [role]: { ...state.agentModels?.[role], [field]: current } };
          initialized = true;
        }
        row.append(createAgentSettingControl(role, label, field, current, value => {
          state.agentSettingsScope = "chat";
          state.agentSettingsSet = document.getElementById("agent-preset-select").value || "Default";
          if (role === "main") state[field === "reasoningEffort" ? "reasoning" : "model"] = value;
          else state.agentModels = { ...state.agentModels, [role]: { ...state.agentModels?.[role], [field]: value || undefined } };
          updateModeControls();
          persist();
          saveComposerSettings();
          autoSavePresetField(agentSettingRole(role), field, value);
        }));
      }
      menu.append(row);
    }
    menu.append(document.getElementById("agent-preset-content"));
    if (initialized) { persist(); saveComposerSettings(); }
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
    renderProviderSettings();
  }

  const providerNames = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity" };
  let providerSnapshot = { providers: [], busy: false, errors: {}, pluginUpdateMode: "auto", versions: {} };
  const providerDrafts = new Map();
  let providerNoticeShown = false;
  let providerVersionsRequested = false;
  let providerCatalog = null;
  let missingProviderExpanded = false;
  let factoryInstallVersion = "";
  const providerInstallVersions = new Map();

  function receiveProviders(message) {
    const providers = Array.isArray(message.providers)
      ? message.providers.filter(item => item && Object.hasOwn(providerNames, item.id)) : [];
    providerSnapshot = {
      providers,
      busy: message.busy === true,
      errors: message.errors && typeof message.errors === "object" ? message.errors : {},
      pluginUpdateMode: message.pluginUpdateMode === "manual" ? "manual" : "auto",
      versions: message.versions && typeof message.versions === "object" ? message.versions : {}
    };
    if (!providerSnapshot.busy) providerDrafts.clear();
    // Without any CLI the chat stays open; point once to the place where a path can be set.
    if (!providerSnapshot.busy && providers.length && !providers.some(item => item.detected) && !providerNoticeShown) {
      providerNoticeShown = true;
      appendNotice("warning", t("ui.providers.none.chat"));
    }
    if (providers.some(item => item.detected)) providerNoticeShown = false;
    renderProviderSettings();
  }

  function populateVersionSelect(select, versions, selected, unavailable) {
    const values = Array.isArray(versions) ? versions : [];
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t(providerCatalog === null ? "ui.providers.version.loading"
      : unavailable ? "ui.providers.version.unavailable"
        : values.length ? "ui.providers.version.select" : "ui.providers.version.none");
    select.append(placeholder);
    for (const version of values) {
      const option = document.createElement("option");
      option.value = version;
      option.textContent = version;
      select.append(option);
    }
    select.value = values.includes(selected) ? selected : "";
    select.disabled = providerSnapshot.busy || !values.length;
  }

  function renderProviderSettings() {
    const root = document.getElementById("provider-settings");
    if (!root) return;
    const focused = root.contains(document.activeElement) ? document.activeElement.dataset.providerControl : undefined;
    const section = document.createElement("section");
    section.className = "provider-settings";
    const hasDetected = providerSnapshot.providers.some(provider => provider.detected);
    const update = document.createElement("button");
    update.type = "button";
    update.dataset.providerControl = "update-now";
    update.textContent = t(providerSnapshot.busy ? "ui.providers.update.updating" : "ui.providers.update.now");
    update.disabled = providerSnapshot.busy || !hasDetected;
    update.addEventListener("click", function () { vscode.postMessage({ type: "providers.update" }); });
    const factoryControls = document.createElement("div");
    factoryControls.className = "provider-version-controls provider-factory-version-controls";
    const factoryInput = document.createElement("select");
    factoryInput.setAttribute("aria-label", t("ui.providers.factory.version.label"));
    factoryInput.dataset.providerControl = "factory-install-version-select";
    populateVersionSelect(factoryInput, providerCatalog?.factory, factoryInstallVersion, providerCatalog?.errors?.factory);
    const factoryInstall = document.createElement("button");
    factoryInstall.type = "button";
    factoryInstall.dataset.providerControl = "factory-install-version";
    factoryInstall.textContent = t("ui.providers.install");
    const updateFactoryButton = () => { factoryInstall.disabled = providerSnapshot.busy || !hasDetected || !factoryInput.value; };
    const submitFactoryVersion = () => {
      if (factoryInstall.disabled) return;
      vscode.postMessage({ type: "providers.update", version: factoryInput.value });
    };
    factoryInput.addEventListener("change", function () { factoryInstallVersion = factoryInput.value; updateFactoryButton(); });
    factoryInstall.addEventListener("click", submitFactoryVersion);
    updateFactoryButton();
    factoryControls.append(factoryInput, factoryInstall, update);
    section.append(factoryControls);
    const missing = providerSnapshot.providers.filter(provider => !provider.detected);
    let missingList;
    let missingDetails;
    if (missing.length) {
      missingDetails = document.createElement("details");
      missingDetails.className = "provider-missing";
      missingDetails.open = !hasDetected || missingProviderExpanded;
      missingDetails.addEventListener("toggle", function () {
        if (hasDetected) missingProviderExpanded = missingDetails.open;
      });
      const summary = document.createElement("summary");
      summary.textContent = t("ui.providers.add.path");
      missingList = document.createElement("div");
      missingList.className = "provider-missing-list";
      missingDetails.append(summary, missingList);
    }
    for (const provider of providerSnapshot.providers) {
      const row = document.createElement("div");
      row.className = "provider-row";
      const head = document.createElement("div");
      head.className = "provider-row-head";
      const name = document.createElement("span");
      name.className = "provider-name";
      name.textContent = providerNames[provider.id];
      const status = document.createElement("span");
      status.className = "provider-state";
      status.dataset.detected = String(provider.detected === true);
      status.textContent = provider.detected
        ? t("ui.providers.detected") + " · " + t(provider.source === "configured" ? "ui.providers.source.configured" : "ui.providers.source.auto")
        : "";
      head.append(name);
      if (provider.detected) head.append(status);
      row.append(head);
      const versions = providerSnapshot.versions[provider.id];
      if (provider.detected && versions && (versions.cli || versions.plugin)) {
        const versionLine = document.createElement("span");
        versionLine.className = "provider-version";
        versionLine.textContent = [
          versions.cli ? t("ui.providers.version.cli", versions.cli) : undefined,
          versions.plugin ? t("ui.providers.version.plugin", versions.plugin) : undefined
        ].filter(Boolean).join(" · ");
        row.append(versionLine);
      }
      if (provider.detected && versions && typeof versions.pluginCurrent === "boolean") {
        const updateState = document.createElement("span");
        updateState.className = "provider-update-state";
        updateState.dataset.current = String(versions.pluginCurrent);
        updateState.textContent = t(versions.pluginCurrent ? "ui.providers.update.current" : "ui.providers.update.available");
        row.append(updateState);
      }
      if (provider.detected && provider.id !== "antigravity") {
        const versionControls = document.createElement("div");
        versionControls.className = "provider-version-controls";
        const versionInput = document.createElement("select");
        versionInput.setAttribute("aria-label", t("ui.providers.cli.version.label", providerNames[provider.id]));
        versionInput.dataset.providerControl = provider.id + ":install-version-select";
        populateVersionSelect(versionInput, providerCatalog?.cli?.[provider.id], providerInstallVersions.get(provider.id) ?? "", providerCatalog?.errors?.[provider.id]);
        const installVersion = document.createElement("button");
        installVersion.type = "button";
        installVersion.dataset.providerControl = provider.id + ":install-version";
        installVersion.textContent = t("ui.providers.install");
        const updateVersionButton = () => { installVersion.disabled = providerSnapshot.busy || !versionInput.value; };
        const submitVersion = () => {
          const version = versionInput.value;
          if (installVersion.disabled) return;
          vscode.postMessage({ type: "providers.cli.install", provider: provider.id, version });
        };
        versionInput.addEventListener("change", function () {
          providerInstallVersions.set(provider.id, versionInput.value);
          updateVersionButton();
        });
        installVersion.addEventListener("click", submitVersion);
        updateVersionButton();
        versionControls.append(versionInput, installVersion);
        row.append(versionControls);
      } else if (provider.detected) {
        const unsupported = document.createElement("span");
        unsupported.className = "provider-version";
        unsupported.textContent = t("ui.providers.cli.version.unsupported");
        row.append(unsupported);
      }
      const problems = [];
      if (!provider.detected && provider.configuredInvalid && typeof provider.configuredPath === "string") problems.push(t("ui.providers.configured.invalid"));
      if (typeof providerSnapshot.errors[provider.id] === "string") problems.push(t("ui.providers.plugin.failed", providerSnapshot.errors[provider.id]));
      for (const text of problems) {
        const problem = document.createElement("p");
        problem.className = "provider-error";
        problem.textContent = text;
        row.append(problem);
      }
      const edit = document.createElement("div");
      edit.className = "provider-path-edit";
      const input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      input.dataset.providerControl = provider.id + ":input";
      // A failed manual override can fall back to a working auto-detected executable.
      // Show the executable actually used for this provider, not the stale override.
      const displayedPath = provider.detected && typeof provider.path === "string"
        ? provider.path : provider.configuredPath ?? "";
      input.value = providerDrafts.get(provider.id) ?? displayedPath;
      input.placeholder = t("ui.providers.path.placeholder");
      input.setAttribute("aria-label", t("ui.providers.path", providerNames[provider.id]));
      input.disabled = providerSnapshot.busy;
      let lastSubmittedPath = displayedPath;
      const submit = () => {
        const path = input.value.trim();
        if (providerSnapshot.busy || !path || path === lastSubmittedPath) return;
        lastSubmittedPath = path;
        vscode.postMessage({ type: "providers.configure", provider: provider.id, path });
      };
      input.addEventListener("input", function () { providerDrafts.set(provider.id, input.value); });
      input.addEventListener("blur", function (event) {
        if (!edit.contains(event.relatedTarget)) submit();
      });
      input.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        submit();
      });
      const pick = document.createElement("button");
      pick.type = "button";
      pick.dataset.providerControl = provider.id + ":pick";
      pick.textContent = t("ui.providers.pick");
      pick.disabled = providerSnapshot.busy;
      pick.addEventListener("click", function () { vscode.postMessage({ type: "providers.pick", provider: provider.id }); });
      const clear = document.createElement("button");
      clear.type = "button";
      clear.dataset.providerControl = provider.id + ":clear";
      clear.textContent = t("ui.providers.clear");
      clear.disabled = providerSnapshot.busy;
      clear.setAttribute("aria-pressed", String(provider.detected ? provider.source !== "configured" : !provider.configuredPath));
      clear.addEventListener("click", function () {
        providerDrafts.delete(provider.id);
        vscode.postMessage({ type: "providers.configure", provider: provider.id, path: "" });
      });
      edit.append(input, pick, clear);
      row.append(edit);
      if (provider.detected) section.append(row);
      else missingList?.append(row);
    }
    if (missingDetails) section.append(missingDetails);
    root.replaceChildren(section);
    if (focused) {
      const target = root.querySelector('[data-provider-control="' + focused + '"]');
      if (target && !target.disabled) target.focus();
      else if (providerSnapshot.busy) root.querySelector('[data-provider-control$=":input"]')?.focus();
    }
  }

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
    if (setting === "model") renderModelSettings(menu);
    else if (setting === "worktree") { renderWorktree(); vscode.postMessage({ type: "worktree.repositories" }); }
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
      contractList.open = false;
      document.getElementById("task-history").open = false;
      document.getElementById("conversation-history").open = false;
    }
    button.setAttribute("aria-expanded", "false");
    openSettingId = undefined;
    if (restoreFocus) {
      button.focus();
    }
  }

  function settingButton(setting) { return setting === "model" ? modelButton : setting === "worktree" ? worktreeButton : submissionButton; }
  function settingMenu(setting) { return setting === "model" ? modelMenu : setting === "worktree" ? worktreeMenu : submissionMenu; }

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
      notesScope: selectedNotesScope,
      noteDraft: noteDraft && (noteDirty || noteSending) ? { ...noteDraft } : null,
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
      taskFlows: currentTaskFlows().slice(-100),
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
