(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const markdown = typeof globalThis.markdownit === "function"
    ? globalThis.markdownit({ html: false, linkify: true, typographer: false })
    : undefined;
  const timeline = document.getElementById("timeline");
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
  const fastModeButton = document.getElementById("fast-mode-button");
  const goalModeButton = document.getElementById("goal-mode-button");
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
    model: ["", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
    reasoning: ["", "none", "low", "medium", "high", "xhigh", "max"]
  };
  const composerStatusItems = new Set(["model", "reasoning", "fast", "goal"]);
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
    runtimeAvailable: saved?.runtimeAvailable === true,
    running: saved?.running === true,
    model: normalizeSettingValue(saved?.model, settingOptions.model),
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
  let elapsedTimerId;
  let followLatest = true;

  prompt.value = state.draft;
  renderAll();
  resizePrompt();
  vscode.postMessage({ type: "client.ready" });

  let syntaxThemeClass = currentSyntaxThemeClass();
  new MutationObserver(function () {
    const nextThemeClass = currentSyntaxThemeClass();
    if (nextThemeClass === syntaxThemeClass) return;
    syntaxThemeClass = nextThemeClass;
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
  fastModeButton.addEventListener("click", function () {
    toggleMode("fastMode");
  });
  goalModeButton.addEventListener("click", function () {
    toggleMode("goalMode");
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
        state.role = ["main", "work", "verification"].includes(message.role) ? message.role : "main";
        state.verifiedWorkRunId = typeof message.verifiedWorkRunId === "string" ? message.verifiedWorkRunId : undefined;
        document.body.dataset.agentRole = state.role;
        state.projectName = message.projectName;
        state.runtimeAvailable = message.runtimeAvailable === true;
        state.running = message.running === true;
        state.model = normalizeSettingValue(message.model, settingOptions.model);
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
        renderTimeline();
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
            state.timeline = [];
            followLatest = true;
            renderTimeline();
          }
          updateSessionControl();
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
        renderStatusBar();
        persist();
        break;
      case "chat.assistant":
        if (typeof message.text === "string" && message.text) {
          state.timeline.push({ type: "assistant", id: createId(), text: message.text });
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
          (message.diff === undefined || (typeof message.diff === "string" && message.diff.length <= 262144)) &&
          ["command", "file", "tool"].includes(message.category) &&
          ["started", "completed", "failed"].includes(message.phase)
        ) {
          upsertActivity(message.id, message.category, message.phase, message.text, message.diff, message.title);
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
    if (!text || state.running) {
      return;
    }
    const message = {
      id: createId(),
      text,
      attachments: state.attachments.slice(),
      execution: {
        model: state.model || undefined,
        reasoningEffort: state.reasoning || undefined,
        fast: state.fastMode,
        goal: state.goalMode
      }
    };
    state.timeline.push({ type: "user", id: message.id, text: message.text });
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

  function upsertActivity(id, category, phase, text, diff, title) {
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
    } else {
      state.timeline.push({ type: "activity", id, category, phase, text, diff, title });
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
    renderRunStatus();
    updateSendButton();
    updateRunControls();
    updateModeControls();
    updateSessionControl();
    updateQuestionControl();
  }

  function renderTimeline() {
    const shouldFollowLatest = followLatest;
    timeline.querySelectorAll(".message").forEach(function (element) {
      element.remove();
    });
    emptyState.hidden = state.timeline.length > 0;
    for (const event of state.timeline) {
      const message = document.createElement("article");
      message.className = "message message-" + event.type;
      message.dataset.id = event.id;
      if (event.type === "user") {
        message.tabIndex = -1;
      }
      if (event.type === "activity") {
        message.classList.add("message-activity-" + (event.category || "tool"));
        message.dataset.category = event.category || "tool";
        message.dataset.phase = event.phase || "started";
      }
      if (event.type === "activity" && event.category !== "command") {
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
        renderAssistantMarkdown(content, event.text);
      } else if (event.type === "activity" && event.category === "command") {
        renderTerminalCommand(content, event.text, event.phase, event.title);
      } else if (event.type === "activity" && event.category === "file" && event.diff) {
        renderGitDiff(content, event.diff, event.text);
      } else {
        content.textContent = event.text;
      }
      message.append(content);
      timeline.append(message);
    }
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

  function createActivityPhase(phaseValue) {
    const phase = document.createElement("span");
    phase.className = "message-phase message-phase-" + (phaseValue || "started");
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
    prompt.textContent = ">";
    prompt.setAttribute("aria-hidden", "true");
    const text = document.createElement("div");
    text.className = "bash-command-text";
    if (title) {
      const context = document.createElement("span");
      context.className = "terminal-command-context";
      context.textContent = readActivityDisplayTitle(title, phaseValue);
      context.title = command;
      text.append(context);
      row.append(createActivityPhase(phaseValue), prompt, text);
      container.append(row);
      return;
    }
    const commandCode = document.createElement("span");
    commandCode.className = "syntax-code";
    commandCode.textContent = command;
    text.append(commandCode);
    row.append(createActivityPhase(phaseValue), prompt, text);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "bash-command-toggle";
    toggle.textContent = "…";
    toggle.setAttribute("aria-label", "전체 명령 펼치기");
    toggle.setAttribute("aria-expanded", "false");
    toggle.hidden = true;
    toggle.addEventListener("click", function () {
      const expanded = text.classList.toggle("is-expanded");
      toggle.classList.toggle("is-expanded", expanded);
      toggle.textContent = expanded ? "접기" : "…";
      toggle.setAttribute("aria-label", expanded ? "명령 접기" : "전체 명령 펼치기");
      toggle.setAttribute("aria-expanded", String(expanded));
    });
    container.append(row, toggle);
    requestAnimationFrame(function () {
      toggle.hidden = text.scrollHeight <= text.clientHeight + 1;
    });
    void applySyntaxHighlighting(commandCode, command, "bash").then(function () {
      requestAnimationFrame(function () {
        toggle.hidden = text.scrollHeight <= text.clientHeight + 1;
      });
    });
  }

  function readActivityDisplayTitle(title, phase) {
    if (phase !== "started") return title;
    if (title.startsWith("Skill 읽기 · ")) return title.replace("Skill 읽기 · ", "Skill 읽는 중 · ");
    if (title === "실행 결과 읽기") return "실행 결과 읽는 중";
    return title;
  }

  function renderGitDiff(container, diff, fallbackText) {
    container.classList.add("git-diff-content");
    const files = parseGitDiff(diff);
    const additions = files.reduce(function (sum, file) { return sum + file.additions; }, 0);
    const deletions = files.reduce(function (sum, file) { return sum + file.deletions; }, 0);
    const overview = document.createElement("div");
    overview.className = "git-diff-overview";
    overview.append(document.createTextNode("Edited " + (files.length || 1) + " file" + (files.length === 1 ? "" : "s") + " "));
    const stats = document.createElement("span");
    stats.className = "git-diff-stats";
    stats.textContent = "(+" + additions + " −" + deletions + ")";
    overview.append(stats);
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
        count.textContent = "+" + file.additions + " −" + file.deletions;
        row.append(path, count);
        list.append(row);
      });
    }
    container.append(list);

    const details = document.createElement("details");
    details.className = "git-diff-preview";
    details.open = diff.split("\n").length <= 160;
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

  async function applyDiffSyntaxHighlighting(code, diff) {
    const highlighter = globalThis.agentFactorySyntaxHighlighter;
    if (!highlighter) return;
    const elements = Array.from(code.children);
    const lines = diff.split("\n");
    const sections = [];
    let section;
    lines.forEach(function (line, index) {
      if (line.startsWith("diff --git ")) {
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        section = { path: match ? match[2] : "", entries: [] };
        sections.push(section);
        return;
      }
      if (!section || /^(?:index |--- |\+\+\+ |@@|\\ No newline)/.test(line)) return;
      if (!/^[ +\-]/.test(line)) return;
      section.entries.push({ index, prefix: line.slice(0, 1), text: line.slice(1) });
    });
    await Promise.all(sections.map(async function (item) {
      const language = highlighter.languageForPath(item.path);
      if (!language || item.entries.length === 0) return;
      try {
        const highlighted = await highlighter.highlight(
          item.entries.map(function (entry) { return entry.text; }).join("\n"),
          language,
          currentSyntaxThemeClass() !== "light"
        );
        item.entries.forEach(function (entry, index) {
          const element = elements[entry.index];
          const tokens = highlighted[index];
          if (element && tokens) renderHighlightedTokens(element, tokens, entry.prefix);
        });
      } catch {
        // Plain diff text remains available if a grammar cannot tokenize the input.
      }
    }));
  }

  async function applySyntaxHighlighting(element, code, language) {
    const highlighter = globalThis.agentFactorySyntaxHighlighter;
    if (!highlighter) return;
    try {
      const highlighted = await highlighter.highlight(
        code,
        language,
        currentSyntaxThemeClass() !== "light"
      );
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

  function renderAssistantMarkdown(container, text) {
    if (!markdown) {
      container.textContent = text;
      return;
    }
    container.classList.add("markdown-body");
    container.innerHTML = markdown.render(text);
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
      agents: "진행 " + state.workUnits.activeUnits + " · 작업 " + state.workUnits.workActive + " · 검증 " + state.workUnits.verificationActive,
      project: state.projectName || "Project —",
      branch: "Branch —",
      context: contextStatusLabel(),
      elapsed: "00:00",
      queue: "Queue 0",
      runtime: state.runtimeAvailable ? "Runtime 연결됨" : "Runtime 미연결"
    };
    return labels[itemId] || itemId;
  }

  function updateSendButton() {
    sendButton.disabled = !state.running && prompt.value.trim().length === 0;
  }

  function updateRunControls() {
    sendButton.classList.toggle("is-running", state.running);
    sendButton.setAttribute("aria-label", state.running ? "현재 실행 중지" : "메시지 전송");
    sendButton.title = state.running ? "현재 실행 중지 (Esc)" : "전송 (Enter)";
    sendIcon.hidden = state.running;
    stopIcon.hidden = !state.running;
    updateSessionControl();
    renderRunStatus();
    updateSendButton();
  }

  function toggleMode(key) {
    state[key] = !state[key];
    updateModeControls();
    renderStatusBar();
    persist();
    saveComposerSettings();
  }

  function updateModeControls() {
    fastModeButton.setAttribute("aria-pressed", String(state.fastMode));
    fastModeButton.setAttribute("aria-label", state.fastMode ? "Fast mode on" : "Fast mode off");
    fastModeButton.title = state.fastMode ? "Fast mode on" : "Fast mode off";
    goalModeButton.setAttribute("aria-pressed", String(state.goalMode));
    goalModeButton.setAttribute("aria-label", state.goalMode ? "Goal mode on" : "Goal mode off");
    goalModeButton.title = state.goalMode ? "Goal mode on" : "Goal mode off";
    modelLabel.textContent = state.model || "Default";
    reasoningLabel.textContent = state.reasoning || "Default";
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
    const button = setting === "model" ? modelButton : reasoningButton;
    const menu = setting === "model" ? modelMenu : reasoningMenu;
    renderSettingMenu(setting, menu);
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const selected = menu.querySelector('[aria-checked="true"]');
    (selected || menu.querySelector("button"))?.focus();
  }

  function renderSettingMenu(setting, menu) {
    const current = setting === "model" ? state.model : state.reasoning;
    menu.replaceChildren();
    for (const value of settingOptions[setting]) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "setting-option";
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", String(value === current));
      option.dataset.value = value;
      option.textContent = value || "Default";
      option.addEventListener("click", function () {
        if (setting === "model") {
          state.model = value;
        } else {
          state.reasoning = value;
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
    const button = openSettingId === "model" ? modelButton : reasoningButton;
    const menu = openSettingId === "model" ? modelMenu : reasoningMenu;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    openSettingId = undefined;
    if (restoreFocus) {
      button.focus();
    }
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
    const used = Math.min(compactAt, state.contextUsedTokens);
    const usageRatio = compactAt > 0 ? used / compactAt : 0;
    const label = document.createElement("span");
    label.className = "context-token-label";
    label.textContent = contextStatusLabel();
    const meter = document.createElement("span");
    meter.className = "context-token-meter";
    meter.setAttribute("role", "progressbar");
    meter.setAttribute("aria-label", "컨텍스트 토큰 사용량");
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", String(compactAt));
    meter.setAttribute("aria-valuenow", String(used));
    const fill = document.createElement("span");
    fill.className = "context-token-meter-fill";
    fill.style.width = usageRatio * 100 + "%";
    fill.style.backgroundColor = "hsl(" + Math.round((1 - usageRatio) * 120) + " 72% 45%)";
    meter.append(fill);
    item.replaceChildren(label, meter);
  }

  function normalizeSettingValue(value, allowedValues) {
    return typeof value === "string" && allowedValues.includes(value) ? value : "";
  }

  function createId() {
    return globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
})();
