globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.shortcuts = function (host) {
  "use strict";

  const {
    t, botDisplayName, businessModeNames, saved, sendButton, factoryBot, persist,
    submissionOptionDisabled, closeSettingMenu, submit, openSetting
  } = host;

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
    { id: "openContracts", group: "history", fallback: "Alt+Shift+K", history: "task-history", historyTab: "contracts", label: () => t("contracts.title") },
    { id: "openTaskHistory", group: "history", fallback: "Alt+Shift+T", history: "task-history", historyTab: "tasks", label: () => t("flow.history") },
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
      row.hidden = !!action.bot && !host.state.botsAvailable;
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
      section.hidden = !!group.bot && !host.state.botsAvailable;
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
    for (const [button, action] of [[sendButton, "send"], [host.botTalkButton, "bot"]]) {
      if (shortcuts[action]) button.setAttribute("aria-keyshortcuts", shortcutAria(shortcuts[action]));
      else button.removeAttribute("aria-keyshortcuts");
    }
    for (const action of shortcutActions.filter(action => action.button)) {
      const button = host.botMenu.querySelector(action.button);
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
      if (host.openSettingId !== "submission") openSetting("submission");
      host.chatHistory?.selectHistoryTab(action.historyTab);
      details.open = true;
      details.querySelector("summary").focus({ preventScroll: true });
      return;
    }
    if (action.questionTab) {
      if (host.state.role !== "main") return;
      host.chatNavigation.openQuestionMenu(action.questionTab);
      return;
    }
    if (action.id === "botMenu") { factoryBot.click(); return; }
    const button = host.botMenu.querySelector(action.button);
    if (!button || button.disabled || button.hidden) return;
    // Menu actions restore focus to the bot; a shortcut keeps the Human's place.
    const focused = document.activeElement;
    button.click();
    if (focused && focused !== document.body && document.contains(focused)) focused.focus({ preventScroll: true });
  }
  function runGlobalShortcut(event, action) {
    if (document.querySelector("dialog[open]")) return false;
    if (action.bot && (!host.state.botsEnabled || factoryBot.hidden)) return false;
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

  return {
    matchesShortcut, shortcuts,
    get shortcutRecording() { return shortcutRecording; },
    set shortcutRecording(value) { shortcutRecording = value; },
    shortcutFromEvent, shortcutComposing, cancelShortcut, shortcutActions, shortcutProblem,
    shortcutStatus, shortcutLabel, renderShortcuts, focusShortcutControl, emulateEscape, moveFocus,
    runGlobalShortcut, shortcutAria, shortcutDefaultsVersion
  };
};
