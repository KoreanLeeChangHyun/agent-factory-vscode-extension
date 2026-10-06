globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.history = function (host) {
  "use strict";

  const {
    vscode, questionButton, t, closeQuestionMenu,
    renderAssistantMarkdown, assistantDisplayText, historyEmpty
  } = host;

  // Task history and contracts share one disclosure: two tabs over the same project records.
  const taskHistory = document.getElementById("task-history");
  const historyTabs = Array.from(document.querySelectorAll("#task-history-list [role=tab]"));
  let historyTab = "tasks";
  taskHistory.querySelector("summary").addEventListener("keydown", handleHistoryKeydown);
  taskHistory.addEventListener("toggle", function () {
    if (this.open) requestHistory(historyTab);
    positionTaskHistory();
  });
  for (const tab of historyTabs) {
    tab.addEventListener("click", () => selectHistoryTab(tab.dataset.historyTab));
    tab.addEventListener("keydown", event => {
      const index = historyTabs.indexOf(tab);
      const target = event.key === "ArrowRight" ? historyTabs[(index + 1) % historyTabs.length]
        : event.key === "ArrowLeft" ? historyTabs[(index + historyTabs.length - 1) % historyTabs.length]
        : event.key === "Home" ? historyTabs[0] : event.key === "End" ? historyTabs.at(-1) : null;
      if (!target) return;
      event.preventDefault();
      selectHistoryTab(target.dataset.historyTab, true);
    });
  }
  function selectHistoryTab(name, focus = false) {
    if (!historyTabs.some(tab => tab.dataset.historyTab === name)) return;
    const changed = historyTab !== name;
    historyTab = name;
    for (const tab of historyTabs) {
      const selected = tab.dataset.historyTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
      if (selected && focus) tab.focus();
    }
    if (changed && taskHistory.open) requestHistory(name);
  }
  function requestHistory(name) {
    if (name === "contracts") {
      document.getElementById("contract-list-list").replaceChildren(historyEmpty("contracts.loading"));
      vscode.postMessage({ type: "contracts.request" });
    }
    // Contracts show their linked task counts, so both tabs refresh the project's task briefs.
    vscode.postMessage({ type: "project.tasks.request" });
  }
  window.addEventListener("resize", positionTaskHistory);
  const layoutObserver = new ResizeObserver(positionTaskHistory);
  layoutObserver.observe(document.getElementById("run-status"));
  layoutObserver.observe(document.getElementById("agent-progress"));
  layoutObserver.observe(document.getElementById("pending-queue-toggle"));
  layoutObserver.observe(document.getElementById("workflow-history-items"));

  const actions = document.getElementById("workflow-history");
  const overflow = document.getElementById("workflow-history-toggle");
  overflow.addEventListener("click", () => {
    const open = actions.classList.toggle("is-open");
    overflow.setAttribute("aria-expanded", String(open));
    positionTaskHistory();
  });
  document.addEventListener("click", event => {
    if (!actions.contains(event.target)) closeHistoryMenu();
  });
  actions.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      taskHistory.open = false;
      closeHistoryMenu();
      (actions.classList.contains("is-compact") ? overflow : event.target.closest("details")?.querySelector("summary"))?.focus();
    }
  });
  function handleHistoryKeydown(event) {
    const options = Array.from(document.querySelectorAll("#workflow-history-items > details > summary"));
    const index = options.indexOf(event.currentTarget);
    const target = event.key === "Home" ? options[0] : event.key === "End" ? options.at(-1) : event.key === "ArrowDown" ? options[(index + 1) % options.length] : event.key === "ArrowUp" ? options[(index + options.length - 1) % options.length] : null;
    if (target) { event.preventDefault(); target.focus(); }
  }
  function closeHistoryMenu() {
    actions.classList.remove("is-open");
    overflow.setAttribute("aria-expanded", "false");
  }

  const conversationList = document.getElementById("conversation-history-list");
  const conversationReader = document.getElementById("conversation-reader");
  const conversationMessages = document.getElementById("conversation-reader-messages");
  const conversationOlder = document.getElementById("conversation-reader-older");
  let conversationReadId = 0;
  let selectedConversationId;
  let conversationBefore;
  let conversationAppending = false;
  conversationList.append(historyEmpty("ui.conversation.empty"));
  document.getElementById("conversation-reader-close").addEventListener("click", () => conversationReader.close());
  conversationReader.addEventListener("close", function () {
    conversationReadId++;
    questionButton.focus();
  });
  conversationOlder.addEventListener("click", function () { readSavedConversation(true); });


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
        closeQuestionMenu(false);
        conversationReader.showModal();
        readSavedConversation(false);
      });
      conversationList.append(button);
    }
    if (!conversationList.children.length) conversationList.append(historyEmpty("ui.conversation.empty"));
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
      if (item.type === "user" && item.submission?.backgroundContinuation === true && item.text === "") continue;
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
    const status = document.getElementById("run-status");
    const actions = document.getElementById("workflow-history");
    document.getElementById("workflow-history-toggle").setAttribute("aria-label", t("contracts.title") + " / " + t("flow.history"));
    const progress = document.getElementById("agent-progress");
    const queue = document.getElementById("pending-queue-toggle");
    const queueWidth = queue.hidden ? 0 : queue.getBoundingClientRect().width + parseFloat(getComputedStyle(queue).marginRight) + 8;
    status.style.setProperty("--queue-header-width", queueWidth + "px");
    const available = status.clientWidth - (progress.hidden ? 0 : progress.getBoundingClientRect().width + 8) - queueWidth;
    actions.classList.toggle("is-compact", available < 430);
    status.style.setProperty("--workflow-header-width", Math.max(36, available) + "px");
    positionHistory("task-history");
  }

  function positionHistory(id) {
    const history = document.getElementById(id);
    const summary = history.querySelector("summary");
    summary.setAttribute("aria-expanded", String(history.open));
    if (!history.open) return;
    const list = document.getElementById(id + "-list");
    // One frame for both tabs: switching tabs never moves or resizes the list.
    const actions = document.getElementById("workflow-history");
    const bounds = actions.getBoundingClientRect();
    // The compact menu opens below its toggle; keep the list clear of both.
    const menuBottom = actions.matches(".is-compact.is-open") ? document.getElementById("workflow-history-items").getBoundingClientRect().bottom : bounds.bottom;
    const width = Math.min(440, window.innerWidth - 16);
    const above = bounds.top - 12;
    const below = window.innerHeight - menuBottom - 12;
    const up = above >= 320 || above >= below;
    const height = Math.max(0, Math.min(320, up ? above : below));
    list.classList.add("is-flyout");
    list.style.left = Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)) + "px";
    list.style.width = width + "px";
    list.style.height = height + "px";
    list.style.removeProperty("max-height");
    list.style.top = up ? "auto" : menuBottom + 4 + "px";
    list.style.bottom = up ? window.innerHeight - bounds.top + 4 + "px" : "auto";
  }

  return {
    taskHistory, selectHistoryTab, positionTaskHistory, showConversationList, showSavedConversation,
    conversationList
  };
};
