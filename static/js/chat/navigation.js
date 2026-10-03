globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.navigation = function (host) {
  "use strict";

  const {
    closeSettingMenu, sessionMenu, state, vscode, prompt, questionMenu, questionButton,
    promptSurface, questionTabs, historyEmpty, matchesShortcut, shortcuts, indexedTimeline, uiLocale,
    eventVersion, t, questionList, createModeIcon, renderTimeline, updateAutoScrollControl,
    sessionList
  } = host;

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
      host.chatHistory.conversationList.replaceChildren(historyEmpty("ui.conversation.loading"));
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
    if (host.questionSourceId !== index.id) {
      host.questionSourceId = index.id;
      host.questionPageStart = 0;
      host.questionListKey = undefined;
      host.questionElements.clear();
    }
    const pageSize = 100;
    host.questionPageStart = Math.min(host.questionPageStart, Math.max(0, Math.floor((questions.length - 1) / pageSize) * pageSize));
    const visible = questions.slice(host.questionPageStart, host.questionPageStart + pageSize);
    const key = [index.id, host.questionPageStart, questions.length, uiLocale(), ...visible.map(eventVersion)].join(":");
    if (host.questionListKey === key) return;
    host.questionListKey = key;
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
        host.questionPageStart += offset;
        renderQuestionList();
        questionList.querySelector("[data-question-id]")?.focus();
      });
      button.addEventListener("keydown", handleQuestionListKeydown);
      fragment.append(button);
    }
    if (questions.length > pageSize) pageButton("previous", "ui.history.previous", host.questionPageStart > 0, -pageSize);
    visible.forEach(function (question) {
      retained.add(question.id);
      let item = host.questionElements.get(question.id);
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
        host.questionElements.set(question.id, item);
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
    if (questions.length > pageSize) pageButton("next", "ui.history.next", host.questionPageStart + pageSize < questions.length, pageSize);
    if (!questions.length) fragment.append(sessionEmpty(t("ui.no.user.questions.yet")));
    questionList.replaceChildren(fragment);
    for (const id of host.questionElements.keys()) if (!retained.has(id)) host.questionElements.delete(id);
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
    cancelAnimationFrame(host.autoScrollFrame);
    host.followLatest = false;
    if (!host.messageElements.has(id)) {
      const end = Math.min(state.timeline.length, (Math.floor(position / 200) + 1) * 200);
      host.timelineEndId = end === state.timeline.length ? undefined : state.timeline[end - 1].id;
      renderTimeline();
    }
    const target = host.messageElements.get(id);
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

  return {
    selectQuestionTab, openQuestionMenu, closeQuestionMenu, closeSessionMenu, openSessionMenu,
    renderSessionList, updateQuestionControl, renderQuestionList
  };
};
