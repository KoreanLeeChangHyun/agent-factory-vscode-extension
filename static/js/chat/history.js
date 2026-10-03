globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.history = function (host) {
  "use strict";

  const {
    handleSettingMenuKeydown, vscode, submissionMenu, questionButton, t, closeQuestionMenu,
    renderAssistantMarkdown, assistantDisplayText, historyEmpty
  } = host;

  const contractList = document.getElementById("contract-list");
  contractList.querySelector("summary").addEventListener("keydown", handleSettingMenuKeydown);
  contractList.addEventListener("toggle", function () {
    if (this.open) {
      document.getElementById("task-history").open = false;
      document.getElementById("contract-list-list").replaceChildren(historyEmpty("contracts.loading"));
      vscode.postMessage({ type: "contracts.request" });
    }
    positionTaskHistory();
  });
  document.querySelector("#task-history > summary").addEventListener("keydown", handleSettingMenuKeydown);
  document.getElementById("task-history").addEventListener("toggle", positionTaskHistory);
  window.addEventListener("resize", positionTaskHistory);
  new ResizeObserver(positionTaskHistory).observe(submissionMenu);

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
    for (const id of ["contract-list", "task-history"]) positionHistory(id);
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

  return {
    contractList, positionTaskHistory, showConversationList, showSavedConversation,
    conversationList
  };
};
