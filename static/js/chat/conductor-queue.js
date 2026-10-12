globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.conductorQueue = function (host) {
  "use strict";

  // The chat passes no container (the board sits above the composer); the control center passes its own
  // section and asks for the worker list. Both read the same projection rows and versions.
  const { state, t, vscode, renderAll, persist, renderAssistant, boardContainer, showWorkers } = host;
  const TERMINAL = new Set(["completed", "failed", "cancelled"]);
  // Canonical projection rows by key (request:, worker:, conductor:, input:) with their versions.
  const board = new Map();
  const answerDrafts = new Map();
  let cursor = 0, enabled = false, role = "unknown", error = "", lagMs = null, updatedAt = null;
  let awaitingSnapshot = false, buffered = [], resyncTimer;

  function rows(prefix) {
    return [...board.values()].filter(row => row.key.startsWith(prefix)).map(row => row.payload);
  }
  function conductorLabel(conductorId) {
    if (!conductorId) return t("ui.main");
    const conductor = board.get("conductor:" + conductorId)?.payload;
    return t("conductorQueue.conductor", conductor ? conductor.ordinal : "?");
  }
  function requestTitle(requestId) {
    return board.get("request:" + requestId)?.payload.title || requestId || "";
  }

  function applyState(entry) {
    const previous = board.get(entry.key);
    if (previous && previous.version >= entry.version) return false; // replayed or reordered rows never regress
    board.set(entry.key, { key: entry.key, version: entry.version, payload: entry.payload });
    if (entry.key.startsWith("worker:") && entry.payload.status !== "awaiting-answer") answerDrafts.delete(entry.payload.id);
    if (entry.key.startsWith("input:")) {
      // A held message's question item re-renders once the Human's choice has been applied.
      for (const item of state.timeline) {
        if (item.type === "conductor" && item.inputId === entry.payload.inputId) item.inputStatus = entry.payload.status;
      }
    }
    return true;
  }

  function timelineItem(id) {
    return state.timeline.find(item => item.id === id);
  }

  function applyChat(entry) {
    const value = entry.payload;
    if (value.role === "user") {
      const id = value.clientMessageId || "cq-" + entry.key;
      const existing = timelineItem(id);
      if (existing) existing.conductorAcceptedAt = value.acceptedAt;
      else state.timeline.push({ type: "user", id, text: value.text || "", conductorAcceptedAt: value.acceptedAt });
      return;
    }
    if (value.role === "assistant") {
      const id = "cq-" + value.messageKey;
      const existing = timelineItem(id);
      const base = { type: "conductor", id, kind: "reply", requestId: value.requestId, conductorId: value.conductorId,
        label: conductorLabel(value.conductorId), title: requestTitle(value.requestId), at: value.at };
      if (value.chunk) {
        if (existing && !existing.streaming) return; // the committed answer already arrived
        if (existing) existing.text += value.text;
        else state.timeline.push({ ...base, text: value.text, streaming: true, final: false });
      } else if (existing) {
        Object.assign(existing, { text: value.text, streaming: false, final: Boolean(value.final) });
      } else {
        state.timeline.push({ ...base, text: value.text, streaming: false, final: Boolean(value.final) });
      }
      return;
    }
    const id = "cq-" + entry.key;
    if (timelineItem(id)) return;
    state.timeline.push({ type: "conductor", id, kind: value.role, requestId: value.requestId, delegationId: value.delegationId,
      conductorId: value.conductorId, label: value.conductorId ? conductorLabel(value.conductorId) : "", title: value.title || requestTitle(value.requestId),
      status: value.status, code: value.code, text: value.text || "", inputId: value.inputId, question: value.question,
      detail: value.detail, questionId: value.questionId, catalog: value.catalog, intents: value.intents, count: value.count, candidates: value.candidates, attemptCount: value.attemptCount, at: value.at,
      inputStatus: value.inputId ? board.get("input:" + value.inputId)?.payload.status : undefined });
  }

  function apply(entries) {
    let latest = 0;
    for (const entry of entries) {
      if (entry.id <= cursor) continue; // reconnect duplicates
      cursor = entry.id;
      latest = Math.max(latest, entry.eventAt || 0);
      if (entry.kind === "state") applyState(entry);
      else if (entry.kind === "chat") applyChat(entry);
    }
    if (latest) {
      lagMs = Math.max(0, Date.now() - latest * 1000);
      updatedAt = Date.now();
    }
  }

  function reset(snapshot) {
    board.clear();
    state.timeline = state.timeline.filter(item => item.type !== "conductor");
    for (const row of snapshot.state || []) board.set(row.key, row);
    cursor = 0;
    apply((snapshot.chat || []).map(entry => ({ ...entry, id: entry.id })));
    cursor = Number(snapshot.cursor) || 0;
    const later = buffered.filter(entry => entry.id > cursor);
    buffered = [];
    awaitingSnapshot = false;
    apply(later);
  }

  function resync() {
    awaitingSnapshot = true;
    vscode.postMessage({ type: "conductor.resync" });
  }

  function receive(message) {
    if (message.type === "conductor.state") {
      const previous = role;
      enabled = message.enabled;
      role = message.role || role;
      error = message.error || "";
      if (!enabled) { board.clear(); state.timeline = state.timeline.filter(item => item.type !== "conductor"); }
      else if (role === "disconnected") {
        // One automatic reconnect; the board keeps a manual reconnect control afterwards.
        if (resyncTimer === undefined) resyncTimer = setTimeout(() => { resyncTimer = undefined; resync(); }, 1000);
      } else if (previous === "disconnected") {
        // Rows produced while disconnected are recovered from a fresh snapshot, never assumed.
        clearTimeout(resyncTimer);
        resyncTimer = undefined;
        resync();
      }
    } else if (message.type === "conductor.snapshot") {
      reset(message.snapshot || {});
    } else if (message.type === "conductor.feed") {
      if (awaitingSnapshot) buffered.push(...message.entries);
      else apply(message.entries);
    } else if (message.type === "conductor.accepted") {
      state.pendingRequests = (state.pendingRequests || []).filter(item => item.id !== message.id);
      const existing = timelineItem(message.id);
      if (existing) existing.conductorAcceptedAt = existing.conductorAcceptedAt || message.acceptedAt;
      else state.timeline.push({ type: "user", id: message.id, text: message.text, conductorAcceptedAt: message.acceptedAt });
      state.startedMessageIds = [...new Set([...(state.startedMessageIds || []), message.id])].slice(-400);
    }
    renderAll();
    renderBoard();
    persist(false);
  }

  function control(payload) {
    vscode.postMessage({ type: "conductor.control", action: payload.action, requestId: payload.requestId, delegationId: payload.delegationId,
      inputId: payload.inputId, relation: payload.relation, expectedVersion: payload.expectedVersion, chatId: payload.chatId, text: payload.text });
  }

  function button(text, onClick, className) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "conductor-queue-button" + (className ? " " + className : "");
    element.textContent = text;
    element.addEventListener("click", onClick);
    return element;
  }

  function statusText(status) {
    return t("conductorQueue.status." + status);
  }

  function renderEntry(content, event) {
    content.classList.add("conductor-entry");
    content.dataset.kind = event.kind;
    const label = document.createElement("div");
    label.className = "conductor-entry-label";
    const identity = event.kind === "reply" ? t("ui.main") : event.conductorId ? conductorLabel(event.conductorId) : "";
    label.textContent = event.kind === "status" ? identity : [identity, event.title].filter(Boolean).join(" · ");
    if (label.textContent) content.append(label);
    const body = document.createElement("div");
    body.className = "conductor-entry-body";
    content.append(body);
    if (event.kind === "plan") {
      body.textContent = planText({ count: event.count, intents: event.intents });
      return;
    }
    if (event.kind === "reply") {
      renderAssistant(body, { type: "assistant", id: event.id, text: event.text, phase: event.final ? "final" : "commentary", streaming: event.streaming });
      if (event.streaming) body.dataset.streaming = "true";
      return;
    }
    if (event.kind === "status") {
      body.textContent = event.delegationId
        ? t("conductorQueue.delegation", event.title, statusText(event.status)) + (event.attemptCount > 1 ? " · " + t("conductorQueue.attempt", event.attemptCount) : "")
        : t("conductorQueue.request", statusText(event.status));
      return;
    }
    if (event.kind === "question" && event.question === "relation") {
      body.textContent = t("conductorQueue.relationQuestion");
      if (event.inputStatus && event.inputStatus !== "accepted" && event.inputStatus !== "held") {
        const done = document.createElement("div");
        done.className = "conductor-entry-meta";
        done.textContent = t("conductorQueue.resolved");
        body.append(done);
        return;
      }
      const choices = document.createElement("div");
      choices.className = "conductor-entry-actions";
      for (const candidate of event.candidates || []) {
        choices.append(button(t("conductorQueue.followup", candidate.title), () =>
          control({ action: "resolve-input", inputId: event.inputId, relation: "followup", requestId: candidate.requestId })));
      }
      choices.append(button(t("conductorQueue.newRequest"), () => control({ action: "resolve-input", inputId: event.inputId, relation: "new" })));
      body.append(choices);
      return;
    }
    if (event.kind === "question" && event.question === "worker") {
      body.textContent = event.text || event.detail?.resultPath || t("conductorQueue.wait.question");
      const worker = board.get("worker:" + event.delegationId)?.payload;
      if (worker?.status === "awaiting-answer") {
        const input = document.createElement("input");
        input.type = "text";
        input.value = answerDrafts.get(worker.id) || "";
        input.addEventListener("input", () => answerDrafts.set(worker.id, input.value));
        input.setAttribute("aria-label", t("conductorQueue.answer"));
        body.append(input, button(t("conductorQueue.answer"), () => {
          if (input.value.trim()) control({ action: "answer-worker", delegationId: worker.id, expectedVersion: worker.version, chatId: worker.chatId, text: input.value });
        }));
      }
      return;
    }
    // Known runtime codes are explained in the UI language; otherwise the runtime's own message is shown.
    const key = "conductorQueue.code." + (event.code || "notice");
    const explained = t(key);
    body.textContent = explained !== key ? explained : event.text || explained;
  }

  function boardElement() {
    if (boardContainer) return boardContainer;
    let element = document.getElementById("conductor-queue-board");
    if (!element) {
      element = document.createElement("section");
      element.id = "conductor-queue-board";
      element.className = "conductor-queue-board";
      element.setAttribute("aria-label", t("conductorQueue.board"));
      element.setAttribute("role", "region");
      const region = document.querySelector(".composer-region");
      if (region) region.before(element);
      else document.body.append(element);
    }
    return element;
  }

  function intentText(intent) {
    return [intent.title, t(intent.parallelCandidate ? "conductorQueue.parallel" : "conductorQueue.sequential"),
      intent.dependencies?.length ? t("conductorQueue.dependencies", intent.dependencies.map(requestTitle).join(", ")) : "",
      intent.reason, t("conductorQueue.reason." + intent.admissionReason)].filter(Boolean).join(" · ");
  }

  function planText(plan) {
    return [t("conductorQueue.intents", plan.count), ...(plan.intents || []).map(intentText)].join("\n");
  }

  function renderBoard() {
    const element = boardElement();
    element.hidden = !enabled;
    if (!enabled) return;
    const header = document.createElement("div");
    header.className = "conductor-queue-header";
    const connection = document.createElement("span");
    connection.className = "conductor-queue-role";
    connection.dataset.role = role;
    connection.textContent = t("conductorQueue.role." + role);
    header.append(connection);
    const lag = document.createElement("span");
    lag.className = "conductor-queue-lag";
    lag.textContent = lagMs === null ? t("conductorQueue.noUpdates") : t("conductorQueue.lag", Math.round(lagMs));
    if (updatedAt) lag.title = new Date(updatedAt).toLocaleTimeString();
    header.append(lag);
    if (role === "disconnected") header.append(button(t("conductorQueue.reconnect"), resync));
    if (error) {
      const failure = document.createElement("span");
      failure.className = "conductor-queue-error";
      failure.textContent = error;
      header.append(failure);
    }
    const list = document.createElement("ul");
    list.className = "conductor-queue-requests";
    const workers = rows("worker:");
    for (const request of rows("request:").filter(item => !TERMINAL.has(item.status)).sort((a, b) => a.receivedAt - b.receivedAt)) {
      const own = workers.filter(worker => worker.requestId === request.id);
      const done = own.filter(worker => TERMINAL.has(worker.status)).length;
      const row = document.createElement("li");
      row.dataset.requestId = request.id;
      row.dataset.status = request.status;
      const text = document.createElement("span");
      text.className = "conductor-queue-request";
      text.textContent = [conductorLabel(request.conductorId), request.title, statusText(request.status),
        own.length ? t("conductorQueue.progress", done, own.length) : ""].filter(Boolean).join(" · ");
      row.append(text);
      if (request.intent) {
        const detail = document.createElement("span");
        detail.className = "conductor-entry-meta";
        detail.textContent = intentText(request.intent);
        row.append(detail);
      }
      if (request.status !== "cancelling") {
        row.append(button(t("conductorQueue.cancel"), () => control({ action: "cancel", requestId: request.id, expectedVersion: request.version, chatId: request.chatId }), "conductor-queue-cancel"));
      }
      for (const worker of own.filter(item => item.status === "awaiting-approval")) {
        const approval = document.createElement("span");
        approval.className = "conductor-queue-approval";
        approval.textContent = worker.title;
        approval.append(button(t("conductorQueue.approve"), () => control({ action: "approve", delegationId: worker.id, expectedVersion: worker.version, chatId: worker.chatId })),
          button(t("conductorQueue.cancel"), () => control({ action: "cancel", delegationId: worker.id, expectedVersion: worker.version, chatId: worker.chatId })));
        row.append(approval);
      }
      list.append(row);
    }
    const plans = document.createElement("div");
    plans.className = "conductor-queue-plans";
    for (const plan of rows("plan:")) {
      const summary = document.createElement("div");
      summary.dataset.planId = plan.requestId;
      summary.textContent = planText(plan);
      plans.append(summary);
    }
    element.replaceChildren(header, ...(plans.children.length ? [plans] : []), ...(list.children.length ? [list] : []), ...(showWorkers ? [workerList(workers)] : []));
  }

  function ago(seconds) {
    if (!seconds) return "";
    return t("conductorQueue.ago", Math.max(0, Math.round(Date.now() / 1000 - seconds)));
  }

  /** Each worker's actual task, step, wait reason, last update and result, straight from the projection. */
  function workerList(workers) {
    const table = document.createElement("ul");
    table.className = "conductor-queue-workers-list";
    table.setAttribute("aria-label", t("conductorQueue.workers"));
    const ordered = [...workers].sort((a, b) => Number(TERMINAL.has(a.status)) - Number(TERMINAL.has(b.status)) || (b.lastUpdateAt || 0) - (a.lastUpdateAt || 0));
    for (const worker of ordered) {
      const row = document.createElement("li");
      row.dataset.delegationId = worker.id;
      row.dataset.status = worker.status;
      const title = document.createElement("span");
      title.className = "conductor-queue-worker-title";
      title.textContent = worker.title;
      const meta = document.createElement("span");
      meta.className = "conductor-queue-worker-meta";
      const progress = worker.progress || {};
      const step = progress.step ? progress.step + (Number.isInteger(progress.completed) && Number.isInteger(progress.total) ? " (" + progress.completed + "/" + progress.total + ")" : "") : "";
      const result = worker.result && (worker.result.summary || worker.result.resultPath) || worker.error && (worker.error.code || worker.error.message) || "";
      meta.textContent = [conductorLabel(worker.conductorId) + " · " + requestTitle(worker.requestId), statusText(worker.status), step,
        worker.waitReason ? t("conductorQueue.wait." + worker.waitReason.split(":")[0]) : "", worker.attemptCount > 1 ? t("conductorQueue.attempt", worker.attemptCount) : "",
        t("conductorQueue.updated", ago(worker.lastUpdateAt)), result ? t("conductorQueue.result", result) : ""].filter(Boolean).join(" · ");
      const workspace = worker.external?.workspace || worker.result?.workspace;
      if (workspace) {
        const detail = document.createElement("span");
        detail.className = "conductor-entry-meta";
        detail.textContent = [t("conductorQueue.workspace"), workspace.phase || workspace.mode, workspace.path,
          worker.result?.integrationStatus, workspace.error?.message,
          ...(workspace.repositories || []).map(unit => [unit.phase, unit.path, unit.error?.message || unit.error, unit.cleanupPending].filter(Boolean).join(" · "))].filter(Boolean).join(" · ");
        row.append(detail);
        if (worker.status === "completed" && workspace.mode === "code") {
          const merged = workspace.repositories?.every(unit => unit.phase === "merged");
          const cleaned = workspace.repositories?.every(unit => unit.cleaned);
          if (!merged) row.append(button(t("conductorQueue.integrate"), () => control({ action: "integrate-workspace", delegationId: worker.id, expectedVersion: worker.version, chatId: worker.chatId })));
          else if (!cleaned) row.append(button(t("conductorQueue.cleanup"), () => control({ action: "cleanup-workspace", delegationId: worker.id, expectedVersion: worker.version, chatId: worker.chatId })));
        }
      }
      if (worker.lastUpdateAt) meta.title = new Date(worker.lastUpdateAt * 1000).toLocaleString();
      row.append(title, meta);
      table.append(row);
    }
    return table;
  }

  if (showWorkers) setInterval(() => { if (enabled) renderBoard(); }, 1000); // keeps "updated n s ago" honest

  return { receive, renderEntry, renderBoard, get enabled() { return enabled; }, get cursor() { return cursor; }, get lagMs() { return lagMs; },
    workers: () => rows("worker:"), requests: () => rows("request:") };
};
