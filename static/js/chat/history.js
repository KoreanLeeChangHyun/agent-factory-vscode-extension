globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.history = function (host) {
  "use strict";

  const {
    vscode, questionButton, t, closeQuestionMenu,
    renderAssistantMarkdown, assistantDisplayText, historyEmpty
  } = host;

  const contractList = document.getElementById("contract-list");
  contractList.querySelector("summary").addEventListener("keydown", handleHistoryKeydown);
  contractList.addEventListener("toggle", function () {
    if (this.open) {
      document.getElementById("task-history").open = false;
      document.getElementById("contract-list-list").replaceChildren(historyEmpty("contracts.loading"));
      vscode.postMessage({ type: "contracts.request" });
    }
    positionTaskHistory();
  });
  document.querySelector("#task-history > summary").addEventListener("keydown", handleHistoryKeydown);
  document.getElementById("task-history").addEventListener("toggle", positionTaskHistory);
  window.addEventListener("resize", positionTaskHistory);
  const layoutObserver = new ResizeObserver(positionTaskHistory);
  layoutObserver.observe(document.getElementById("run-status"));
  layoutObserver.observe(document.getElementById("agent-progress"));

  const actions = document.getElementById("workflow-history");
  const overflow = document.getElementById("workflow-history-toggle");
  overflow.addEventListener("click", () => {
    const open = actions.classList.toggle("is-open");
    overflow.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", event => {
    if (!actions.contains(event.target)) closeHistoryMenu();
  });
  actions.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      contractList.open = false;
      document.getElementById("task-history").open = false;
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
  document.getElementById("task-history").addEventListener("toggle", function () {
    if (this.open) contractList.open = false;
  });
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
    const progress = document.getElementById("agent-progress");
    const available = status.clientWidth - (progress.hidden ? 0 : progress.getBoundingClientRect().width + 8);
    actions.classList.toggle("is-compact", available < 430);
    status.style.setProperty("--workflow-header-width", Math.max(36, available) + "px");
    for (const id of ["contract-list", "task-history"]) positionHistory(id);
  }

  function positionHistory(id) {
    const history = document.getElementById(id);
    const summary = history.querySelector("summary");
    summary.setAttribute("aria-expanded", String(history.open));
    if (!history.open) return;
    const list = document.getElementById(id + "-list");
    const bounds = summary.getBoundingClientRect();
    const width = Math.min(440, window.innerWidth - 16);
    const below = window.innerHeight - bounds.bottom - 12;
    const above = bounds.top - 12;
    const down = below >= Math.min(180, above);
    const height = Math.max(0, Math.min(400, down ? below : above));
    list.classList.add("is-flyout");
    list.style.left = Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)) + "px";
    list.style.width = width + "px";
    list.style.removeProperty("height");
    list.style.maxHeight = height + "px";
    list.style.top = down ? bounds.bottom + 4 + "px" : "auto";
    list.style.bottom = down ? "auto" : window.innerHeight - bounds.top + 4 + "px";
  }

  return {
    contractList, positionTaskHistory, showConversationList, showSavedConversation,
    conversationList
  };
};
