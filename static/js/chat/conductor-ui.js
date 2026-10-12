globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.conductorUi = function (host) {
  "use strict";
  const { state, timeline, persist, renderAll, uiLocale } = host;
  const terminal = new Set(["completed", "failed", "cancelled"]);
  // Read-only copies of runtime projection rows. Never infer owners or persist these as runtime state.
  const projection = new Map();
  const inputsByClient = new Map(), latestQuestions = new Map(), latestStatuses = new Map();
  const answerSubmissions = new Set();
  let displayEvents = new Map();
  let enabled = false, targeting = false, cursor = 0, waiting = false, buffered = [];
  const view = state.conductorView;
  const strings = {
    en: { all: "All", tasks: "By task", decisions: "Human decisions", target: "Message target", auto: "All · let conductor route", new: "New request", followup: "Follow-up", received: "Received", answer: "Awaiting answer", requests: "Requests", conductor: "Conductor instances", workers: "Active performers", wait: "Waiting", human: "Human decision", ownership: "Ownership", capacity: "Employment limit", other: "Other", context: "Assigned instance context left", unavailable: "Unavailable", models: "Conductor model / Performer default", model: "Conductor model", performer: "Performer default", isolation: "Task isolation default", shared: "Shared checkout", isolated: "Isolated", records: "Processing records", result: "Result", paths: "Changed paths", answerAction: "Answer", task: "Task", unassigned: "Awaiting task assignment", integration: "Targeted sending requires the Host routing update. Your draft is preserved.", missing: "This task is no longer available. Select a message target.", sessions: "Conductor instances and handoff slots", close: "Close", domain: "Area unavailable", instance: "Instance", area: "Assigned area", slot: "Handoff slot", epoch: "Owner epoch", questionId: "Question", recordId: "Question record", reason: "Stopped because", decision: "Decision", impact: "Affected scope", internal: "Internal wait", fault: "Runtime fault", unknownDecision: "Decision metadata unavailable", continued: "Task continuing", independent: "Other active tasks", sending: "Answer sending" },
    ko: { all: "전체", tasks: "작업별", decisions: "사용자 결정 대기", target: "메시지 대상", auto: "전체 · 지휘자 분류", new: "새 요청", followup: "후속", received: "접수", answer: "답변 대기", requests: "요청", conductor: "지휘자 인스턴스", workers: "수행자 활성", wait: "대기", human: "사용자 결정", ownership: "소유권", capacity: "고용 상한", other: "기타", context: "담당 인스턴스 컨텍스트 잔여", unavailable: "확인 불가", models: "지휘자 모델 / 수행자 기본 모델", model: "지휘자 모델", performer: "수행자 기본 모델", isolation: "작업별 격리 기본 정책", shared: "공유 체크아웃", isolated: "격리", records: "처리 기록", result: "결과", paths: "변경 경로", answerAction: "답변", task: "작업", unassigned: "작업 귀속 대기", integration: "대상 지정 전송에는 Host 귀속 연결이 필요합니다. 초안은 보존되었습니다.", missing: "현재 사용할 수 없는 작업입니다. 메시지 대상을 선택하십시오.", sessions: "담당 영역 · 지휘자 인스턴스 · 교대 슬롯", close: "닫기", domain: "담당 영역 미제공", instance: "인스턴스", area: "담당 영역", slot: "교대 슬롯", epoch: "소유권 epoch", questionId: "질문", recordId: "질문 기록", reason: "중단 이유", decision: "필요한 결정", impact: "영향 범위", internal: "내부 대기", fault: "런타임 장애", unknownDecision: "결정 메타데이터 미제공", continued: "작업 계속 진행", independent: "다른 활성 작업", sending: "답변 전송 중" }
  };
  const text = key => (strings[uiLocale().startsWith("ko") ? "ko" : "en"])[key];
  const rows = kind => [...projection.values()].filter(row => row.key.startsWith(kind + ":")).map(row => row.payload);
  const request = id => projection.get("request:" + id)?.payload;
  const worker = id => projection.get("worker:" + id)?.payload;
  const conductor = id => projection.get("conductor:" + id)?.payload;
  function canonicalQuestion(event) {
    const id = event?.questionId || event?.detail?.questionId;
    if (id) return projection.get("question:" + id)?.payload;
    if (event?.question === "area") return rows("question").find(item => item.kind === "area" && item.input_id === event.inputId);
    return undefined;
  }
  function areaName(item) {
    const area = item?.area;
    return area ? [area.domain || area.domainId, area.subdomain || area.subdomainId].filter(value => typeof value === "string" && value).join(" / ") : "";
  }
  const pendingWorker = item => item.status === "awaiting-approval" ||
    item.status === "awaiting-answer" && questionClass(state.timeline.find(event => event.id === latestQuestions.get(item.id))) === "human";
  function questionClass(event) {
    if (!event) return "unknown";
    if (["relation", "area"].includes(event.question)) return "human";
    const own = worker(event.delegationId), detail = event.detail || {};
    if (detail.requiresHuman === false) return "internal";
    if (detail.requiresHuman === true || detail.decisionScope === "external-prerequisite" && ["approval", "clarification"].includes(detail.decisionKind)) return "human";
    const reason = own?.waitReason || detail.waitReason || "";
    if (/^(environment|provider|credentials|observation|zombie)/.test(reason)) return "fault";
    if (/^(dependency|resource|ownership|capacity|employment|dispatch|worker-start|internal|recovery)/.test(reason) || detail.requiresHuman === false) return "internal";
    if (["approval", "clarification"].includes(detail.decisionKind)) return "human";
    if (canonicalQuestion(event)) return "human";
    return "unknown";
  }
  function workerQuestionPending(event) {
    if (canonicalQuestion(event) && canonicalQuestion(event).state !== "pending") return false;
    return event?.question === "worker" && worker(event.delegationId)?.status === "awaiting-answer" && latestQuestions.get(event.delegationId) === event.id;
  }
  function button(label, action) {
    const element = document.createElement("button"); element.type = "button"; element.className = "conductor-queue-button"; element.textContent = label;
    element.addEventListener("click", action); return element;
  }
  function accept(row) {
    if (!projection.has(row.key) || projection.get(row.key).version < row.version) {
      projection.set(row.key, row);
      if (row.key.startsWith("input:") && row.payload.clientMessageId) inputsByClient.set(row.payload.clientMessageId, row.payload);
    }
  }
  function receive(message) {
    if (message.type === "conductor.state") {
      const wasEnabled = enabled; enabled = message.enabled; targeting = message.targeting === true;
      if (enabled && !wasEnabled) waiting = true;
      if (!enabled) { projection.clear(); inputsByClient.clear(); buffered = []; cursor = 0; waiting = false; }
    } else if (message.type === "conductor.snapshot") {
      const snapshot = message.snapshot || {};
      const later = [...buffered, ...projection.values()].filter(entry => entry.id > (snapshot.cursor || 0));
      projection.clear(); inputsByClient.clear(); (snapshot.state || []).forEach(accept);
      cursor = Number(snapshot.cursor) || 0; waiting = false; buffered = [];
      later.forEach(entry => { if (entry.kind === "state") accept(entry); cursor = Math.max(cursor, entry.id); });
    } else if (message.type === "conductor.feed") {
      if (waiting) buffered.push(...message.entries);
      else for (const entry of message.entries) {
        if (entry.id <= cursor) continue;
        if (entry.kind === "state") accept(entry);
        cursor = entry.id;
      }
    }
  }
  function taskId(event) {
    if (event.requestId) return event.requestId;
    if (event.delegationId) return worker(event.delegationId)?.requestId;
    if (event.type === "user") return inputsByClient.get(event.id)?.requestId;
    if (event.inputId) return projection.get("input:" + event.inputId)?.payload.requestId;
    return undefined;
  }
  function pendingQuestion(event) {
    if (event.type !== "conductor" || event.kind !== "question") return false;
    const registered = canonicalQuestion(event);
    if (registered) return registered.state === "pending" && questionClass(event) === "human";
    if (event.question === "worker") return workerQuestionPending(event) && questionClass(event) === "human";
    if (event.question === "relation") return ["accepted", "held"].includes(projection.get("input:" + event.inputId)?.payload.status);
    // The runtime does not project a conductor question's resolution. Do not fabricate one.
    return false;
  }
  function decisionCount() {
    const ids = new Set(state.timeline.filter(pendingQuestion).map(event => canonicalQuestion(event)?.id || event.detail?.questionId || event.inputId || event.delegationId || event.id));
    for (const question of rows("question")) if (question.state === "pending" && questionClass({ question: question.kind, questionId: question.id, delegationId: question.delegation_id }) === "human") ids.add(question.id);
    return ids.size + rows("worker").filter(item => item.status === "awaiting-approval").length;
  }
  function events(all) {
    if (enabled) {
      const existing = new Set(all.filter(item => item.type === "conductor" && item.kind === "question").map(item => canonicalQuestion(item)?.id));
      // A question-state can precede its chat delivery. Render the committed question
      // without adding a synthetic entry to the session's original timeline.
      all = [...all, ...rows("question").filter(item => item.state === "pending" && !existing.has(item.id)).map(item => ({
        type: "conductor", kind: "question", id: "cq-question-" + item.id, questionId: item.id, question: item.kind,
        requestId: item.request_id, delegationId: item.delegation_id, inputId: item.input_id, conductorId: item.conductor_id, text: item.text || ""
      }))];
    }
    displayEvents = new Map(all.map(item => [item.id, item]));
    latestQuestions.clear(); latestStatuses.clear();
    for (const item of all) {
      if (item.type !== "conductor" || !item.delegationId) continue;
      if (item.kind === "question") latestQuestions.set(item.delegationId, item.id);
      if (item.kind === "status") latestStatuses.set(item.delegationId, item.id);
    }
    if (!enabled) return all;
    if (view.filter === "decisions") return all.filter(event => pendingQuestion(event) ||
      (event.type === "conductor" && event.kind === "status" && worker(event.delegationId)?.status === "awaiting-approval" &&
       latestStatuses.get(event.delegationId) === event.id));
    if (view.filter === "tasks" && view.target && view.target !== "new") return all.filter(event => taskId(event) === view.target);
    return all;
  }
  function key(event) {
    if (!enabled) return "";
    const id = taskId(event);
    return JSON.stringify([id, request(id)?.version, worker(event.delegationId)?.version, pendingQuestion(event), canAnswerChoice(event), event.choiceAnswer, questionClass(event), canonicalQuestion(event)]);
  }
  function selectTarget(value) {
    view.target = value;
    if (value && value !== "new") view.filter = "tasks";
    else view.filter = "all";
    persist(false); renderAll();
  }
  function submissionTarget() {
    if (!enabled || !view.target) return undefined;
    return view.target === "new" ? { relation: "new" } : { relation: "followup", requestId: view.target };
  }
  function submissionError(target = submissionTarget()) {
    if (!enabled || !target) return "";
    if (target.relation === "followup" && (!request(target.requestId) || terminal.has(request(target.requestId).status))) return text("missing");
    return targeting ? "" : text("integration");
  }
  function prepareTimeline() {
    // Restore the renderer's flat mounting surface without replacing any message node or its controls.
    for (const thread of timeline.querySelectorAll(":scope > .conductor-thread")) {
      for (const message of thread.querySelectorAll(".conductor-thread-body .message")) thread.before(message);
      thread.remove();
    }
  }
  function taskLabel(id) {
    return id ? id + " · " + (request(id)?.title || id) : text("unassigned");
  }
  function taskColor(id) {
    let hash = 0; for (const letter of id || "") hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
    return ["blue", "purple", "green"][hash % 3];
  }
  function decorate(message, event) {
    if (!enabled) { message.querySelector(":scope > .conductor-task-band")?.remove(); return; }
    const id = taskId(event);
    message.dataset.taskId = id || ""; message.dataset.taskColor = taskColor(id);
    let band = message.querySelector(":scope > .conductor-task-band");
    if (!band) { band = button("", () => { if (message.dataset.taskId) selectTarget(message.dataset.taskId); }); band.className = "conductor-task-band"; message.prepend(band); }
    band.textContent = taskLabel(id); band.disabled = !id;
  }
  function renderEntry(content, event) {
    const own = worker(event.delegationId);
    if (event.kind === "status" && own) {
      const details = document.createElement("details"); details.className = "conductor-worker-summary";
      const summary = document.createElement("summary");
      summary.textContent = [own.title, host.t("conductorQueue.status." + (event.status || own.status)), own.progress?.step].filter(Boolean).join(" · ");
      const body = document.createElement("div"); body.className = "conductor-worker-result";
      const result = own.result;
      if (result?.summary || result?.resultPath) { const p = document.createElement("p"); p.textContent = text("result") + " · " + (result.summary || result.resultPath); body.append(p); }
      if (result?.changedPaths?.length) { const p = document.createElement("p"); p.textContent = text("paths") + "\n" + result.changedPaths.join("\n"); body.append(p); }
      host.queue.renderEntry(body, event);
      if (own.status === "awaiting-approval") {
        details.open = true;
        for (const action of ["approve", "cancel"]) body.append(button(host.t("conductorQueue." + action), () => host.vscode.postMessage({ type: "conductor.control", action, delegationId: own.id, expectedVersion: own.version, chatId: own.chatId })));
      }
      details.append(summary, body); content.append(details); return;
    }
    if (event.kind === "question" && event.question === "area") {
      content.classList.add("conductor-entry"); content.dataset.kind = event.kind;
      const body = document.createElement("div"); body.className = "conductor-entry-body"; body.textContent = event.text; content.append(body);
      renderAreaAnswer(body, event);
    } else if (event.kind === "question" && event.question === "worker") {
      content.classList.add("conductor-entry"); content.dataset.kind = event.kind;
      const body = document.createElement("div"); body.className = "conductor-entry-body"; body.textContent = event.text || ""; content.append(body);
      if (workerQuestionPending(event) && !["internal", "fault"].includes(questionClass(event))) renderWorkerAnswer(body, event, own);
      else if (own && own.status !== "awaiting-answer") { const status = document.createElement("p"); status.textContent = text("continued") + " · " + host.t("conductorQueue.status." + own.status); body.append(status); }
    } else if (event.kind === "question" && event.question === "conductor") {
      content.classList.add("conductor-entry"); content.dataset.kind = event.kind;
      host.renderQuestion(content, event);
    } else host.queue.renderEntry(content, event);
    if (event.kind === "question") {
      content.classList.add("conductor-question-card");
      const voice = document.createElement("div"); voice.className = "conductor-entry-label"; voice.textContent = host.t("ui.main"); content.prepend(voice);
      content.dataset.pending = String(pendingQuestion(event));
      renderQuestionMetadata(content, event);
      if (event.question === "conductor") {
        const input = document.createElement("input"); input.type = "text"; input.setAttribute("aria-label", text("answerAction") + " · " + taskLabel(event.requestId));
        const draftKey = canonicalQuestion(event)?.id || event.detail?.questionId || event.id;
        input.value = view.answers[draftKey] || view.answers[event.id] || "";
        input.addEventListener("input", () => { view.answers[draftKey] = input.value; persist(false); });
        const send = button(text("answerAction"), () => {
          if (canonicalQuestion(event)) { sendConductorAnswer(event, input.value, send); return; }
          selectTarget(event.requestId);
          if (input.value.trim()) host.submitAnswer(input.value);
        });
        send.disabled = !targeting || canonicalQuestion(event) && (!pendingQuestion(event) || answerSubmissions.has("question:" + canonicalQuestion(event).id)); send.title = targeting ? taskLabel(event.requestId) : text("integration");
        content.append(input, send);
      }
    }
  }
  function renderWorkerAnswer(body, event, own) {
    const input = document.createElement("input"); input.type = "text"; input.setAttribute("aria-label", text("answerAction") + " · " + taskLabel(event.requestId));
    const draftKey = canonicalQuestion(event)?.id || event.detail?.questionId || event.id;
    input.value = view.answers[draftKey] || view.answers[event.id] || "";
    input.addEventListener("input", () => { view.answers[draftKey] = input.value; persist(false); });
    const submissionKey = own.id + ":" + own.version;
    const sendAnswer = value => {
      const current = worker(own.id);
      if (!value.trim() || current?.version !== own.version || current.status !== "awaiting-answer" || answerSubmissions.has(submissionKey)) return;
      answerSubmissions.add(submissionKey);
      for (const control of body.querySelectorAll("button, input")) control.disabled = true;
      send.textContent = text("sending");
      const questionId = canonicalQuestion(event)?.id || event.detail?.questionId;
      host.vscode.postMessage({ type: "conductor.control", action: "answer-worker", delegationId: own.id, ...(questionId ? { questionId } : {}), expectedVersion: own.version, chatId: own.chatId, text: value });
    };
    const send = button(text("answerAction"), () => sendAnswer(input.value));
    input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); sendAnswer(input.value); } });
    const submitted = answerSubmissions.has(submissionKey); input.disabled = send.disabled = submitted;
    if (submitted) send.textContent = text("sending");
    body.append(input, send);
    // Only explicit structured choices supplied with the canonical question become controls.
    const choices = Array.isArray(event.detail?.options) ? event.detail.options : [];
    if (choices.length >= 2 && choices.length <= 3 && choices.every(choice => typeof choice.value === "string" && typeof choice.label === "string")) {
      const table = document.createElement("table"); table.className = "interview-options";
      const header = table.createTHead().insertRow();
      for (const label of uiLocale().startsWith("ko") ? ["선택지", "결정", "장점", "단점"] : ["Option", "Decision", "Advantages", "Disadvantages"]) { const cell = document.createElement("th"); cell.textContent = label; header.append(cell); }
      const entries = table.createTBody();
      choices.forEach((choice, index) => {
        const row = entries.insertRow(), cell = row.insertCell();
        const option = button(String(index + 1), () => sendAnswer(choice.value)); option.className = "interview-choice"; option.dataset.answerValue = choice.value; option.disabled = submitted; option.setAttribute("aria-label", (index + 1) + ": " + choice.label); cell.append(option);
        for (const value of [choice.label, choice.pros, choice.cons]) row.insertCell().textContent = typeof value === "string" ? value : "";
      });
      body.classList.add("markdown-body"); body.append(table);
      const recommended = choices.find(choice => choice.value === event.detail.recommendedValue);
      if (recommended) { const note = document.createElement("p"); note.textContent = (uiLocale().startsWith("ko") ? "권고: " : "Recommendation: ") + recommended.label; body.append(note); }
    }
  }
  function sendConductorAnswer(event, value, control) {
    const question = canonicalQuestion(event), req = request(taskId(event));
    const key = "question:" + question?.id;
    if (!question || question.state !== "pending" || !req || !value.trim() || answerSubmissions.has(key)) return;
    answerSubmissions.add(key); if (control) control.disabled = true;
    host.vscode.postMessage({ type: "conductor.control", action: "answer-question", questionId: question.id, requestId: req.id, expectedVersion: req.version, chatId: req.chatId, text: value });
  }
  function renderAreaAnswer(body, event) {
    if (canonicalQuestion(event) && canonicalQuestion(event).state !== "pending") return;
    const input = projection.get("input:" + event.inputId)?.payload;
    if (input?.status !== "held") return;
    const catalog = event.catalog || input.catalog;
    if (!Array.isArray(catalog?.domains) || !Array.isArray(catalog?.subdomains)) return;
    const domain = document.createElement("select"), child = document.createElement("select");
    domain.setAttribute("aria-label", text("area")); child.setAttribute("aria-label", host.t("maestro.subDomain"));
    const option = (value, label) => { const item = document.createElement("option"); item.value = value; item.textContent = label; return item; };
    domain.append(option("", text("area")), ...catalog.domains.filter(item => !item.provisional).map(item => option(item.id, item.name)));
    const impact = document.createElement("p"); impact.className = "conductor-entry-meta";
    const send = button(text("answerAction"), () => {
      const key = "area:" + event.inputId;
      if (!domain.value || !child.value || answerSubmissions.has(key)) return;
      answerSubmissions.add(key); send.disabled = domain.disabled = child.disabled = true;
      host.vscode.postMessage({ type: "conductor.control", action: "resolve-area", inputId: event.inputId, ...(canonicalQuestion(event) ? { questionId: canonicalQuestion(event).id } : {}), area: { domainId: domain.value, subdomainId: child.value } });
    });
    const preview = () => { const selected = catalog.subdomains.find(item => item.id === child.value); impact.textContent = text("impact") + " · " + (Array.isArray(selected?.writeScope) ? selected.writeScope.join(", ") : text("unavailable")); };
    const update = () => { child.replaceChildren(option("", host.t("maestro.subDomain")), ...catalog.subdomains.filter(item => item.domainId === domain.value).map(item => option(item.id, item.name))); send.disabled = true; preview(); };
    domain.addEventListener("change", update); child.addEventListener("change", () => { send.disabled = !child.value; preview(); }); update(); body.append(domain, child, impact, send);
  }
  function renderQuestionMetadata(content, event) {
    const detail = event.detail || {}, own = worker(event.delegationId);
    const classification = questionClass(event);
    const info = document.createElement("dl"); info.className = "conductor-question-metadata";
    const field = (label, value) => { const term = document.createElement("dt"), description = document.createElement("dd"); term.textContent = text(label); description.textContent = typeof value === "string" && value ? value : text("unavailable"); info.append(term, description); };
    field("task", detail.taskId || taskId(event));
    const registered = canonicalQuestion(event);
    field(registered?.id || detail.questionId ? "questionId" : "recordId", registered?.id || detail.questionId || event.id);
    field("reason", detail.reason || detail.stopReason || own?.waitReason);
    if (classification === "human") field("decision", detail.decision || detail.text || event.text || (event.question === "relation" ? host.t("conductorQueue.relationQuestion") : ""));
    const scopeNames = uiLocale().startsWith("ko") ? { "task-execution": "작업 수행", "scope-expansion": "범위 확장", "external-prerequisite": "외부 입력·조치" } : { "task-execution": "Task execution", "scope-expansion": "Scope expansion", "external-prerequisite": "External input or action" };
    field("impact", detail.impact || scopeNames[detail.decisionScope] || detail.decisionScope);
    if (classification !== "human") { const status = document.createElement("p"); status.className = "conductor-question-classification"; status.textContent = text(classification === "internal" ? "internal" : classification === "fault" ? "fault" : "unknownDecision"); content.append(status); }
    const other = rows("request").filter(item => item.id !== taskId(event) && !terminal.has(item.status));
    field("independent", other.length ? other.map(item => item.id + " · " + host.t("conductorQueue.status." + item.status)).join(", ") : "0");
    content.append(info);
  }
  function finishTimeline() {
    const items = displayEvents;
    const groups = new Map();
    for (const message of timeline.querySelectorAll(":scope > .message")) {
      const event = items.get(message.dataset.id); if (!event) continue;
      decorate(message, event);
      if (!enabled) continue;
      const id = taskId(event); if (!id) continue;
      let group = groups.get(id);
      if (!group) {
        const thread = document.createElement("details"); thread.className = "conductor-thread";
        thread.dataset.taskId = id; thread.dataset.taskColor = taskColor(id); thread.open = view.filter === "decisions" || view.collapsed[id] !== true;
        const summary = document.createElement("summary"); summary.textContent = taskLabel(id);
        const body = document.createElement("div"); body.className = "conductor-thread-body";
        thread.append(summary, body); message.before(thread);
        thread.addEventListener("toggle", () => { if (thread.isConnected && view.filter !== "decisions") { view.collapsed[id] = !thread.open; persist(false); } });
        summary.addEventListener("click", () => { if (view.filter !== "decisions") view.collapsed[id] = thread.open; view.target = id; persist(false); renderControls(); });
        groups.set(id, group = { thread, body });
      }
      if (event.type === "activity") {
        let records = group.body.querySelector(":scope > .conductor-processing");
        if (!records) { records = document.createElement("details"); records.className = "conductor-processing"; const summary = document.createElement("summary"); summary.textContent = text("records"); records.append(summary); group.body.append(records); }
        records.append(message);
      } else group.body.append(message);
    }
  }
  function renderControls() {
    const filters = document.getElementById("conductor-filters");
    const targetRow = document.getElementById("conductor-target-row");
    filters.hidden = targetRow.hidden = !enabled;
    document.body.classList.toggle("conductor-ui-enabled", enabled);
    const mode = document.querySelector("#orchestrate-mode-button span");
    if (mode) {
      mode.textContent = enabled ? uiLocale().startsWith("ko") ? "지휘자" : "Conductor" : host.t("ui.orchestrate");
      if (enabled) {
        const label = mode.textContent + " · " + host.t(mode.parentElement.getAttribute("aria-pressed") === "true" ? "ui.on" : "ui.off");
        mode.parentElement.title = label; mode.parentElement.setAttribute("aria-label", label);
      }
    }
    if (!enabled) return;
    for (const [index, filter] of ["all", "tasks", "decisions"].entries()) {
      const control = filters.children[index]; control.textContent = text(filter) + (filter === "decisions" ? " " + decisionCount() : "");
      control.setAttribute("aria-pressed", String(view.filter === filter));
    }
    const select = document.getElementById("conductor-target");
    select.setAttribute("aria-label", text("target"));
    const choices = [["", text("auto")], ["new", text("new")], ...rows("request").filter(item => !terminal.has(item.status) || item.id === view.target).map(item => [item.id, text("followup") + " · " + taskLabel(item.id)])];
    if (view.target && !choices.some(([value]) => value === view.target)) choices.push([view.target, text("missing")]);
    const nextKey = JSON.stringify(choices);
    if (select.dataset.key !== nextKey) {
      select.replaceChildren(...choices.map(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; return option; })); select.dataset.key = nextKey;
    }
    select.value = view.target;
    document.getElementById("conductor-models").textContent = text("model") + " · " + (host.models().main || text("unavailable")) + " / " + text("performer") + " · " + (host.models().work || text("unavailable"));
    document.getElementById("conductor-isolation").textContent = text("isolation") + " · " + text(state.workIsolation ? "isolated" : "shared");
  }
  function renderWaiting() {
    const region = document.getElementById("conductor-waiting"); region.hidden = !enabled;
    if (!enabled) return;
    const active = rows("request").filter(item => !terminal.has(item.status));
    const key = JSON.stringify([uiLocale(), active]);
    if (region.dataset.key === key) return;
    region.dataset.key = key;
    const summary = document.createElement("summary"); summary.textContent = text("requests") + " " + active.length + " · " + text("answer") + " " + active.filter(item => !item.finalAt).length;
    const list = document.createElement("ul");
    for (const item of active) { const li = document.createElement("li"); li.append(button(taskLabel(item.id), () => selectTarget(item.id))); const time = document.createElement("time"); time.dateTime = new Date(item.receivedAt * 1000).toISOString(); time.textContent = text("received") + " " + new Date(item.receivedAt * 1000).toLocaleTimeString(uiLocale()) + " · " + host.t("conductorQueue.status." + item.status); li.append(time); list.append(li); }
    region.replaceChildren(summary, list);
  }
  function projectedStatusLabel(id) {
    if (!enabled) return undefined;
    const workers = rows("worker");
    if (id === "status") return text("conductor") + " " + rows("conductor").length;
    if (id === "agents") {
      const active = workers.filter(item => ["dispatched", "running", "cancel-requested"].includes(item.status));
      const domains = new Map(); for (const item of active) { const supplied = areaName(item) || areaName(request(item.requestId)) || item.domain || request(item.requestId)?.intent?.domain || request(item.requestId)?.intent?.spec?.domain; const domain = typeof supplied === "string" && supplied ? supplied : text("domain"); domains.set(domain, (domains.get(domain) || 0) + 1); }
      return text("workers") + " " + active.length + (domains.size ? " (" + [...domains].map(([domain, count]) => domain + " " + count).join(", ") + ")" : "");
    }
    if (id === "queue") {
      const waits = workers.filter(item => item.waitReason || pendingWorker(item));
      const count = prefix => waits.filter(item => prefix.test(item.waitReason || (pendingWorker(item) ? "question" : ""))).length;
      const relations = state.timeline.filter(event => event.question === "relation" && pendingQuestion(event)).length;
      const human = workers.filter(pendingWorker).length + relations, ownership = count(/^(ownership|resource)/), capacity = count(/^(employment|capacity|concurrency|domain-capacity|project-capacity)/);
      const requestWaits = rows("request").filter(item => item.waitReason);
      const additionalQuestions = rows("question").filter(item => item.state === "pending" && !item.delegation_id);
      const total = waits.length + relations + requestWaits.length + additionalQuestions.length;
      const additionalCapacity = requestWaits.filter(item => /^employment/.test(item.waitReason)).length;
      return text("wait") + " " + total + " (" + text("human") + " " + (human + additionalQuestions.length) + " · " + text("ownership") + " " + ownership + " · " + text("capacity") + " " + (capacity + additionalCapacity) + " · " + text("other") + " " + (total - human - additionalQuestions.length - ownership - capacity - additionalCapacity) + ") · " + text("decisions") + " " + decisionCount();
    }
    if (id === "context") {
      const owner = conductor(request(view.target)?.conductorId);
      const usage = owner?.usage;
      return text("context") + " · " + (usage?.usedTokens >= 0 && usage?.contextWindowTokens > 0 ? Math.max(0, 100 - usage.usedTokens / usage.contextWindowTokens * 100).toFixed(1) + "%" : text("unavailable"));
    }
    return undefined;
  }
  function openSessions() {
    const dialog = document.getElementById("conductor-sessions"); const list = dialog.querySelector("ul"); list.replaceChildren();
    for (const item of rows("conductor")) {
      const li = document.createElement("li"); const usage = item.usage;
      const area = areaName(item) || [item.domain, item.subdomain].filter(value => typeof value === "string" && value).join(" / ");
      li.textContent = [text("area") + " · " + (area || text("unavailable")), host.t("conductorQueue.conductor", item.ordinal) + " · " + item.id,
        text("slot") + " · " + (item.slot || text("unavailable")), text("epoch") + " " + item.epoch,
        usage?.usedTokens >= 0 && usage?.contextWindowTokens > 0 ? usage.usedTokens + " / " + usage.contextWindowTokens : text("unavailable")].join(" · "); list.append(li);
    }
    dialog.querySelector("h3").textContent = text("sessions"); dialog.querySelector("button").textContent = text("close");
    if (!dialog.open) dialog.showModal();
  }
  function render() { renderControls(); renderWaiting(); }
  function roleLabel(role) { return enabled ? role === "main" ? text("model") : role === "work" ? text("performer") : undefined : undefined; }
  function canAnswerChoice(event) {
    if (!enabled) return undefined;
    const source = displayEvents.get(event.id) || state.timeline.find(item => item.id === event.id);
    const id = source && taskId(source);
    if (!id || source.type !== "conductor") return undefined;
    if (canonicalQuestion(source)) return targeting && pendingQuestion(source) && !answerSubmissions.has("question:" + canonicalQuestion(source).id);
    if (!targeting || !request(id) || source.choiceAnswer || event.choiceAnswer || terminal.has(request(id)?.status) || !state.runtimeAvailable) return false;
    const position = state.timeline.indexOf(source);
    return !state.timeline.slice(position + 1).some(item => taskId(item) === id && (item.type === "user" || item.type === "conductor" && ["question", "reply"].includes(item.kind))) &&
      !state.pendingRequests.some(item => item.conductorTarget?.requestId === id);
  }
  const filters = document.getElementById("conductor-filters");
  ["all", "tasks", "decisions"].forEach(filter => filters.append(button(text(filter), () => { view.filter = filter; if (filter === "all") view.target = ""; persist(false); renderAll(); })));
  document.getElementById("conductor-target").addEventListener("change", event => selectTarget(event.target.value));
  timeline.addEventListener("click", event => {
    if (!enabled || !event.target.closest(".interview-choice")) return;
    const message = event.target.closest(".message[data-task-id]");
    const source = displayEvents.get(message?.dataset.id);
    if (source && canonicalQuestion(source)?.kind === "conductor") {
      event.preventDefault(); event.stopImmediatePropagation();
      sendConductorAnswer(source, event.target.closest(".interview-choice").dataset.answerValue, event.target.closest(".interview-choice")); return;
    }
    if (message?.dataset.taskId) { view.target = message.dataset.taskId; persist(false); renderControls(); }
  }, true);
  document.getElementById("conductor-sessions").querySelector("button").addEventListener("click", () => document.getElementById("conductor-sessions").close());
  return { receive, render, events, key, prepareTimeline, finishTimeline, renderEntry, submissionTarget, submissionError, statusLabel: projectedStatusLabel, openSessions, roleLabel, canAnswerChoice, get enabled() { return enabled; } };
};
