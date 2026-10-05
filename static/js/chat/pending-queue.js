globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.pendingQueue = function (host) {
  "use strict";

  const {
    state, t, pendingQueueRows, vscode, cancelRun, uiLocale, submissionFromExecution,
    hasComposerContent, renderSubmission, prompt, renderAll, resizePrompt, persist
  } = host;

  let confirmationTimer;
  function checkPendingConfirmations() {
    confirmationTimer = undefined;
    const ids = (state.pendingRequests || []).filter(item => !item.rejected).map(item => item.id);
    if (ids.length) vscode.postMessage({ type: "chat.status", ids });
    scheduleConfirmationCheck();
  }
  function scheduleConfirmationCheck() {
    if (confirmationTimer !== undefined || !(state.pendingRequests || []).some(item => !item.rejected)) return;
    confirmationTimer = setTimeout(checkPendingConfirmations, 2000);
  }

  function renderPendingQueue() {
    scheduleConfirmationCheck();
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
          state.recoveredRequest = { id: request.id, execution: request.execution };
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

  return {
    renderPendingQueue
  };
};
