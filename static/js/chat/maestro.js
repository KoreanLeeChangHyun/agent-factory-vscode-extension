globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
// Display is a projection of recorded state. Opening a view never drives a loop.
globalThis.AgentFactoryChat.maestroStatus = function (entry, task) {
  const run = task.runs?.find(value => value.role === "work");
  if (entry.status === "completed" || task.workStatus === "completed") {
    // A verification that was not requested (or skipped) keeps its initial "pending" record; it is not running.
    const verificationRequested = !["not-requested", "human-skipped"].includes(task.verificationDisposition);
    // Work ended and its requested Verification has not decided yet: the task is under check, not running work.
    if (verificationRequested && ["running", "pending"].includes(task.verificationStatus)) return "verifying";
    if (task.verificationStatus === "failed") return "failed";
    return run?.receipt?.outcome === "completed" ? "completed" : "unknown";
  }
  // A task cancelled by a later loop no longer waits for the decision its earlier run recorded.
  if (task.workStatus === "cancelled") return "cancelled";
  if (entry.status === "needs-human-decision" || run?.status === "needs-human-decision") return "decision";
  if (["failed", "runtime-error"].includes(entry.status) || run?.status === "failed") return "failed";
  if (entry.status === "cancelled" || run?.status === "cancelled") return "cancelled";
  if (task.workStatus === "blocked") return "blocked";
  if (task.workStatus === "verifying") return "verifying";
  if (task.workStatus === "running" || run?.status === "running") return "running";
  if (["pending", "queued"].includes(task.workStatus)) {
    if ([...(task.allocation?.dependencies || []), ...(task.allocation?.sharedResources || [])].some(value => value.confirmed === false)) return "blocked";
    return "waiting";
  }
  return "unknown";
};
// Worker relationships are keyed by recorded agent IDs, never by model or task title.
// A brief without domain metadata records no domain name; the worker's membership is the domain list's.
globalThis.AgentFactoryChat.maestroWorkers = function (entries) {
  return entries.flatMap(entry => entry.tasks.flatMap(task => {
    const agents = new Set([task.workAgentId, task.verificationAgentId,
      ...(task.runs || []).map(run => run.agentId)].filter(Boolean));
    return [...agents].map(agentId => ({ entry, task, agentId,
      domain: typeof task.domain === "string" && task.domain.trim() ? task.domain : "",
      runs: (task.runs || []).filter(run => run.agentId === agentId) }));
  }));
};
// Display domain of a worker's task. The editable project list wins: a worker the Human or Main placed shows under that
// domain. Otherwise the name Main recorded in the accepted allocation is used, matched to the list by current or former
// name so a renamed domain keeps its tasks; an unmatched recorded name is shown as-is. Nothing is inferred.
globalThis.AgentFactoryChat.maestroDomain = function (registry, agentId, task) {
  const domains = registry?.domains || [];
  const membership = agentId ? registry?.assignments?.[agentId] : undefined;
  if (membership) {
    const placed = domains.find(domain => domain.id === membership.domainId);
    return placed ? { key: placed.id, name: placed.name, domainId: placed.id, basis: "membership", setBy: membership.setBy }
      : { key: "", name: "", basis: "membership", setBy: membership.setBy };
  }
  const recorded = typeof task?.domain === "string" ? task.domain.trim() : "";
  if (!recorded) return { key: "", name: "", basis: "none" };
  const fold = value => value.split(/\s+/).filter(Boolean).join(" ").toLocaleLowerCase();
  // A provisional "new domain" keeps its placeholder name until renamed and never matches by name.
  const linked = domains.find(domain => !domain.provisional && [domain.name, ...(domain.aliases || [])].some(name => fold(name) === fold(recorded)));
  return linked ? { key: linked.id, name: linked.name, domainId: linked.id, basis: "allocation", recorded }
    : { key: "name:" + recorded, name: recorded, basis: "allocation", recorded };
};
// One entry per worker from its assignment rows: newest task first, its most urgent open task as the worker's state.
globalThis.AgentFactoryChat.maestroWorkerIndex = function (assignments, registry) {
  const byAgent = new Map();
  for (const value of assignments) byAgent.set(value.agentId, [...(byAgent.get(value.agentId) || []), value]);
  return [...byAgent].map(([agentId, rows]) => {
    rows = rows.slice().sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")));
    const latest = rows[0];
    // The Loops still running for this worker; only these can receive an addition or be force-stopped.
    const active = rows.filter(value => value.entry.status === "active" && value.entry.loopId && value.entry.workAgentId === agentId
      && ["running", "waiting", "blocked", "decision"].includes(value.status));
    // Responsibility shown instead of the agent ID: the work area Main recorded on this worker's newest task, when it
    // names something narrower than the group the worker sits in. Nothing is inferred from IDs, titles or roles.
    const fold = value => String(value || "").split(/\s+/).filter(Boolean).join(" ").toLocaleLowerCase();
    const recorded = rows.find(value => typeof value.task.domain === "string" && value.task.domain.trim())?.task.domain.trim();
    const responsibility = recorded && fold(recorded) !== fold(latest.domainName) ? recorded : "";
    // The model that executed this worker's newest recorded run; a run without one used its provider's default.
    const modelRun = rows.find(value => value.run?.model) || rows.find(value => value.run?.provider);
    // Purpose: the task this worker was first assigned (its oldest assignment) and the reason Main recorded for it.
    const origin = rows.at(-1);
    const reason = origin.task.allocation?.unitReason;
    // Current work is every assignment still open; past work shows only the newest finished one, with its own result.
    // Open tasks needing the Human come first, then running, then waiting; newest first within each.
    const open = ["decision", "blocked", "running", "waiting"];
    const current = rows.filter(value => open.includes(value.status))
      .sort((left, right) => open.indexOf(left.status) - open.indexOf(right.status) || String(right.at || "").localeCompare(String(left.at || "")));
    const ended = rows.find(value => !current.includes(value));
    return { agentId, rows, latest, run: latest.run, status: current[0]?.status || latest.status, latestStatus: latest.status, responsibility, at: latest.at, domain: latest.domain, domainName: latest.domainName,
      model: modelRun?.run.model || "", provider: modelRun?.run.provider || "", origin, purpose: origin.task.title || "", purposeShort: globalThis.AgentFactoryChat.maestroPurpose(origin.task.title), purposeReason: typeof reason === "string" ? reason.trim() : "",
      current, ended, active, removed: Boolean(registry?.removedWorkers?.[agentId]) };
  });
};
// Short assignment purpose from a recorded task title, by rule only: nothing is added, guessed or counted.
// Briefs often open with who asked ("사용자님이 … 승인하셨습니다.") and end as an instruction ("…을 구현하십시오.");
// the list shows the task's own first clause as a headline. The full title stays in the tooltip and the detail.
globalThis.AgentFactoryChat.maestroPurpose = function (title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  // "작업 조율 재시험 A: 독립 계산을 실행하고 …" names a series item; the task name is its object plus the item label
  // ("독립 계산 재시험 A"), so A and B stay distinct. Only applies when the instruction names an object (을/를).
  const series = text.match(/^(?:[^:：]{0,30}?\s)?(\S+\s+[A-Z0-9]{1,3})\s*[:：]\s*(.+)$/);
  if (series) {
    const object = series[2].match(/^([^,.:：]{2,30}?)[을를]\s/);
    if (object) return object[1].trim() + " " + series[1];
  }
  const sentences = text.split(/(?<=[.!?。])\s+/).filter(Boolean);
  const narration = sentence => /^(사용자님|The (user|Human)\b)/.test(sentence) && /(셨|했|였|습)니다[.!]?$|\b(asked|approved|requested)\b/.test(sentence);
  let head = sentences.find(sentence => !narration(sentence)) || sentences[0];
  // A leading "사용자님의 “…”에 따라" names the request, not the task.
  head = head.replace(/^사용자님[^.]{0,120}?(에 따라|대로)[,，]?\s+(?=\S)/, "");
  // First clause of a compound instruction: "…반복 시험하고, …보고하십시오." → "…반복 시험".
  head = head.replace(/^(.{6,}?)(하고|하며|하여|해서),\s.*$/, "$1");
  head = head.replace(/\s*(을|를)?\s*(진행|수행)?(하십시오|해 주십시오|해주십시오|하세요|해 주세요|해주세요|합니다)[.!]?$/, "$1").replace(/[.。]$/, "").trim();
  // A consonant-stem instruction becomes its noun form: "바로잡으십시오" → "바로잡기".
  head = head.replace(/(\S)으십시오$/, "$1기");
  // Headline form: "기반을 구현" → "기반 구현".
  head = head.replace(/(\S{2,})[을를](\s\S+)$/, "$1$2").replace(/[을를]$/, "").trim();
  return head || text;
};
// One-line result from a recorded result summary: its first sentence without markup or the opening address.
// Facts are only shortened, never rewritten; an empty input stays empty so the caller can say nothing was recorded.
globalThis.AgentFactoryChat.maestroResultLine = function (summary) {
  const text = String(summary || "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim()
    .replace(/^(사용자님|Dear user)[,，]\s*/, "").replace(/^사용자님(의)? (요청|변경 요청|지시)(에 따라|대로)[,，]?\s+(?=\S)/, "");
  if (!text) return "";
  const sentences = text.split(/(?<=[.!?。])\s+/).filter(Boolean);
  // A bare acknowledgement ("네.") carries no result; it keeps the next sentence with it.
  return sentences[0].length < 8 && sentences[1] ? sentences[0] + " " + sentences[1] : sentences[0];
};
globalThis.AgentFactoryChat.maestroActivity = function (run) {
  if (!run) return "unknown";
  return ({ "needs-human-decision": "decision", "runtime-error": "failed", queued: "waiting", pending: "waiting" })[run.status]
    || (["running", "completed", "failed", "cancelled", "blocked"].includes(run.status) ? run.status : "unknown");
};
// A run still recorded as waiting for a decision or running cannot outlive its task: once the task's own
// record is terminal (for example cancelled by a later loop), that recorded task state is what the row shows.
globalThis.AgentFactoryChat.maestroAssignment = function (task, run) {
  // Without a run record the task's own recorded state is the only evidence.
  const recordedOnly = { pending: "waiting", queued: "waiting", running: "running", verifying: "running", blocked: "blocked" }[task.workStatus];
  const activity = run ? globalThis.AgentFactoryChat.maestroActivity(run) : recordedOnly || "unknown";
  const recorded = run?.role === "verification" ? task.verificationStatus : task.workStatus;
  const terminal = { completed: "completed", cancelled: "cancelled", failed: "failed" }[recorded];
  return ["decision", "running", "waiting", "blocked"].includes(activity) && terminal ? terminal : activity;
};
// Rows are grouped by what the reader must do next: act, watch, review recent results, or browse history.
globalThis.AgentFactoryChat.maestroSection = function (status, activityAt, now) {
  if (status === "decision" || status === "blocked") return "attention";
  if (status === "running" || status === "verifying" || status === "waiting") return "active";
  const time = Date.parse(activityAt);
  return Number.isFinite(time) && now - time < 86_400_000 ? "recent" : "earlier";
};
// Recorded instants only; an unparsable or missing time stays empty rather than guessed.
globalThis.AgentFactoryChat.maestroRelative = function (value, now, language) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(language === "ko" ? "ko" : "en", { numeric: "auto", style: "narrow" });
  for (const [unit, size] of [["day", 86_400], ["hour", 3_600], ["minute", 60]]) {
    if (Math.abs(seconds) >= size) return unit === "day" && Math.abs(seconds) >= 7 * 86_400
      ? new Date(time).toLocaleDateString(language === "ko" ? "ko" : "en", { month: "short", day: "numeric" })
      : format.format(Math.trunc(seconds / size), unit);
  }
  return format.format(0, "second");
};
// A worker's membership. Every worker belongs to one real (listed, named) domain; anything else needs the Human to pick
// one: no entry, the legacy null ("unclassified") entry, a domain ID no longer listed, or a legacy unnamed domain.
// The name Main recorded on the worker's task is only a suggestion here: it never counts as a membership.
globalThis.AgentFactoryChat.maestroMembership = function (registry, agentId, recorded) {
  const domains = registry?.domains || [];
  const entry = agentId ? registry?.assignments?.[agentId] : undefined;
  const domain = entry && typeof entry.domainId === "string" ? domains.find(item => item.id === entry.domainId) : undefined;
  if (domain && !domain.provisional) return { state: "placed", domainId: domain.id, name: domain.name, setBy: entry.setBy };
  const reason = !entry ? "missing" : entry.domainId === null || entry.domainId === undefined ? "legacy-unclassified" : domain ? "unnamed-domain" : "missing-domain";
  const name = typeof recorded === "string" ? recorded.trim() : "";
  const fold = value => value.split(/\s+/).filter(Boolean).join(" ").toLocaleLowerCase();
  const linked = name && domains.find(item => !item.provisional && [item.name, ...(item.aliases || [])].some(other => fold(other) === fold(name)));
  return { state: "required", reason, ...(domain ? { unnamedDomainId: domain.id } : {}),
    ...(linked ? { suggestion: { domainId: linked.id, name: linked.name } } : name ? { suggestion: { name } } : {}) };
};
// Display order of a group's workers from the Human's saved order, by agent ID only (never by model or title).
// Workers without a saved place (new ones) lead in their usual order; the others follow the saved order.
globalThis.AgentFactoryChat.maestroArrange = function (workers, order) {
  const place = new Map((Array.isArray(order) ? order : []).map((id, index) => [id, index]));
  return [...workers.filter(worker => !place.has(worker.agentId)),
    ...workers.filter(worker => place.has(worker.agentId)).sort((left, right) => place.get(left.agentId) - place.get(right.agentId))];
};
// Saved order after moving one worker before or after another worker of the same group. The group's whole shown order is
// kept so it stays fixed; other saved IDs follow, and IDs of workers no longer recorded are dropped. Nothing moving
// (dropped on itself or into its own place) returns undefined so nothing is saved.
globalThis.AgentFactoryChat.maestroReorder = function (group, order, agentId, targetId, after, known) {
  if (agentId === targetId || !group.includes(agentId) || !group.includes(targetId)) return undefined;
  const ids = group.filter(id => id !== agentId);
  ids.splice(ids.indexOf(targetId) + (after ? 1 : 0), 0, agentId);
  if (ids.every((id, index) => id === group[index])) return undefined;
  const moved = new Set(ids), recorded = known ? new Set(known) : undefined;
  return [...ids, ...(Array.isArray(order) ? order : []).filter(id => !moved.has(id) && (!recorded || recorded.has(id)))];
};
globalThis.AgentFactoryChat.maestro = function (host) {
  "use strict";
  const { state, t, vscode, persist } = host;
  const language = host.language || "en";
  const app = globalThis.AgentFactoryChat;
  const center = document.getElementById("maestro-center");
  const workspace = document.getElementById("maestro-workspace");
  const list = document.getElementById("maestro-tasks");
  const detail = document.getElementById("maestro-detail");
  const scope = document.getElementById("maestro-scope");
  const status = document.getElementById("maestro-status");
  const search = document.getElementById("maestro-search");
  const domain = document.getElementById("maestro-domain");
  const workerView = document.getElementById("maestro-workers-view");
  const taskView = document.getElementById("maestro-tasks-view");
  const workerCount = document.getElementById("maestro-workers-count");
  const domainAdd = document.getElementById("maestro-domain-add");
  // "New domain" asks for the work area's real name first; nothing is created under a placeholder name.
  domainAdd?.addEventListener("click", () => {
    domainEditor = { origin: "create", value: "" }; domainEditError = undefined; renderKey = undefined; render();
    center.querySelector("[data-domain-input=\"create\"]")?.focus();
  });
  // A worker placed into a domain that is created for it: the placement follows once the domain exists.
  let placeAfterCreate;
  // Supervision report: verdicts of unfinished loops, read once per click (operation_records.py supervise --dry-run).
  document.getElementById("maestro-supervision")?.addEventListener("click", requestSupervision);
  const statuses = ["running", "verifying", "waiting", "blocked", "decision", "completed", "failed", "cancelled", "unknown"];
  const sections = ["attention", "active", "recent", "earlier"];
  const PROFILE_ROLES = { work: "expert", workLight: "worker", explore: "explorer", scribe: "scribe" };
  let observedAt, error, notice, loading = true;
  // Domain edits: one at a time; its error stays beside the field that sent it.
  let domainEdit, domainEditError, domainEditor, domainFocus;
  // Worker actions in flight per worker and type; their errors stay on that worker's detail.
  let workerPending = {}, workerNotice = {};
  let dragWorker;
  // Order saves still waiting for the host; until they return, a periodic refresh keeps the order shown on screen.
  let orderPending = 0, orderError;
  const workerOrder = () => Array.isArray(state.workerOrder) ? state.workerOrder : [];
  const commandDrafts = {};
  const reworkDrafts = {};
  // Provider handoff: the open form per worker, its typed reason, and the detected models once read.
  const handoffOpen = {}, handoffDrafts = {};
  let handoffModels, handoffModelsError;
  // Supervision report: read on request only; it is not refreshed by the periodic task list.
  let supervision;
  let renderKey;
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (text, action, className) => {
    const element = node("button", text, className);
    element.type = "button";
    element.addEventListener("click", action);
    return element;
  };
  const icon = path => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("d", path);
    svg.append(shape);
    return svg;
  };
  const absolute = value => {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toLocaleString(language === "ko" ? "ko" : "en") : "";
  };
  function request() {
    loading = true;
    vscode.postMessage({ type: "project.tasks.request" });
    renderKey = undefined; render();
  }
  function showNotice(text) {
    notice = typeof text === "string" ? text : "";
    renderKey = undefined; render();
  }
  document.getElementById("maestro-refresh").addEventListener("click", request);
  function changeView(view) {
    state.centerView = view;
    state.centerFilter = { ...state.centerFilter, status: "", domain: "" };
    renderKey = undefined; render(); persist(false);
  }
  workerView?.addEventListener("click", () => changeView("workers"));
  taskView?.addEventListener("click", () => changeView("tasks"));
  for (const tab of [workerView, taskView]) tab?.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const next = tab === workerView ? taskView : workerView;
    next.click(); next.focus();
  });
  detail.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); returnToList(); }
  });
  // Arrow keys walk the visible rows like a list; Enter/Space keep the native button activation.
  list.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...list.querySelectorAll(".maestro-row:not(.maestro-worker-row), .maestro-worker-model, .maestro-worker-select, .maestro-history-button, .maestro-worker-remove, .maestro-worker-work button, .maestro-card, .maestro-section-toggle")].filter(item => !item.disabled);
    const index = items.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const target = event.key === "Home" ? items[0] : event.key === "End" ? items.at(-1)
      : items[Math.min(items.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
    target?.focus();
  });
  for (const element of [scope, status, search, domain].filter(Boolean)) element.addEventListener("input", function () {
    state.centerFilter = { scope: scope.value, status: status.value, search: search.value, domain: domain?.value || "" };
    renderKey = undefined;
    render();
    persist(false);
  });
  const registry = () => state.projectDomains;
  const editable = () => Boolean(registry()) && !state.domainsError;
  function sendDomainEdit(edit, origin) {
    if (domainEdit || !registry()) return;
    domainEdit = { ...edit, origin };
    domainEditError = undefined;
    vscode.postMessage({ ...edit, revision: registry().revision });
    renderKey = undefined; render();
  }
  function domainResult(message) {
    const origin = domainEdit?.origin;
    domainEdit = undefined;
    domainEditError = message.error ? { origin, text: message.code === "domain_name_taken" ? t("maestro.domainTaken")
      : message.code === "domain_conflict" ? t("maestro.domainConflict") : message.code === "domain_name_reserved" ? t("maestro.domainReserved")
        : message.code === "domain_membership_required" || message.code === "domain_name_required" ? t("maestro.membershipRequiredError")
          : t("maestro.domainFailed", message.error) } : undefined;
    if (!message.error) domainEditor = undefined;
    // A domain created for a worker: place it once the refreshed list (with its revision) shows the new domain.
    if (placeAfterCreate?.origin === origin) {
      if (message.error || !message.domainId) placeAfterCreate = undefined;
      else placeAfterCreate = { ...placeAfterCreate, domainId: message.domainId };
    }
    renderKey = undefined; render();
    if (message.error && origin) center.querySelector("[data-domain-input=\"" + origin + "\"]")?.focus();
  }
  function changeLabel(change) {
    if (!change?.actor) return "";
    return t(change.actor === "human" ? "maestro.domainByHuman" : "maestro.domainByAi") + (change.at ? " · " + app.maestroRelative(change.at, Date.now(), language) : "");
  }
  // Inline name field shared by "new domain" and "rename"; Enter saves, Escape cancels.
  function domainNameEditor(origin, initial, submit) {
    const form = node("form", undefined, "maestro-domain-editor");
    const input = node("input");
    input.type = "text"; input.value = initial; input.maxLength = 80; input.dataset.domainInput = origin;
    input.setAttribute("aria-label", t("maestro.domainName"));
    const save = button(t("maestro.save"), () => {}, "maestro-button is-primary");
    save.type = "submit";
    const cancel = button(t("maestro.cancel"), () => { domainEditor = undefined; domainEditError = undefined; renderKey = undefined; render(); }, "maestro-button");
    form.append(input, save, cancel);
    const busy = domainEdit?.origin === origin;
    input.disabled = save.disabled = busy;
    form.addEventListener("submit", event => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) { domainEditError = { origin, text: t("maestro.domainEmpty") }; renderKey = undefined; render(); center.querySelector("[data-domain-input=\"" + origin + "\"]")?.focus(); return; }
      domainEditor = { ...domainEditor, value: name };
      submit(name);
    });
    input.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel.click(); } });
    input.addEventListener("input", () => { domainEditor = { ...domainEditor, value: input.value }; });
    if (domainEditError?.origin === origin) {
      const problem = node("p", domainEditError.text, "maestro-error maestro-domain-error");
      problem.setAttribute("role", "alert");
      form.append(problem);
    }
    if (busy) form.append(node("p", t("maestro.saving"), "maestro-freshness"));
    return form;
  }
  function receive(message) {
    if (Array.isArray(message.workerOrder) && !orderPending) state.workerOrder = message.workerOrder;
    const pendingPlace = placeAfterCreate;
    if (pendingPlace?.domainId && !domainEdit && registry()?.domains.some(item => item.id === pendingPlace.domainId)) {
      placeAfterCreate = undefined;
      sendDomainEdit({ type: "domain.assign", agentId: pendingPlace.agentId, domainId: pendingPlace.domainId }, pendingPlace.origin);
    }
    loading = false;
    error = message.error;
    observedAt = error ? observedAt : Date.now();
    renderKey = undefined;
    render();
  }
  // Reordering changes only the display order: selection, drafts, runs and domains stay keyed by agent ID.
  function saveWorkerOrder(order, focusId) {
    state.workerOrder = order;
    orderError = undefined;
    orderPending += 1;
    vscode.postMessage({ type: "worker.order", order });
    persist(false);
    renderKey = undefined; render();
    if (focusId) list.querySelector("[data-reorder-worker=\"" + CSS.escape(focusId) + "\"]")?.focus();
  }
  function workerOrderResult(message) {
    orderPending = Math.max(0, orderPending - 1);
    // The last answer is what the host keeps; a failed save shows the kept order with its error.
    if (!orderPending && Array.isArray(message.order)) state.workerOrder = message.order;
    orderError = message.error ? t("maestro.orderFailed", message.error) : undefined;
    persist(false);
    renderKey = undefined; render();
  }
  function clearReorderMarks() {
    for (const target of list.querySelectorAll(".is-reorder-target, .is-drag-source")) {
      target.classList.remove("is-reorder-target", "is-drag-source");
      delete target.dataset.dropPosition;
    }
  }
  function returnToList() {
    state.centerDetailOpen = false;
    renderKey = undefined;
    render();
    persist(false);
    const selected = state.centerSelection;
    const worker = selected?.agentId && list.querySelector("[data-select-worker=\"" + CSS.escape(selected.agentId) + "\"]");
    const candidates = [...list.querySelectorAll("[data-center-task], [data-select-worker]")];
    const row = candidates.find(value => value.dataset.centerTask === selected?.workflowId + "/" + selected?.taskId
      && (!selected?.agentId || !value.dataset.centerAgent || value.dataset.centerAgent === selected.agentId));
    // The worker view returns to the worker even when the task is also listed under it.
    const target = state.centerView === "workers" ? worker || row : row || worker;
    (target || candidates[0] || search).focus();
  }
  function selectWorker(agentId, section) {
    state.centerSelection = { agentId };
    state.centerDetailOpen = true;
    renderKey = undefined;
    render();
    detail.scrollTop = 0;
    const history = section === "history" && detail.querySelector(".maestro-worker-history-block");
    if (history) { history.scrollIntoView({ block: "start" }); history.focus(); } else detail.focus();
    persist(false);
  }
  function select(entry, task, agentId) {
    state.centerSelection = { workflowId: entry.id, taskId: task.id, ...(agentId ? { agentId } : {}) };
    state.centerDetailOpen = true;
    renderKey = undefined;
    render();
    detail.scrollTop = 0;
    detail.focus();
    persist(false);
  }
  function stateLabel(value) {
    if (!value) return t("maestro.unconfirmed");
    return [...statuses, "pending", "queued", "verifying"].includes(value) ? t("maestro.recordedState." + value) : value;
  }
  function verificationLabel(task) {
    return task.verificationDisposition === "not-requested" ? t("maestro.notRequested")
      : task.verificationDisposition === "human-skipped" ? t("maestro.humanSkipped") : stateLabel(task.verificationStatus);
  }
  function integrationSummary(task) {
    return task.integration?.length ? task.integration.map(value => [value.repository, value.phase || t("maestro.unconfirmed"), value.mergeCommit].filter(Boolean).join(" · ")).join("\n") : t("maestro.unconfirmed");
  }
  function resultSummary(run) {
    if (run?.result?.availability === "error") return t("maestro.resultError", run.result.error || t("maestro.unconfirmed"));
    if (run?.result?.availability === "recorded") return run.result.summary || t("maestro.resultEmpty");
    return t("maestro.unrecorded");
  }
  // Only the profile recorded on the run (or Main's accepted allocation) names the role; nothing is inferred from the model.
  function roleOf(run, task, agentId) {
    if (run?.role === "verification" || (!run && agentId && agentId === task.verificationAgentId && agentId !== task.workAgentId)) return "verifier";
    // A run's recorded profile wins; before its run exists, Main's accepted allocation names the assigned profile.
    const profile = run?.workProfile || (run?.role !== "verification" ? task.allocation?.profile?.id : undefined);
    return Object.hasOwn(PROFILE_ROLES, profile || "") ? PROFILE_ROLES[profile] : undefined;
  }
  function roleBadge(run, task, agentId) {
    const role = roleOf(run, task, agentId);
    const badge = node("span", t(role === "verifier" ? "ui.verification" : role ? "flow.role." + role : run ? "flow.role.unavailable" : "flow.role.unassigned"), "maestro-role");
    if (role) badge.dataset.agentRole = role;
    else badge.dataset.unrecorded = "true";
    return badge;
  }
  function stateBadge(value, label = stateLabel(value), title) {
    const badge = node("span", label, "maestro-state");
    badge.dataset.status = value;
    if (title) badge.title = title;
    return badge;
  }
  const activityTime = run => run?.finishedAt || run?.updatedAt || run?.startedAt || run?.acceptedAt;
  const latestRun = runs => [...(runs || [])].sort((left, right) => String(activityTime(left) || "").localeCompare(String(activityTime(right) || ""))).at(-1);
  // A running row shows how long its run has been executing; anything else shows when it last changed.
  function timeLabel(run, fallback) {
    const element = node("span", undefined, "maestro-time");
    const start = Date.parse(run?.startedAt);
    if (run?.status === "running" && Number.isFinite(start)) {
      element.dataset.durationStart = String(start);
    } else {
      const at = activityTime(run) || fallback;
      if (Date.parse(at)) element.dataset.timeAt = at;
    }
    updateTime(element);
    return element;
  }
  function updateTime(element) {
    if (element.dataset.durationStart) {
      const start = Number(element.dataset.durationStart);
      const seconds = Math.max(0, Date.now() - start) / 1000;
      element.textContent = seconds < 60 ? t("duration.seconds", Math.floor(seconds))
        : seconds < 3600 ? t("flow.duration.minutes", Math.floor(seconds / 60)) : t("flow.duration.hours", Math.round(seconds / 360) / 10);
      element.title = t("flow.duration.elapsed", Math.floor(seconds), absolute(new Date(start).toISOString()));
    } else if (element.dataset.timeAt) {
      element.textContent = app.maestroRelative(element.dataset.timeAt, Date.now(), language);
      element.title = absolute(element.dataset.timeAt);
    } else {
      element.textContent = "—";
      element.title = t("maestro.unrecorded");
    }
  }
  const clock = setInterval(() => {
    if (!document.hidden) for (const element of center.querySelectorAll(".maestro-time")) updateTime(element);
  }, 30_000);
  clock.unref?.();
  function disclosure(key, label, defaultOpen = true) {
    const section = node("details", undefined, "maestro-group");
    section.open = state.centerCollapsed?.[key] === undefined ? defaultOpen : !state.centerCollapsed[key];
    const summary = node("summary"); summary.dataset.centerGroup = key;
    summary.append(icon("M6 3l5 5-5 5"), node("span", label));
    section.append(summary);
    section.addEventListener("toggle", () => {
      if (!section.isConnected) return;
      const collapsed = !section.open;
      if (Boolean(state.centerCollapsed?.[key]) === collapsed) return;
      state.centerCollapsed = { ...state.centerCollapsed, [key]: collapsed }; persist(false);
    });
    return section;
  }
  function field(container, label, value, className) {
    const term = node("dt", label);
    const description = node("dd", value === undefined || value === null || value === "" ? t("maestro.unrecorded") : String(value), className);
    container.append(term, description);
    return description;
  }
  function block(title, ...children) {
    const section = node("section", undefined, "maestro-block");
    section.append(node("h3", title), ...children);
    detail.append(section);
    return section;
  }
  function openMessage(entry, task, target, run) {
    vscode.postMessage({ type: "project.task.open", workflowId: entry.id, taskId: task.id, target,
      ...(run ? { agentId: run.agentId, runId: run.runId } : {}) });
  }
  function runBlock(entry, task, run, workers, heading = !workers) {
    const section = node("section", undefined, "maestro-run");
    // A single run in the worker view is already described by the detail header.
    if (heading) {
      const row = node("div", undefined, "maestro-run-heading");
      row.append(roleBadge(run, task), node("span", run.model || t("flow.model.unavailable"), "maestro-model"), stateBadge(app.maestroActivity(run)), timeLabel(run));
      section.append(row);
    }
    if (!workers) section.append(node("p", run.agentId, "maestro-identity"));
    const result = node("p", resultSummary(run), "maestro-result");
    if (run.result?.availability === "error") result.dataset.error = "true";
    section.append(node("h4", t("maestro.result")), result);
    const actions = node("div", undefined, "maestro-actions");
    const original = button(t("maestro.resultOriginal"), () => openMessage(entry, task, "result", run), "maestro-button is-primary");
    original.disabled = run.result?.availability !== "recorded";
    actions.append(original, button(t("maestro.run"), () => openMessage(entry, task, "run", run), "maestro-button"));
    section.append(actions);
    const paths = run.receipt?.changedPaths;
    const artifacts = node("ul", undefined, "maestro-paths");
    if (Array.isArray(paths) && paths.length) for (const path of paths) artifacts.append(node("li", path));
    else artifacts.append(node("li", Array.isArray(paths) ? t("maestro.none") : t("maestro.unrecorded"), "is-empty"));
    section.append(node("h4", t("maestro.artifacts")), artifacts);
    if (run.role === "work") {
      section.append(node("h4", t("maestro.checks") + " · " + (run.receipt?.checksRun === true ? t("maestro.checksPerformed")
        : run.receipt?.checksRun === false ? t("maestro.checksNotRun") : t("maestro.unconfirmed"))),
      node("p", run.receipt?.checks || t("maestro.unrecorded"), "maestro-text"));
    } else {
      section.append(node("h4", t("maestro.recordedVerification")), node("p", run.verification
        ? t(run.verification.decision === "pass" ? "maestro.verificationPass" : "maestro.verificationFail") : t("maestro.unconfirmed"), "maestro-text"));
      if (run.verification) {
        section.append(node("h4", t("maestro.verifiedWork")), node("p", run.verification.verifiedWorkRunId, "maestro-identity"));
        for (const finding of run.verification.findings) {
          const item = node("div", undefined, "maestro-finding");
          item.append(node("h4", t("maestro.finding")), node("p", [finding.id, finding.path, finding.location].filter(Boolean).join(" · "), "maestro-identity"),
            node("p", finding.problem, "maestro-text"), node("p", finding.evidence, "maestro-text"), node("p", finding.correction, "maestro-text"));
          section.append(item);
        }
      }
    }
    // Exact identities, instants and accounting stay available without crowding the summary.
    const lines = [t("maestro.runIdentity") + ": " + run.agentId + "/" + run.runId];
    for (const key of ["acceptedAt", "startedAt", "finishedAt", "updatedAt", "attempt", "errorCode"]) lines.push(key + ": " + (run[key] ?? t("maestro.unrecorded")));
    lines.push("receipt: " + (run.receipt?.outcome ?? t("maestro.unconfirmed")));
    lines.push(t("maestro.accounting"));
    for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"]) lines.push(key + ": " + (run.usage?.[key] ?? t("maestro.unrecorded")));
    for (const [label, record] of [["context", run.context], ["handoff", run.handoff]]) lines.push(label + ": " + (record ? JSON.stringify(record) : t("maestro.unrecorded")));
    for (const message of (state.timeline || []).filter(value => value.type === "user" && typeof run.parentRunId === "string" && value.submission?.runId === run.parentRunId)) lines.push("message: " + message.id + " · received: " + (message.submittedAt ?? t("maestro.unrecorded")) + " · accepted: " + (message.submission.acceptedAt ?? t("maestro.unrecorded")));
    const records = disclosure(JSON.stringify(["records", run.agentId, run.runId]), t("maestro.records"), false);
    records.append(node("pre", lines.join("\n")));
    section.append(records);
    return section;
  }
  const commandLog = () => Array.isArray(state.centerCommandLog) ? state.centerCommandLog : [];
  function commandStatusLabel(status) {
    return t({ queued: "maestro.commandQueued", delivered: "maestro.commandDelivered", undelivered: "maestro.commandUndelivered",
      sending: "maestro.commandSending", failed: "maestro.commandNotSent", accepted: "maestro.commandAccepted" }[status] || "maestro.unconfirmed");
  }
  // One command: who sent it, when, to which task/run and its delivery state; the full original stays one click away.
  function commandItem(command, taskTitle) {
    const item = node("li", undefined, "maestro-command");
    item.dataset.status = command.status;
    const meta = node("div", undefined, "maestro-command-meta");
    meta.append(node("span", t({ addition: "maestro.commandAddition", rework: "maestro.commandRework" }[command.kind] || "maestro.commandRequest"), "maestro-command-kind"),
      node("span", t({ human: "maestro.senderHuman", main: "maestro.senderMain", ai: "maestro.senderAi" }[command.sender] || "maestro.senderUnknown")),
      stateBadge({ queued: "waiting", delivered: "completed", undelivered: "cancelled", sending: "running", failed: "failed", accepted: "waiting" }[command.status] || "unknown", commandStatusLabel(command.status)));
    const time = timeLabel(undefined, command.at);
    meta.append(time);
    item.append(meta);
    const target = [taskTitle, command.runId || command.loopId].filter(Boolean).join(" · ");
    if (target) item.append(node("p", target, "maestro-identity"));
    if (command.error) { const problem = node("p", t("maestro.commandFailed", command.error), "maestro-error"); problem.setAttribute("role", "alert"); item.append(problem); }
    // Line breaks are kept; long originals start folded and open to the full text.
    const text = node("pre", command.text, "maestro-command-text");
    if (command.text.length > 280 || command.text.split("\n").length > 4) {
      const fold = node("details", undefined, "maestro-command-fold");
      const summary = node("summary", command.text.split("\n")[0].slice(0, 120) + "…");
      fold.append(summary, text);
      item.append(fold);
    } else item.append(text);
    return item;
  }
  function workerAction(message) {
    workerPending = { ...workerPending, [message.agentId + "/" + message.type]: message };
    vscode.postMessage(message);
    renderKey = undefined; render();
  }
  // The membership menu of one worker: only listed, named domains. A worker still needing one starts on a disabled
  // "choose" entry, so nothing is placed until the Human picks; a recorded but unlisted name can be created and used.
  function membershipSelect(agentId, membership, origin) {
    const select = node("select");
    select.dataset.domainAssign = agentId;
    select.setAttribute("aria-label", t("maestro.domainMembership", agentId));
    if (membership.state !== "placed") {
      const choose = node("option", t("maestro.membershipChoose")); choose.value = ""; choose.disabled = true; select.append(choose);
    }
    const suggested = membership.suggestion?.domainId;
    for (const item of registry().domains.filter(item => !item.provisional).sort((left, right) => left.name.localeCompare(right.name))) {
      const option = node("option", item.id === suggested ? t("maestro.membershipRecordedOption", item.name) : item.name);
      option.value = item.id; select.append(option);
    }
    if (membership.suggestion && !suggested) {
      const option = node("option", t("maestro.membershipCreate", membership.suggestion.name));
      option.value = "create:" + membership.suggestion.name; select.append(option);
    }
    select.value = membership.state === "placed" ? membership.domainId : "";
    select.disabled = Boolean(domainEdit) || Boolean(placeAfterCreate);
    select.addEventListener("change", () => {
      if (!select.value) return;
      if (select.value.startsWith("create:")) {
        placeAfterCreate = { agentId, origin };
        sendDomainEdit({ type: "domain.create", name: select.value.slice(7) }, origin);
      } else sendDomainEdit({ type: "domain.assign", agentId, domainId: select.value }, origin);
    });
    const wrap = node("span", undefined, "maestro-select");
    wrap.append(select, icon("M4 6l4 4 4-4"));
    return wrap;
  }
  const recordedDomain = rows => rows.map(value => value.task?.domain).find(value => typeof value === "string" && value.trim()) || "";
  function membershipNote(membership) {
    if (membership.state === "placed") return "";
    return t("maestro.membershipReason." + membership.reason) + (membership.suggestion ? " · " + t("maestro.domainRecorded", membership.suggestion.name) : "");
  }
  function renderWorkerDetail(worker, removed) {
    detail.replaceChildren();
    delete detail.dataset.workflowId; delete detail.dataset.taskId;
    detail.dataset.workerId = worker.agentId;
    const pending = type => workerPending[worker.agentId + "/" + type];
    const header = node("header", undefined, "maestro-detail-header");
    const back = button("", returnToList, "maestro-icon-button maestro-close");
    back.setAttribute("aria-label", t("maestro.returnList")); back.title = t("maestro.returnList");
    back.append(icon("M4 4l8 8M12 4l-8 8"));
    const titleRow = node("div", undefined, "maestro-detail-title");
    titleRow.append(node("h2", workerName(worker), worker.model ? "" : "is-unset"), back);
    const purpose = node("p", undefined, "maestro-worker-purpose-line");
    purpose.append(node("span", t("maestro.assignedFor"), "maestro-worker-kind"));
    if (worker.responsibility) purpose.append(node("span", worker.responsibility, "maestro-worker-area"));
    purpose.append(node("span", worker.purpose || t("maestro.purposeUnset"), worker.purpose ? "" : "is-empty"));
    if (worker.purposeReason) purpose.title = t("maestro.purposeReason", worker.purposeReason);
    const meta = node("div", undefined, "maestro-detail-meta");
    meta.append(roleBadge(worker.run, worker.latest.task, worker.agentId), node("span", worker.run?.model || t("flow.model.unavailable"), "maestro-model"),
      stateBadge(worker.status), timeLabel(worker.run, worker.at));
    header.append(titleRow, purpose, node("p", t("maestro.agentIdentity", worker.agentId), "maestro-identity maestro-worker-id"), meta);
    detail.append(header);
    if (removed[worker.agentId]) detail.append(node("p", t("maestro.removedWorker"), "maestro-freshness"));
    // Domain membership and the two lifecycle actions; removal waits until nothing runs.
    const facts = node("dl", undefined, "maestro-facts");
    const membership = registry() ? app.maestroMembership(registry(), worker.agentId, recordedDomain(worker.rows)) : undefined;
    const resolved = app.maestroDomain(registry(), worker.agentId, worker.latest.task);
    const domainField = field(facts, t("maestro.domain"), membership ? membership.name || t("maestro.membershipRequired") : resolved.name || t("maestro.membershipUnknown"));
    domainField.classList.add("maestro-domain-field");
    if (membership && editable()) {
      domainField.replaceChildren(membershipSelect(worker.agentId, membership, "assign"));
      if (domainEditError?.origin === "assign") { const problem = node("span", domainEditError.text, "maestro-error"); problem.setAttribute("role", "alert"); domainField.append(problem); }
    }
    if (membership?.state === "placed") {
      if (changeLabel(membership.setBy)) domainField.append(node("span", changeLabel(membership.setBy), "maestro-domain-basis"));
      if (worker.latest.task.domain) domainField.append(node("span", t("maestro.domainRecorded", worker.latest.task.domain), "maestro-domain-basis"));
    } else if (membership) domainField.append(node("span", membershipNote(membership), "maestro-domain-basis maestro-membership-note"));
    else if (resolved.basis === "allocation") domainField.append(node("span", t("maestro.domainRecorded", resolved.recorded), "maestro-domain-basis"));
    detail.append(facts);
    const actions = node("div", undefined, "maestro-actions");
    const removing = pending("worker.remove");
    const remove = button(t(removing ? "maestro.removing" : "maestro.removeWorker"), () => workerAction({ type: "worker.remove", agentId: worker.agentId, revision: registry().revision }), "maestro-button maestro-danger");
    remove.disabled = Boolean(removing) || worker.active.length > 0 || !editable() || Boolean(removed[worker.agentId]);
    if (worker.active.length) remove.title = t("maestro.removeBlocked");
    actions.append(remove);
    // Provider handoff: only a loop of this worker that has not ended can move to a new session.
    const movable = [...new Map(worker.rows.filter(value => value.entry.loopId && value.entry.workAgentId
      && !["completed", "cancelled"].includes(value.entry.status) && (value.task.workAgentId || value.entry.workAgentId) === worker.agentId)
      .map(value => [value.entry.loopId, value])).values()];
    const handing = pending("worker.handoff") || movable.map(value => workerPending[value.entry.workAgentId + "/worker.handoff"]).find(Boolean);
    const handoff = button(t(handing ? "maestro.handoffing" : "maestro.providerSwitch"), () => {
      handoffOpen[worker.agentId] = !handoffOpen[worker.agentId];
      if (handoffOpen[worker.agentId] && !handoffModels) vscode.postMessage({ type: "handoff.models.request" });
      renderKey = undefined; render();
      detail.querySelector("#maestro-handoff-model")?.focus();
    }, "maestro-button");
    handoff.dataset.handoffWorker = worker.agentId;
    handoff.setAttribute("aria-expanded", String(Boolean(handoffOpen[worker.agentId])));
    handoff.disabled = Boolean(handing) || !movable.length || Boolean(removed[worker.agentId]);
    if (!movable.length) handoff.title = t("maestro.handoffNone");
    actions.append(handoff);
    detail.append(actions);
    if (handoffOpen[worker.agentId] && movable.length) detail.append(handoffForm(worker, movable, Boolean(handing)));
    if (workerNotice[worker.agentId]) { const notice = node("p", workerNotice[worker.agentId], "maestro-error maestro-worker-notice"); notice.setAttribute("role", "alert"); detail.append(notice); }
    if (worker.active.length) detail.append(node("p", t("maestro.removeBlocked"), "maestro-freshness"));
    // Instruction to the worker: added to its running task, or a new task in the same session when it is idle.
    const running = worker.active.length === 1 ? worker.active[0] : undefined;
    const form = node("form", undefined, "maestro-command-form");
    const label = node("label", t("maestro.commandTitle"), "maestro-command-label");
    const input = node("textarea");
    input.id = "maestro-command-input"; label.htmlFor = input.id;
    input.rows = 3; input.maxLength = 20000; input.placeholder = t("maestro.commandPlaceholder");
    input.value = commandDrafts[worker.agentId] || "";
    input.addEventListener("input", () => { commandDrafts[worker.agentId] = input.value; });
    const sending = pending("worker.command");
    const send = button(t(sending ? "maestro.commandSending" : "maestro.commandSend"), () => {}, "maestro-button is-primary");
    send.type = "submit";
    input.disabled = send.disabled = Boolean(sending) || worker.active.length > 1 || Boolean(removed[worker.agentId]);
    const target = node("p", running ? t("maestro.commandToRunning", running.task.title || running.task.id) : t("maestro.commandToIdle"), "maestro-freshness maestro-command-target");
    form.append(label, input, target, send);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const text = input.value;
      if (!text.trim() || pending("worker.command")) return;
      const commandId = (globalThis.crypto?.randomUUID?.() || String(Date.now()) + "-" + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
      state.centerCommandLog = [...commandLog(), { commandId, agentId: worker.agentId, text, at: new Date().toISOString(), status: "sending", kind: running ? "addition" : "request", sender: "human",
        ...(running ? { taskTitle: running.task.title } : {}) }].slice(-100);
      persist(false);
      workerAction({ type: "worker.command", agentId: worker.agentId, text, commandId,
        ...(running ? { loopId: running.entry.loopId, ...(running.entry.latestWorkRunId ? { runId: running.entry.latestWorkRunId } : {}) } : {}) });
    });
    detail.append(form);
    // Running tasks first, each with its own force stop; then the full history, newest first.
    if (worker.active.length) {
      const section = node("section", undefined, "maestro-block");
      section.append(node("h3", t("maestro.runningNow")));
      for (const value of worker.active) {
        const row = node("div", undefined, "maestro-running-task");
        row.append(workerTaskButton(worker, value));
        const stopping = pending("worker.stop");
        const stop = button(t(stopping ? "maestro.stopping" : "maestro.forceStop"), () => workerAction({ type: "worker.stop", agentId: worker.agentId,
          loopId: value.entry.loopId, workflowId: value.entry.id, taskId: value.task.id }), "maestro-button maestro-danger");
        stop.disabled = Boolean(stopping);
        stop.dataset.stopLoop = value.entry.loopId;
        row.append(stop);
        section.append(row);
      }
      detail.append(section);
    }
    const history = node("section", undefined, "maestro-block maestro-worker-history-block");
    history.tabIndex = -1;
    history.append(node("h3", t("maestro.workerTasks")));
    const tasks = node("div", undefined, "maestro-links maestro-worker-tasks");
    // Running tasks are listed once, above; the history holds the rest, newest first.
    // Each entry: the task (time and state) and that exact run's work request and report.
    for (const value of worker.rows.filter(row => !worker.active.includes(row))) {
      const entry = node("div", undefined, "maestro-worker-history-item");
      entry.append(workerTaskButton(worker, value), workerDocuments(worker, value, value.task.runs?.find(run => run.agentId === worker.agentId && run.runId === value.run?.runId) || value.run));
      tasks.append(entry);
    }
    if (!tasks.children.length) tasks.append(node("p", t("maestro.noWorkerTasks"), "maestro-text"));
    history.append(tasks);
    detail.append(history);
    // Commands from managed records (newest first), with this screen's own unsent or not-yet-recorded sends.
    const recorded = worker.rows.flatMap(value => (value.task.commands || []).map(command => ({ ...command, taskTitle: value.task.title || value.task.id })));
    const local = commandLog().filter(item => item.agentId === worker.agentId && !recorded.some(command => command.sender === "human" && (command.text === item.text || (item.kind === "rework" && command.text.endsWith("\n" + item.text)))));
    const commands = node("section", undefined, "maestro-block");
    commands.append(node("h3", t("maestro.commands")));
    const items = node("ul", undefined, "maestro-commands");
    for (const command of [...local, ...recorded].sort((left, right) => String(right.at || "").localeCompare(String(left.at || "")))) items.append(commandItem(command, command.taskTitle));
    if (!items.children.length) items.append(node("li", t("maestro.none"), "maestro-text"));
    commands.append(items);
    detail.append(commands);
    const moves = handoffRecords(worker.agentId);
    if (moves) detail.append(moves);
  }
  // Handoff form: the task (when several can move), a detected model other than the current one, and the reason.
  function handoffForm(worker, movable, busy) {
    const form = node("form", undefined, "maestro-command-form maestro-handoff-form");
    form.append(node("h4", t("maestro.handoffTitle")));
    const choice = (id, label, options, value) => {
      const field = node("label", label, "maestro-command-label");
      const select = node("select");
      select.id = id; field.htmlFor = id;
      for (const [optionValue, text] of options) { const option = node("option", text); option.value = optionValue; select.append(option); }
      if (value !== undefined) select.value = value;
      const wrap = node("span", undefined, "maestro-select");
      wrap.append(select, icon("M4 6l4 4 4-4"));
      form.append(field, wrap);
      return select;
    };
    const draft = handoffDrafts[worker.agentId] || {};
    const loop = choice("maestro-handoff-task", t("maestro.handoffTask"), movable.map(value => [value.entry.loopId, (value.task.title || value.task.id) + " · " + stateLabel(value.status)]), draft.loopId);
    const models = (handoffModels || []).filter(model => model.id !== worker.model);
    const model = choice("maestro-handoff-model", t("maestro.handoffModel"),
      models.length ? models.map(item => [item.id, item.id + " · " + item.provider]) : [["", t(handoffModels ? "maestro.handoffNoModels" : "maestro.handoffModelsLoading")]], draft.model);
    const reasonLabel = node("label", t("maestro.handoffReason"), "maestro-command-label");
    const reason = node("textarea");
    reason.id = "maestro-handoff-reason"; reasonLabel.htmlFor = reason.id;
    reason.rows = 2; reason.maxLength = 2000; reason.placeholder = t("maestro.handoffReasonPlaceholder");
    reason.value = draft.reason || "";
    const keep = () => { handoffDrafts[worker.agentId] = { loopId: loop.value, model: model.value, reason: reason.value }; };
    for (const element of [loop, model, reason]) element.addEventListener("input", keep);
    const send = button(t(busy ? "maestro.handoffing" : "maestro.handoffSend"), () => {}, "maestro-button is-primary");
    send.type = "submit";
    loop.disabled = model.disabled = reason.disabled = send.disabled = busy || !models.length;
    form.append(reasonLabel, reason);
    if (handoffModelsError) { const problem = node("p", t("maestro.handoffModelsFailed", handoffModelsError), "maestro-error"); problem.setAttribute("role", "alert"); form.append(problem); }
    form.append(node("p", t("maestro.handoffNote"), "maestro-freshness maestro-command-target"), send);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const target = movable.find(value => value.entry.loopId === loop.value);
      if (!target || !model.value || !reason.value.trim() || send.disabled) { if (!reason.value.trim()) reason.focus(); return; }
      keep();
      workerAction({ type: "worker.handoff", agentId: target.entry.workAgentId, loopId: target.entry.loopId, toModel: model.value, reason: reason.value.trim() });
    });
    return form;
  }
  // Recorded handoffs from or to this worker, newest first: models, providers, the new session, reason and time.
  function handoffRecords(agentId) {
    const records = (state.projectTasks || []).flatMap(entry => (entry.handoffs || []).map(record => ({ ...record, entry })))
      .filter(record => record.fromAgentId === agentId || record.toAgentId === agentId)
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
    if (!records.length) return undefined;
    const section = node("section", undefined, "maestro-block maestro-handoffs");
    section.append(node("h3", t("maestro.handoffs")));
    const items = node("ul", undefined, "maestro-commands");
    for (const record of records) {
      const item = node("li", undefined, "maestro-command");
      item.dataset.handoffId = record.id;
      const meta = node("div", undefined, "maestro-command-meta");
      meta.append(node("span", t(record.fromAgentId === agentId ? "maestro.handoffOut" : "maestro.handoffIn"), "maestro-command-kind"),
        node("span", t(record.actor === "human" ? "maestro.senderHuman" : record.actor === "main" ? "maestro.senderMain" : "maestro.senderUnknown")),
        timeLabel(undefined, record.createdAt));
      const task = record.entry.tasks?.find(value => value.id === record.taskId);
      item.append(meta,
        node("p", t("maestro.handoffLine", [record.fromModel || t("maestro.modelUnrecorded"), record.fromProvider].filter(Boolean).join(" · "),
          [record.toModel || t("maestro.modelUnrecorded"), record.toProvider].filter(Boolean).join(" · ")), "maestro-text"),
        node("p", [task?.title || record.taskId, record.fromAgentId + " → " + record.toAgentId].filter(Boolean).join(" · "), "maestro-identity"));
      if (record.reason) item.append(node("pre", record.reason, "maestro-command-text"));
      items.append(item);
    }
    section.append(items);
    return section;
  }
  function workerTaskButton(worker, value) {
    const item = button("", () => select(value.entry, value.task, worker.agentId), "maestro-worker-task");
    item.dataset.centerTask = value.entry.id + "/" + value.task.id;
    item.dataset.centerAgent = worker.agentId;
    item.append(node("span", value.task.title || value.task.id, "maestro-worker-task-title"), stateBadge(value.status), timeLabel(value.run, value.at));
    item.setAttribute("aria-label", [t("maestro.openTask"), value.task.title, stateLabel(value.status)].join(" · "));
    return item;
  }
  function workerResult(message) {
    const key = message.agentId + "/" + message.action;
    const sent = workerPending[key];
    workerPending = Object.fromEntries(Object.entries(workerPending).filter(([name]) => name !== key));
    workerNotice = { ...workerNotice, [message.agentId]: message.error && message.action !== "worker.command" ? t("maestro.workerActionFailed", message.error) : undefined };
    if (message.action === "worker.command") {
      state.centerCommandLog = commandLog().map(item => item.commandId !== message.commandId ? item
        : message.error ? { ...item, status: "failed", error: message.error } : { ...item, status: "accepted", ...(message.result?.runId ? { runId: message.result.runId } : {}), ...(message.result?.loopId ? { loopId: message.result.loopId } : {}) });
      if (!message.error) {
        // Only the field that sent the instruction is cleared.
        const command = commandLog().find(item => item.commandId === message.commandId);
        if (command?.kind === "rework") reworkDrafts[command.workflowId + "/" + command.taskId] = "";
        else commandDrafts[message.agentId] = "";
      }
      persist(false);
    }
    if (message.action === "worker.remove" && !message.error && !message.cancelled && state.centerSelection?.agentId === message.agentId) state.centerDetailOpen = false;
    // A completed handoff closes its form; the recorded handoff arrives with the next task refresh.
    if (message.action === "worker.handoff" && !message.error && !message.cancelled) {
      for (const agentId of Object.keys(handoffOpen)) if (handoffDrafts[agentId]?.loopId === sent?.loopId || agentId === message.agentId) { handoffOpen[agentId] = false; handoffDrafts[agentId] = undefined; }
    }
    renderKey = undefined; render();
    return sent;
  }
  // Card summary: what was asked, how far it got and what came back, shortened from recorded fields only.
  function taskSummary(task) {
    const work = latestRun((task.runs || []).filter(value => value.role === "work"));
    const facts = node("dl", undefined, "maestro-facts maestro-summary");
    const request = String(task.description || "").split("\n").map(line => line.replace(/^#+\s*/, "").trim()).find(Boolean) || task.title;
    const requestField = field(facts, t("maestro.summaryRequest"), request && request.length > 240 ? request.slice(0, 239) + "…" : request);
    if (task.description) requestField.title = task.description.slice(0, 2000);
    const progress = field(facts, t("maestro.summaryProgress"), t("maestro.summaryProgressLine", stateLabel(task.workStatus), verificationLabel(task)));
    if (work) progress.append(" · ", timeLabel(work));
    const line = work?.result?.availability === "recorded" ? app.maestroResultLine(work.result.summary) : "";
    const result = field(facts, t("maestro.summaryResult"), line || (work ? resultSummary(work) : t("maestro.executionMissing")));
    if (work?.result?.availability === "error") result.classList.add("maestro-error");
    return facts;
  }
  // Rework of an ended task: a new task in the same worker's session, linked to this one. The host refuses it while the
  // worker runs something else, so a rework never lands in another task as an addition.
  function reworkBlock(entry, task, taskStatus) {
    if (!["completed", "failed", "cancelled"].includes(taskStatus)) return undefined;
    const agentId = task.workAgentId || task.runs?.find(value => value.role === "work")?.agentId;
    const key = entry.id + "/" + task.id;
    const section = node("section", undefined, "maestro-block maestro-rework");
    section.dataset.reworkTask = key;
    const form = node("form", undefined, "maestro-command-form");
    const label = node("label", t("maestro.reworkTitle"), "maestro-command-label");
    const input = node("textarea");
    input.id = "maestro-rework-input"; label.htmlFor = input.id;
    input.rows = 3; input.maxLength = 20000; input.placeholder = t("maestro.reworkPlaceholder");
    input.value = reworkDrafts[key] || "";
    input.addEventListener("input", () => { reworkDrafts[key] = input.value; });
    const busy = Boolean(agentId) && (state.projectTasks || []).some(value => value.status === "active" && value.workAgentId === agentId);
    const sending = agentId && workerPending[agentId + "/worker.command"];
    const send = button(t(sending ? "maestro.commandSending" : "maestro.reworkSend"), () => {}, "maestro-button is-primary");
    send.type = "submit";
    input.disabled = send.disabled = !agentId || busy || Boolean(sending) || Boolean(registry()?.removedWorkers?.[agentId]);
    const target = node("p", !agentId ? t("maestro.reworkNoWorker") : busy ? t("maestro.reworkBusy") : t("maestro.reworkTarget", agentId), "maestro-freshness maestro-command-target");
    form.append(label, input, target, send);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const text = input.value;
      if (!agentId || !text.trim() || send.disabled) return;
      const commandId = (globalThis.crypto?.randomUUID?.() || String(Date.now()) + "-" + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
      state.centerCommandLog = [...commandLog(), { commandId, agentId, text, at: new Date().toISOString(), status: "sending", kind: "rework", sender: "human",
        taskTitle: task.title || task.id, workflowId: entry.id, taskId: task.id }].slice(-100);
      persist(false);
      workerAction({ type: "worker.command", agentId, text, commandId, rework: { workflowId: entry.id, taskId: task.id } });
    });
    section.append(form);
    // This screen's rework instructions for the task, newest first, with their delivery state and the new task they started.
    const sent = commandLog().filter(item => item.kind === "rework" && item.workflowId === entry.id && item.taskId === task.id).reverse();
    if (sent.length) {
      const items = node("ul", undefined, "maestro-commands");
      for (const command of sent) items.append(commandItem(command, ""));
      section.append(node("h4", t("maestro.reworkHistory")), items);
    }
    return section;
  }
  function renderDetail(entry, task, assignments) {
    detail.replaceChildren();
    delete detail.dataset.workerId;
    delete detail.dataset.workflowId; delete detail.dataset.taskId;
    if (!entry || !task) return;
    const workers = state.centerView === "workers";
    const selectedAgent = workers ? state.centerSelection?.agentId : undefined;
    detail.dataset.workflowId = entry.id;
    detail.dataset.taskId = task.id;
    const runs = (task.runs || []).filter(run => !selectedAgent || run.agentId === selectedAgent);
    const run = workers ? latestRun(runs) : runs.find(value => value.role === "work") || runs[0];
    const header = node("header", undefined, "maestro-detail-header");
    const back = button("", returnToList, "maestro-icon-button maestro-close");
    back.setAttribute("aria-label", t("maestro.returnList")); back.title = t("maestro.returnList");
    back.append(icon("M4 4l8 8M12 4l-8 8"));
    const titleRow = node("div", undefined, "maestro-detail-title");
    titleRow.append(node("h2", task.title || task.id), back);
    const meta = node("div", undefined, "maestro-detail-meta");
    const taskStatus = app.maestroStatus(entry, task);
    meta.append(roleBadge(run, task, selectedAgent), node("span", run?.model || t("flow.model.unavailable"), "maestro-model"),
      workers ? stateBadge(app.maestroAssignment(task, run)) : stateBadge(taskStatus, stateLabel(taskStatus), t("maestro.status." + taskStatus)),
      timeLabel(workers ? run : latestRun(task.runs), entry.updatedAt));
    header.append(titleRow, meta);
    detail.append(header);
    const controls = node("div", undefined, "maestro-actions");
    if (workers && selectedAgent) controls.append(button(t("maestro.backToWorker"), () => selectWorker(selectedAgent), "maestro-button"));
    controls.append(button(t(workers ? "maestro.taskDetail" : "maestro.workerDetail"), () => {
      state.centerFilter = {};
      const agentId = workers ? undefined : run?.agentId || task.workAgentId;
      state.centerSelection = { workflowId: entry.id, taskId: task.id, ...(agentId ? { agentId } : {}) };
      changeView(workers ? "tasks" : "workers");
      detail.focus();
    }, "maestro-button"));
    for (const target of ["chat", "records"]) {
      const action = button(t("maestro." + target), () => openMessage(entry, task, target), "maestro-button");
      action.disabled = target === "records" ? !entry.loopId : !entry.mainAgentId;
      controls.append(action);
    }
    controls.append(button(t("maestro.feedback"), () => openMessage(entry, task, "feedback"), "maestro-button"));
    detail.append(controls, taskSummary(task));
    const facts = node("dl", undefined, "maestro-facts");
    if (workers) field(facts, t("maestro.workers"), selectedAgent, "maestro-identity");
    const placedAgent = selectedAgent || run?.agentId || task.workAgentId;
    const membership = placedAgent && registry() ? app.maestroMembership(registry(), placedAgent, task.domain) : undefined;
    const resolved = app.maestroDomain(registry(), placedAgent, task);
    const domainField = field(facts, t("maestro.domain"), membership ? membership.name || t("maestro.membershipRequired") : resolved.name || t("maestro.membershipUnknown"));
    domainField.classList.add("maestro-domain-field");
    // The worker's membership is editable; the accepted allocation name stays as recorded evidence.
    if (membership && editable()) {
      domainField.replaceChildren(membershipSelect(placedAgent, membership, "assign"));
      if (domainEditError?.origin === "assign") { const problem = node("span", domainEditError.text, "maestro-error"); problem.setAttribute("role", "alert"); domainField.append(problem); }
    }
    if (membership?.state === "placed") {
      if (changeLabel(membership.setBy)) domainField.append(node("span", changeLabel(membership.setBy), "maestro-domain-basis"));
      // The accepted allocation keeps Main's name; a changed membership does not rewrite that evidence.
      if (task.domain) domainField.append(node("span", t("maestro.domainRecorded", task.domain), "maestro-domain-basis"));
    } else if (membership) domainField.append(node("span", membershipNote(membership), "maestro-domain-basis maestro-membership-note"));
    else if (resolved.basis === "allocation") domainField.append(node("span", t("maestro.domainRecorded", resolved.recorded), "maestro-domain-basis"));
    field(facts, t("maestro.workState"), stateLabel(task.workStatus));
    field(facts, t("maestro.verificationState"), verificationLabel(task));
    field(facts, t("maestro.integrationState"), integrationSummary(task));
    if (workers) field(facts, t("maestro.activity"), run ? stateLabel(app.maestroActivity(run)) : undefined);
    field(facts, t("maestro.scope"), entry.mainAgentId, "maestro-identity");
    const updated = field(facts, t("maestro.updated"), app.maestroRelative(entry.updatedAt, Date.now(), language));
    updated.title = absolute(entry.updatedAt);
    detail.append(facts);
    if (registry()?.removedWorkers?.[selectedAgent || task.workAgentId]) detail.append(node("p", t("maestro.removedWorker"), "maestro-freshness"));
    if (task.commands?.length) {
      const items = node("ul", undefined, "maestro-commands");
      for (const command of task.commands) items.append(commandItem(command, ""));
      block(t("maestro.commands"), items);
    }
    const rework = reworkBlock(entry, task, taskStatus);
    if (rework) detail.append(rework);
    if (!runs.length) block(t("maestro.result"), node("p", t("maestro.unrecorded"), "maestro-text"));
    for (const value of workers ? runs.slice().reverse() : runs) detail.append(runBlock(entry, task, value, workers, !workers || runs.length > 1));
    const others = workers && selectedAgent ? assignments.filter(value => value.agentId === selectedAgent && !(value.entry.id === entry.id && value.task.id === task.id)) : [];
    if (others.length) {
      const other = node("div", undefined, "maestro-links");
      for (const value of others) other.append(button(value.task.title || value.task.id, () => select(value.entry, value.task, selectedAgent), "maestro-link"));
      block(t("maestro.otherAssignments", others.length), other);
    }
    const description = disclosure(JSON.stringify(["request", entry.id, task.id]), t("maestro.request"), false);
    description.append(node("pre", task.description || t("maestro.unrecorded")));
    const criteria = disclosure(JSON.stringify(["criteria", entry.id, task.id]), t("maestro.success"), false);
    criteria.append(node("pre", task.completionCriteria || t("maestro.unrecorded")));
    detail.append(description, criteria);
    const allocation = task.allocation;
    const assignment = disclosure(JSON.stringify(["allocation", entry.id, task.id]), t("maestro.assignment"), false);
    const allocationFacts = node("dl", undefined, "maestro-facts");
    assignment.append(allocationFacts);
    if (allocation) {
      field(allocationFacts, t("maestro.assignment"), [allocation.profile?.id, allocation.profile?.reason, allocation.session?.strategy, allocation.session?.reason].filter(Boolean).join(" · "));
      field(allocationFacts, t("maestro.boundary"), allocation.writeScopeReason);
      field(allocationFacts, t("maestro.parallel"), allocation.parallelCandidate === true ? t("maestro.candidate") : t("maestro.sequential"));
      const dependencies = node("div", undefined, "maestro-links");
      for (const dependency of allocation.dependencies || []) {
        const label = [dependency.taskId, dependency.source, dependency.revision, dependency.capturedAt, t(dependency.confirmed ? "maestro.confirmed" : "maestro.unconfirmed")].filter(Boolean).join(" · ");
        const predecessor = entry.tasks.find(value => value.id === dependency.taskId);
        dependencies.append(predecessor ? button(label, () => select(entry, predecessor, workers ? predecessor.workAgentId : undefined), "maestro-link") : node("p", label, "maestro-text"));
      }
      if (!(allocation.dependencies || []).length) dependencies.append(node("p", t("maestro.none"), "maestro-text"));
      assignment.append(node("h4", t("maestro.dependencies")), dependencies);
      for (const [key, label] of [["inputs", "maestro.sources"], ["sharedResources", "maestro.ownership"]]) {
        assignment.append(node("h4", t(label)));
        const records = allocation[key] || [];
        if (!records.length) assignment.append(node("p", t("maestro.none"), "maestro-text"));
        for (const record of records) assignment.append(node("p", Object.entries(record).map(([key, value]) => key + ": " + value).join(" · "), "maestro-text"));
      }
    } else field(allocationFacts, t("maestro.assignment"), undefined);
    detail.append(assignment);
    const identity = disclosure(JSON.stringify(["identity", entry.id, task.id]), t("maestro.identity"), false);
    identity.append(node("pre", ["workflow: " + entry.id, "task: " + task.id, "brief: " + (entry.title || t("maestro.unrecorded")),
      "loop: " + (entry.loopId || t("maestro.unrecorded")), "main: " + (entry.mainAgentId || t("maestro.unrecorded")),
      "createdAt: " + (entry.createdAt || t("maestro.unrecorded")), "updatedAt: " + (entry.updatedAt || t("maestro.unrecorded")),
      t("maestro.issues")].join("\n")));
    detail.append(identity);
  }
  // Worker row: identity first, then the latest task's title as its summary, with the worker's most urgent state.
  // One row per worker, four columns: worker | title (its latest task) | that task's state | task history.
  // The row is not a button: it holds two controls, the worker (opens its detail) and the history button.
  function workerRowFor(worker, selected, place) {
    const item = node("div", undefined, "maestro-row maestro-worker-row");
    item.dataset.centerWorker = worker.agentId;
    item.setAttribute("role", "row");
    item.addEventListener("click", event => { if (!event.target.closest("button")) selectWorker(worker.agentId); });
    // Drag moves the whole worker (its membership only) to another domain; the detail's domain menu is the keyboard path.
    // Dropped on another worker of its own group, it takes that place instead (order only; the handle's arrow keys do
    // the same). While searching or filtering some workers are hidden, so dragging waits until the full list is shown.
    const filteredList = Boolean(state.centerFilter?.search || state.centerFilter?.status || state.centerFilter?.scope || state.centerFilter?.domain);
    item.draggable = !filteredList && !domainEdit;
    item.dataset.dragState = filteredList ? "filtered" : domainEdit ? "saving" : "ready";
    if (filteredList) item.title = t("maestro.dragFiltered");
    item.addEventListener("dragstart", event => {
      dragWorker = { agentId: worker.agentId, from: worker.domain || "" };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-agent-factory-worker", worker.agentId);
      event.dataTransfer.setData("text/plain", worker.agentId);
      list.classList.add("is-dragging");
      item.classList.add("is-drag-source");
    });
    // Ending without a drop (Escape, or released outside a target) changes nothing.
    item.addEventListener("dragend", () => { dragWorker = undefined; list.classList.remove("is-dragging"); clearReorderMarks(); for (const target of list.querySelectorAll(".is-drop-target")) target.classList.remove("is-drop-target"); });
    const sameGroup = () => dragWorker && dragWorker.from === (worker.domain || "") && place?.group.includes(dragWorker.agentId);
    item.addEventListener("dragover", event => {
      if (!sameGroup()) return;
      if (dragWorker.agentId === worker.agentId) { event.preventDefault(); event.dataTransfer.dropEffect = "none"; clearReorderMarks(); item.classList.add("is-drag-source"); return; }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const box = item.getBoundingClientRect();
      const position = event.clientY > box.top + box.height / 2 ? "after" : "before";
      if (item.dataset.dropPosition === position) return;
      for (const other of list.querySelectorAll(".is-reorder-target")) if (other !== item) { other.classList.remove("is-reorder-target"); delete other.dataset.dropPosition; }
      item.classList.add("is-reorder-target");
      item.dataset.dropPosition = position;
    });
    item.addEventListener("dragleave", event => {
      if (item.contains(event.relatedTarget)) return;
      item.classList.remove("is-reorder-target");
      delete item.dataset.dropPosition;
    });
    item.addEventListener("drop", event => {
      if (!sameGroup()) return;
      event.preventDefault();
      const moving = dragWorker, after = item.dataset.dropPosition === "after";
      dragWorker = undefined; list.classList.remove("is-dragging"); clearReorderMarks();
      const next = app.maestroReorder(place.group, workerOrder(), moving.agentId, worker.agentId, after, place.known);
      if (next) saveWorkerOrder(next);
    });
    // The worker stays marked while its detail or one of its tasks is open.
    item.setAttribute("aria-current", String(Boolean(selected?.agentId === worker.agentId && state.centerDetailOpen !== false)));
    if (worker.active.length) item.dataset.running = "true";
    // Column 1: the worker, named by the model that runs it. Clicking the model opens that worker's own session (the same
    // "run" open the task detail uses), bound to its exact agent/run; the agent ID stays the link key, on hover and in detail.
    const who = node("span", undefined, "maestro-worker-cell");
    who.setAttribute("role", "cell");
    const label = workerName(worker);
    // The session to open: the worker's most urgent open task with a run (running before waiting), else its latest.
    const session = worker.current.find(value => value.run) || worker.latest;
    const sessionRun = session.task.runs?.find(run => run.agentId === worker.agentId && run.runId === session.run?.runId) || session.run;
    const name = button(label + (worker.duplicate ? " · " + worker.duplicate : ""), () => openMessage(session.entry, session.task, "run", sessionRun),
      "maestro-row-title maestro-worker-model" + (worker.model ? "" : " is-unset"));
    name.dataset.openSession = worker.agentId;
    if (sessionRun) name.dataset.sessionRun = sessionRun.runId;
    // The host opens a session only through the recorded Main conversation; without it or a run the model says why.
    name.disabled = !sessionRun || !session.entry.mainAgentId;
    const sessionTitle = !sessionRun ? t("maestro.sessionNoRun") : !session.entry.mainAgentId ? t("maestro.sessionNoMain") : t("maestro.openModelSession");
    // The same small "open" glyph the Main task flow uses for session links marks the model as clickable.
    name.replaceChildren(node("span", name.textContent, "maestro-model-label"));
    if (!name.disabled) { const glyph = icon("M6 3H3.5A.5.5 0 0 0 3 3.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V10M9 3h4v4M13 3 7.5 8.5"); glyph.classList.add("maestro-open-glyph"); name.append(glyph); }
    name.title = sessionTitle + " · " + worker.agentId + (sessionRun ? "/" + sessionRun.runId : "");
    name.setAttribute("aria-label", sessionTitle + " · " + label + " · " + worker.agentId);
    // The recorded role (worker/expert/…) is read first, before the model; it is never guessed from the model.
    who.append(roleBadge(worker.run, worker.latest.task, worker.agentId), name);
    // Column 2: what the worker was assigned for — its first assignment, under the narrower work area when one is recorded.
    // The title opens the worker's detail (history, commands, domain, removal).
    const title = node("span", undefined, "maestro-worker-title" + (worker.purpose ? "" : " is-empty"));
    title.setAttribute("role", "cell");
    const select = button("", () => selectWorker(worker.agentId), "maestro-worker-select");
    select.dataset.selectWorker = worker.agentId;
    if (worker.responsibility) select.append(node("span", worker.responsibility, "maestro-worker-area"));
    select.append(node("span", worker.purposeShort || t("maestro.purposeUnset"), "maestro-worker-purpose"));
    select.setAttribute("aria-label", t("maestro.openWorker", label + " · " + worker.agentId, worker.purposeShort || t("maestro.purposeUnset")));
    title.title = [worker.responsibility, worker.purpose || t("maestro.purposeUnset"),
      worker.purposeReason && t("maestro.purposeReason", worker.purposeReason)].filter(Boolean).join("\n");
    title.append(select);
    // Column 3: the worker's state now — its most urgent open task, otherwise its latest task's end state.
    const status = node("span", undefined, "maestro-worker-status");
    status.setAttribute("role", "cell");
    const badge = stateBadge(worker.status, stateLabel(worker.status));
    const time = timeLabel(worker.run, worker.at);
    badge.title = [stateLabel(worker.status), time.title].filter(Boolean).join(" · ");
    status.append(badge);
    // Column 4: the whole history of the worker.
    const historyCell = node("span", undefined, "maestro-worker-history");
    historyCell.setAttribute("role", "cell");
    const history = button(t("maestro.historyCount", worker.rows.length), () => selectWorker(worker.agentId, "history"), "maestro-button maestro-history-button");
    history.dataset.historyWorker = worker.agentId;
    history.setAttribute("aria-label", t("maestro.historyOpen", label + " · " + worker.agentId, worker.rows.length));
    // Removal is the same logical removal as the detail's (host confirms; blocked while anything runs; records kept).
    const removing = workerPending[worker.agentId + "/worker.remove"];
    const remove = button("", () => workerAction({ type: "worker.remove", agentId: worker.agentId, revision: registry().revision }), "maestro-icon-button maestro-worker-remove");
    remove.append(icon("M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4"));
    remove.dataset.removeWorker = worker.agentId;
    remove.disabled = Boolean(removing) || worker.active.length > 0 || !editable() || Boolean(worker.removed);
    const removeTitle = worker.active.length ? t("maestro.removeBlocked") : !editable() ? t("maestro.removeUnavailable") : t(removing ? "maestro.removing" : "maestro.removeWorker");
    remove.title = removeTitle;
    remove.setAttribute("aria-label", removeTitle + " · " + label + " · " + worker.agentId);
    // The handle ends the row so the role → model reading order stays first. It names what moves and is the keyboard
    // path: ↑/↓ move the worker one place within its group.
    const grip = button("", () => {}, "maestro-icon-button maestro-worker-grip");
    grip.dataset.reorderWorker = worker.agentId;
    grip.append(icon("M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01"));
    const position = place ? place.group.indexOf(worker.agentId) : -1;
    const gripLabel = filteredList ? t("maestro.dragFiltered") : t("maestro.reorderWorker", label + " · " + worker.agentId, position + 1, place?.group.length || 1);
    grip.title = gripLabel; grip.setAttribute("aria-label", gripLabel);
    grip.disabled = filteredList || !place || place.group.length < 2;
    grip.addEventListener("keydown", event => {
      if (!["ArrowUp", "ArrowDown"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault(); event.stopPropagation();
      const down = event.key === "ArrowDown";
      const target = place.group[position + (down ? 1 : -1)];
      const next = target && app.maestroReorder(place.group, workerOrder(), worker.agentId, target, down, place.known);
      if (next) saveWorkerOrder(next, worker.agentId);
    });
    historyCell.append(history, remove, grip);
    item.append(who, title, status, historyCell);
    const work = workerWork(worker);
    if (work) item.append(work);
    // A worker without a real domain says why and offers the listed domains (or its recorded name to create).
    if (worker.membership?.state === "required") {
      const need = node("div", undefined, "maestro-worker-membership");
      need.dataset.membershipWorker = worker.agentId;
      need.append(node("span", membershipNote(worker.membership), "maestro-membership-note"));
      if (editable()) need.append(membershipSelect(worker.agentId, worker.membership, "member:" + worker.agentId));
      if (domainEditError?.origin === "member:" + worker.agentId) { const problem = node("span", domainEditError.text, "maestro-error"); problem.setAttribute("role", "alert"); need.append(problem); }
      item.append(need);
    }
    return item;
  }
  function workerName(worker) {
    return worker.model || (worker.provider ? t("maestro.providerDefault", worker.provider) : t("maestro.modelUnrecorded"));
  }
  // Work request (request.md) and work report (result.md) of one exact agent/run, by name; a missing one says so.
  function workerDocuments(worker, value, run) {
    const documents = node("span", undefined, "maestro-worker-docs");
    for (const kind of ["request", "result"]) {
      const recorded = run?.[kind]?.availability === "recorded";
      const name = t(kind === "request" ? "maestro.requestDoc" : "maestro.reportDoc");
      if (recorded) {
        const open = button(name, () => openMessage(value.entry, value.task, kind, run), "maestro-link maestro-worker-doc");
        open.dataset.document = kind;
        open.dataset.documentRun = run.agentId + "/" + run.runId;
        open.title = t(kind === "request" ? "maestro.openRequest" : "maestro.openReport") + " · " + run.agentId + "/" + run.runId;
        open.setAttribute("aria-label", t(kind === "request" ? "maestro.openRequest" : "maestro.openReport") + " · " + (value.task.title || value.task.id));
        documents.append(open);
      } else {
        // A report not yet written by an open task is "not yet"; otherwise the document is honestly missing.
        const pending = kind === "result" && ["running", "waiting", "blocked", "decision", "verifying"].includes(value.status) && run?.result?.availability !== "error";
        const missing = node("span", t(kind === "request" ? "maestro.requestMissing" : pending ? "maestro.reportPending" : "maestro.reportMissing"), "maestro-worker-doc is-missing");
        missing.dataset.document = kind;
        documents.append(missing);
      }
    }
    return documents;
  }
  // Compact lines under the row. Every open task gets a line; the row's own single open task is not repeated, only its
  // documents. Completed work shows "Result · <its first result sentence>". A result from an earlier task names that task,
  // so it never reads as the current work. Each line ends with that exact run's work request and work report.
  function workerWork(worker) {
    const own = value => value.task === worker.origin.task && value.entry === worker.origin.entry;
    const runOf = value => value.task.runs?.find(item => item.agentId === worker.agentId && item.runId === value.run?.runId) || value.run;
    const ownOnly = worker.current.length === 1 && own(worker.current[0]);
    if (!worker.current.length && !worker.ended) return undefined;
    const work = node("div", undefined, "maestro-worker-work");
    work.setAttribute("role", "cell");
    work.setAttribute("aria-colspan", "4");
    for (const value of worker.current) {
      const line = node("div", undefined, "maestro-worker-line is-current");
      line.dataset.lineTask = value.entry.id + "/" + value.task.id;
      line.append(node("span", t("maestro.workCurrent"), "maestro-worker-kind"));
      const body = node("div", undefined, "maestro-worker-outcome");
      if (!ownOnly) {
        const open = workerTaskButton(worker, value);
        open.querySelector(".maestro-worker-task-title").textContent = app.maestroPurpose(value.task.title) || value.task.id;
        open.title = value.task.title || value.task.id;
        body.append(open);
      }
      body.append(workerDocuments(worker, value, runOf(value)));
      line.append(body);
      work.append(line);
    }
    if (worker.ended) {
      const value = worker.ended;
      const run = value.task.runs?.find(item => item.role === "work" && item.agentId === worker.agentId) || value.run;
      const line = node("div", undefined, "maestro-worker-line is-ended");
      line.dataset.resultTask = value.entry.id + "/" + value.task.id;
      line.dataset.lineTask = value.entry.id + "/" + value.task.id;
      line.append(node("span", t("maestro.workResult"), "maestro-worker-kind"));
      const outcome = node("div", undefined, "maestro-worker-outcome");
      // A result of another task than the row's names that task, and its state when the row shows open work.
      if (!own(value)) outcome.append(node("span", app.maestroPurpose(value.task.title) || value.task.id, "maestro-worker-for"));
      if (worker.current.length) outcome.append(stateBadge(value.status));
      const recorded = run?.result?.availability === "recorded";
      // The report's stated outcome (value, count, remaining problem) first; else its first sentence; else said missing.
      const sentence = recorded ? run.result.highlight || app.maestroResultLine(run.result.summary) : "";
      const text = sentence || (run?.result?.availability === "error" || recorded ? resultSummary(run) : t("maestro.resultUncollected"));
      const summary = node("span", text, "maestro-worker-summary" + (sentence ? "" : " is-empty"));
      if (run?.result?.availability === "error") summary.classList.add("maestro-error");
      summary.title = recorded && run.result.summary ? [run.result.highlight, run.result.summary].filter(Boolean).join("\n") : text;
      if (recorded) summary.dataset.basis = run.result.highlight ? "outcome" : sentence ? "first-sentence" : "none";
      outcome.append(summary, workerDocuments(worker, value, run));
      line.append(outcome);
      work.append(line);
    }
    return work;
  }
  function workerListHeader() {
    const head = node("div", undefined, "maestro-worker-head");
    head.setAttribute("role", "row");
    for (const key of ["maestro.columnWorker", "maestro.columnTitle", "maestro.columnStatus", "maestro.columnHistory"]) {
      const cell = node("span", t(key)); cell.setAttribute("role", "columnheader"); head.append(cell);
    }
    return head;
  }

  // Board columns follow the recorded task states; blocked and decision share a column but keep their own labels.
  const columns = [["waiting", ["waiting"]], ["running", ["running"]], ["verifying", ["verifying"]], ["decision", ["decision", "blocked"]], ["completed", ["completed"]], ["ended", ["failed", "cancelled"]], ["unknown", ["unknown"]]];
  function cardFor(value, selected) {
    const { entry, task } = value;
    const card = button("", () => select(entry, task), "maestro-card");
    card.dataset.centerTask = entry.id + "/" + task.id;
    card.setAttribute("aria-current", String(selected?.workflowId === entry.id && selected?.taskId === task.id));
    const work = task.runs?.find(run => run.role === "work") || value.run;
    const agents = [...new Set([task.workAgentId, task.verificationAgentId, ...(task.runs || []).map(run => run.agentId)].filter(Boolean))];
    const title = node("span", task.title || task.id, "maestro-card-title");
    title.title = task.title || task.id;
    const meta = node("span", undefined, "maestro-card-meta");
    meta.append(node("span", value.domainName || t("maestro.membershipRequired"), value.domainName ? "maestro-domain" : "maestro-membership-required"), roleBadge(work, task));
    const owner = node("span", agents.join(" · ") || t("maestro.unassigned"), agents.length ? "maestro-identity" : "maestro-unassigned");
    owner.title = owner.textContent;
    const result = node("span", work ? resultSummary(work) : t("maestro.executionMissing"), "maestro-card-result");
    if (work?.result?.availability === "error") result.classList.add("maestro-error");
    const footer = node("span", undefined, "maestro-card-footer");
    const state = stateBadge(value.status, stateLabel(value.status), t("maestro.status." + value.status));
    footer.append(state, timeLabel(work, value.at));
    card.append(title, meta, owner, result, footer);
    card.setAttribute("aria-label", [task.title, stateLabel(value.status), value.domainName || t("maestro.membershipRequired"), agents.join(" ") || t("maestro.unassigned")].join(" · "));
    return card;
  }
  function groupHeader(key, label, count, open, extra) {
    const toggle = button("", () => {
      state.centerCollapsed = { ...state.centerCollapsed, [key]: open };
      renderKey = undefined; render(); persist(false);
      [...list.querySelectorAll(".maestro-section-toggle")].find(value => value.dataset.centerGroup === key)?.focus();
    }, "maestro-section-toggle");
    toggle.dataset.centerGroup = key;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.append(icon("M6 3l5 5-5 5"), node("span", label), node("span", String(count), "maestro-count"));
    if (extra) toggle.append(node("span", extra, "maestro-group-summary"));
    return toggle;
  }
  function render() {
    const entries = state.projectTasks || [];
    const filter = state.centerFilter || {};
    const workers = state.centerView === "workers";
    const key = [entries, state.projectDomains, state.domainsError, state.centerSelection, state.centerFilter, state.centerView, state.centerDetailOpen, state.workerOrder, orderError, loading, error, notice, observedAt, t("maestro.center")];
    if (renderKey && key.every((value, i) => value === renderKey[i])) return;
    // Native <details> toggle events are queued; capture actual open state before a fast refresh replaces nodes.
    for (const group of detail.querySelectorAll(".maestro-group")) {
      const groupKey = group.querySelector(":scope > summary")?.dataset.centerGroup;
      if (groupKey) state.centerCollapsed = { ...state.centerCollapsed, [groupKey]: !group.open };
    }
    renderKey = key;
    const now = Date.now();
    const selected = state.centerSelection;
    const focused = document.activeElement;
    const focusTask = focused?.dataset?.centerTask, focusAgent = focused?.dataset?.centerAgent, focusGroup = focused?.dataset?.centerGroup;
    // A periodic refresh must not take the caret away from a name being typed.
    const focusInput = focused?.dataset?.domainInput, caret = focusInput ? focused.selectionStart : undefined;
    const detailFocus = detail.contains(focused) ? [...detail.querySelectorAll("button, summary")].indexOf(focused) : -1;
    const detailScroll = detail.scrollTop, listScroll = list.scrollTop;
    const mainIds = [...new Set(entries.map(entry => entry.mainAgentId).filter(Boolean))];
    const assignments = app.maestroWorkers(entries);
    const resolveDomain = (agentId, task) => app.maestroDomain(registry(), agentId, task);
    // With the domain list, a worker's group is its real membership only; without it, the recorded name is shown as-is.
    // A worker without a real membership has the empty key: the "membership required" section, never a domain.
    const placedDomain = (agentId, recorded, task) => {
      if (!registry()) return resolveDomain(agentId, task);
      const membership = app.maestroMembership(registry(), agentId, recorded);
      return membership.state === "placed" ? { key: membership.domainId, name: membership.name } : { key: "", name: "" };
    };
    function options(element, values, value) {
      if (!element) return;
      if (element.options.length !== values.length || values.some(([id, label], index) => element.options[index]?.value !== id || element.options[index]?.textContent !== label)) {
        element.replaceChildren(...values.map(([id, label]) => { const option = node("option", label); option.value = id; return option; }));
      }
      element.value = value || "";
    }
    workerView?.setAttribute("aria-selected", String(workers)); taskView?.setAttribute("aria-selected", String(!workers));
    workerView?.setAttribute("tabindex", workers ? "0" : "-1"); taskView?.setAttribute("tabindex", workers ? "-1" : "0");
    list.setAttribute("aria-label", t(workers ? "maestro.workers" : "maestro.tasks"));
    list.classList.toggle("is-workers", workers);
    // Groups are the listed domains; a worker without a real membership is listed under "membership required".
    if (domain) document.getElementById("maestro-domain-filter").hidden = false;
    if (domainAdd) { domainAdd.hidden = !workers || !editable(); domainAdd.disabled = Boolean(domainEdit); }
    // Filter values are domain IDs (or a recorded name not yet in the list), so a rename keeps the filter.
    // A legacy unnamed domain kept its former placeholder text; that is not a name, so it is shown as unnamed.
    const domainChoices = new Map((registry()?.domains || []).map(item => [item.id, item.provisional ? t("maestro.domainUnnamed") : item.name]));
    const provisional = new Set((registry()?.domains || []).filter(item => item.provisional).map(item => item.id));
    options(scope, [["", t("maestro.scope") + ": " + t("maestro.all")], ...mainIds.map(id => [id, id])], filter.scope);
    options(status, [["", t("maestro.status") + ": " + t("maestro.all")], ...statuses.map(id => [id, stateLabel(id)])], filter.status);
    if (search.value !== (filter.search || "")) search.value = filter.search || "";
    const rows = entries.flatMap(entry => entry.tasks.map(task => {
      const latest = latestRun(task.runs);
      const owner = task.workAgentId || task.runs?.find(run => run.role === "work")?.agentId;
      const placed = placedDomain(owner, task.domain, task);
      return { entry, task, domain: placed.key, domainName: placed.name, status: app.maestroStatus(entry, task), run: latest, at: activityTime(latest) || entry.updatedAt };
    }));
    const needle = (filter.search || "").toLocaleLowerCase();
    const matches = value => (!filter.scope || value.entry.mainAgentId === filter.scope) && (!needle ||
      [value.task.title, value.task.id, value.entry.id, value.entry.title, value.agentId, value.domainName, value.task.domain,
        ...(value.runs || value.task.runs || []).map(run => [run.agentId, run.runId, run.model, run.result?.summary].join(" "))]
        .join(" ").toLocaleLowerCase().includes(needle));
    const visible = rows.filter(value => matches(value) && (!filter.domain || (value.domain || "__required") === filter.domain)
      && (!filter.status || value.status === filter.status));
    const workerRows = assignments.map(value => {
      const run = latestRun(value.runs);
      const placed = placedDomain(value.agentId, value.task.domain, value.task);
      return { ...value, run, domain: placed.key, domainName: placed.name, status: app.maestroAssignment(value.task, run), at: activityTime(run) || value.entry.updatedAt };
    });
    for (const value of [...rows, ...workerRows]) if (value.domain && !domainChoices.has(value.domain)) domainChoices.set(value.domain, value.domainName);
    options(domain, [["", t("maestro.domain") + ": " + t("maestro.all")],
      ...[...domainChoices].sort((left, right) => left[1].localeCompare(right[1]))
        .map(([id, name]) => [id, name]),
      ...([...rows, ...workerRows].some(value => !value.domain) ? [["__required", t("maestro.membershipRequired")]] : [])], filter.domain);
    // Each worker's membership, from its recorded agent ID; the recorded allocation name is only a suggestion.
    const workerIndex = app.maestroWorkerIndex(workerRows, registry()).map(worker => {
      if (!registry()) return worker;
      const membership = app.maestroMembership(registry(), worker.agentId, recordedDomain(worker.rows));
      // A worker needing a domain shows its recorded name once, in its membership line, not again as a work-area tag.
      return { ...worker, membership, domain: membership.state === "placed" ? membership.domainId : "", domainName: membership.name || "",
        ...(membership.state === "placed" ? {} : { responsibility: "" }) };
    });
    const removed = registry()?.removedWorkers || {};
    // A worker is listed once, under its membership (or its latest task's domain), when any of its tasks matches.
    const visibleWorkers = workerIndex.filter(worker => !removed[worker.agentId]
      && worker.rows.some(value => matches(value) && (!filter.status || value.status === filter.status))
      && (!filter.domain || (worker.domain || "__required") === filter.domain));
    const shown = workers ? visibleWorkers : visible;
    const total = workers ? workerIndex.filter(worker => !removed[worker.agentId]).length : rows.length;
    if (workerCount) workerCount.textContent = workers ? String(total) : "";
    workerView?.setAttribute("aria-label", workers ? t("maestro.workers") + " " + total : t("maestro.workers"));
    list.replaceChildren();
    if (notice) {
      const message = node("p", notice, "maestro-list-notice");
      message.setAttribute("role", "status");
      list.append(message);
    }
    if (error && entries.length) {
      const problem = node("p", t("maestro.error", error), "maestro-error maestro-list-notice");
      problem.setAttribute("role", "status");
      list.append(problem);
    }
    if (state.domainsError) {
      const problem = node("p", t("maestro.domainsUnavailable", state.domainsError), "maestro-error maestro-list-notice");
      problem.setAttribute("role", "status");
      list.append(problem);
    }
    const filtered = Boolean(filter.search || filter.status || filter.scope || filter.domain);
    const order = (left, right) => String(right.at || "").localeCompare(String(left.at || ""));
    const sectionOf = value => app.maestroSection(value.status, value.at, now);
    const rank = value => sections.indexOf(sectionOf(value));
    // Worker view: domain → worker → assigned task and result. Status and time only order rows inside a worker;
    // they never replace the domain/worker grouping.
    // Workers still needing a domain lead (they need the Human), then named domains, then legacy unnamed ones.
    const groupOrder = (left, right) => Number(Boolean(left)) - Number(Boolean(right)) || Number(provisional.has(left)) - Number(provisional.has(right))
      || (domainChoices.get(left) || "").localeCompare(domainChoices.get(right) || "");
    const domainGroups = workers ? [...new Set(shown.map(value => value.domain || ""))].sort(groupOrder) : [];
    // A new domain starts in the editor; it has no workers until one is placed in it.
    if (workers && orderError) { const problem = node("p", orderError, "maestro-error maestro-drag-error maestro-order-error"); problem.setAttribute("role", "alert"); list.append(problem); }
    if (workers && editable()) {
      if (domainEditError?.origin === "drag") { const problem = node("p", domainEditError.text, "maestro-error maestro-domain-error maestro-drag-error"); problem.setAttribute("role", "alert"); list.append(problem); }
      // A new domain is named before it exists.
      if (domainEditor?.origin === "create") list.append(domainNameEditor("create", domainEditor.value ?? "", name => sendDomainEdit({ type: "domain.create", name }, "create")));
      else if (domainEditError?.origin === "create") { const problem = node("p", domainEditError.text, "maestro-error maestro-domain-error"); problem.setAttribute("role", "alert"); list.append(problem); }
      // Every listed domain stays visible (and droppable) even while empty; there is no fallback group.
      for (const item of registry().domains) if (!filtered && !domainGroups.includes(item.id)) domainGroups.push(item.id);
      domainGroups.sort(groupOrder);
    }
    if (workers && domainGroups.length) list.append(workerListHeader());
    for (const domainId of domainGroups) {
      const members = shown.filter(value => (value.domain || "") === domainId);
      const domainKey = JSON.stringify(["domain", domainId]);
      const domainOpen = filtered || !state.centerCollapsed?.[domainKey];
      const domainName = domainChoices.get(domainId) || "";
      // The empty key is not a domain: it lists workers whose membership the Human still has to choose.
      const header = groupHeader(domainKey, domainId ? domainName : t("maestro.membershipRequired"), members.length, domainOpen,
        [provisional.has(domainId) ? t("maestro.domainProvisional") : "", t("maestro.assignments", members.reduce((sum, value) => sum + value.rows.length, 0))].filter(Boolean).join(" · "));
      if (provisional.has(domainId)) header.dataset.provisional = "true";
      header.classList.add("maestro-domain-toggle");
      header.dataset.domain = domainId ? domainName : "__required";
      if (domainId) header.dataset.domainKey = domainId;
      else header.dataset.membershipRequired = "true";
      // Drop targets: listed, named domains only (by ID, including empty or collapsed ones). A legacy unnamed domain is
      // named first; nothing can be dropped back into "membership required".
      const droppable = editable() && !filtered && Boolean(domainId) && registry().domains.some(item => item.id === domainId && !item.provisional);
      if (droppable) {
        header.dataset.dropTarget = domainId;
        header.addEventListener("dragover", event => {
          if (!dragWorker) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = dragWorker.from === domainId ? "none" : "move";
          header.classList.toggle("is-drop-target", dragWorker.from !== domainId);
        });
        header.addEventListener("dragleave", () => header.classList.remove("is-drop-target"));
        header.addEventListener("drop", event => {
          event.preventDefault();
          header.classList.remove("is-drop-target");
          const moving = dragWorker; dragWorker = undefined; list.classList.remove("is-dragging");
          // Dropping on the worker's own group, or with an edit still saving, changes nothing.
          if (!moving || moving.from === domainId || domainEdit) return;
          sendDomainEdit({ type: "domain.assign", agentId: moving.agentId, domainId }, "drag");
        });
      }
      header.disabled = filtered;
      const listed = registry()?.domains.find(item => item.id === domainId);
      if (listed) header.title = changeLabel(listed.nameSetBy);
      if (domainEditor?.origin === "rename:" + domainId) {
        list.append(domainNameEditor("rename:" + domainId, domainEditor.value ?? (provisional.has(domainId) ? "" : domainName), name => sendDomainEdit({ type: "domain.rename", domainId, name }, "rename:" + domainId)));
      } else if (domainEditor?.origin === "adopt:" + domainId) {
        list.append(domainNameEditor("adopt:" + domainId, domainEditor.value ?? domainName, name => sendDomainEdit({ type: "domain.create", name }, "adopt:" + domainId)));
      } else {
        list.append(header);
        // Listed domains are renamed; a recorded name not yet listed is added to the list under that name.
        if (domainId && editable()) {
          const edit = button("", () => { domainEditor = { origin: (listed ? "rename:" : "adopt:") + domainId, value: provisional.has(domainId) ? "" : domainName }; domainEditError = undefined; renderKey = undefined; render();
            center.querySelector("[data-domain-input]")?.focus(); }, "maestro-icon-button maestro-domain-edit");
          edit.append(icon(listed ? "M11 2.5l2.5 2.5L6 12.5H3.5V10z" : "M8 3v10M3 8h10"));
          const label = t(listed ? "maestro.domainRename" : "maestro.domainAdopt", domainName);
          edit.setAttribute("aria-label", label); edit.title = label;
          edit.disabled = Boolean(domainEdit);
          header.classList.add("has-edit");
          list.append(edit);
        }
      }
      if (!domainOpen) continue;
      // One row per worker: the worker first, then its latest task; running work leads, then the latest activity.
      // A saved order (moved by the Human) wins over that; workers it does not name yet keep the usual order and lead.
      const sorted = members.sort((left, right) => rank(left) - rank(right) || order(left, right));
      // Two workers with the same model and purpose in one group get a running number; each row still links by agent ID.
      // The number follows the usual order, so moving a row never renumbers the workers.
      const seen = new Map(), duplicate = new Map();
      for (const worker of sorted) {
        const key = JSON.stringify([workerName(worker), worker.purpose]);
        const count = sorted.filter(other => JSON.stringify([workerName(other), other.purpose]) === key).length;
        seen.set(key, (seen.get(key) || 0) + 1);
        duplicate.set(worker.agentId, count > 1 ? seen.get(key) : 0);
      }
      const arranged = app.maestroArrange(sorted, workerOrder());
      const place = { group: arranged.map(worker => worker.agentId), known: workerIndex.map(worker => worker.agentId) };
      for (const worker of arranged) list.append(workerRowFor({ ...worker, duplicate: duplicate.get(worker.agentId) }, selected, place));
    }
    // Task view: a kanban board with one column per recorded task state; domain and assignees are card details.
    if (!workers && shown.length) {
      const board = node("div", undefined, "maestro-board");
      board.setAttribute("role", "group");
      board.setAttribute("aria-label", t("maestro.tasks"));
      for (const [columnId, members] of columns.map(([id, states]) => [id, shown.filter(value => states.includes(value.status)).sort(order)])) {
        if (columnId === "unknown" && !members.length) continue;
        const column = node("section", undefined, "maestro-column");
        column.dataset.column = columnId;
        const heading = node("h3", undefined, "maestro-column-title");
        heading.append(node("span", t("maestro.column." + columnId)), node("span", String(members.length), "maestro-count"));
        const cards = node("div", undefined, "maestro-cards");
        for (const value of members) cards.append(cardFor(value, selected));
        if (!members.length) cards.append(node("p", t("maestro.none"), "maestro-column-empty"));
        column.append(heading, cards);
        board.append(column);
      }
      list.append(board);
    }
    if (!shown.length) {
      const empty = node("div", undefined, "maestro-empty");
      empty.append(node("p", loading ? t("maestro.loading") : error ? t("maestro.error", error) : entries.length ? t("maestro.empty") : t("maestro.noRecords")));
      if (!loading && entries.length && filtered) empty.append(button(t("maestro.clearFilters"), () => {
        state.centerFilter = {}; renderKey = undefined; render(); persist(false); search.focus();
      }, "maestro-button"));
      list.append(empty);
    }
    const chosen = selected?.workflowId ? rows.find(value => value.entry.id === selected.workflowId && value.task.id === selected?.taskId) : undefined;
    const chosenWorker = workers && selected?.agentId && !selected.workflowId ? workerIndex.find(worker => worker.agentId === selected.agentId) : undefined;
    const chosenSupervision = Boolean(selected?.supervision);
    // A task opened from the task view names no worker; the worker view shows its recorded Work agent.
    if (workers && chosen && !selected.agentId) {
      const agentId = chosen.task.workAgentId || chosen.task.runs?.[0]?.agentId || chosen.task.verificationAgentId;
      if (agentId) state.centerSelection = { ...selected, agentId };
    }
    const open = Boolean((chosen || chosenWorker || chosenSupervision) && state.centerDetailOpen !== false);
    workspace.dataset.layout = open ? "split" : "list";
    detail.hidden = !open;
    delete detail.dataset.view;
    if (open && chosenSupervision) renderSupervision(rows);
    else if (open && chosenWorker) renderWorkerDetail(chosenWorker, removed);
    else renderDetail(open ? chosen.entry : undefined, open ? chosen.task : undefined, workerRows);
    detail.scrollTop = detailScroll; list.scrollTop = listScroll;
    const typing = focusInput && [...center.querySelectorAll("[data-domain-input]")].find(value => value.dataset.domainInput === focusInput);
    const opened = domainFocus && [...center.querySelectorAll("[data-domain-input]")].find(value => value.dataset.domainInput === domainFocus);
    if (opened) { domainFocus = undefined; opened.focus(); opened.select(); }
    else if (typing) { typing.focus(); typing.setSelectionRange(caret, caret); }
    else if (focused?.dataset?.selectWorker) list.querySelector("[data-select-worker=\"" + CSS.escape(focused.dataset.selectWorker) + "\"]")?.focus();
    else if (focused?.dataset?.historyWorker) list.querySelector("[data-history-worker=\"" + CSS.escape(focused.dataset.historyWorker) + "\"]")?.focus();
    else if (focusTask) [...list.querySelectorAll("[data-center-task]")].find(value => value.dataset.centerTask === focusTask && value.dataset.centerAgent === focusAgent)?.focus();
    else if (focusGroup) [...center.querySelectorAll("[data-center-group]")].find(value => value.dataset.centerGroup === focusGroup)?.focus();
    else if (detailFocus >= 0) [...detail.querySelectorAll("button, summary")][detailFocus]?.focus();
    else if (focused === detail && open) detail.focus();
  }
  function requestSupervision() {
    if (supervision?.loading) return;
    state.centerSelection = { supervision: true };
    state.centerDetailOpen = true;
    supervision = { ...supervision, loading: true, error: undefined };
    vscode.postMessage({ type: "supervision.request" });
    renderKey = undefined; render(); persist(false);
    detail.focus();
  }
  function supervisionResult(message) {
    supervision = message.error ? { ...supervision, loading: false, error: message.error }
      : { loading: false, report: message.report && typeof message.report === "object" ? message.report : undefined, receivedAt: Date.now() };
    renderKey = undefined; render();
  }
  function handoffModelsResult(message) {
    handoffModels = Array.isArray(message.models) ? message.models.filter(item => item && typeof item.id === "string") : [];
    handoffModelsError = message.error;
    renderKey = undefined; render();
  }
  const VERDICTS = ["decision-needed", "stuck", "delayed", "normal"];
  // The verdict's dot reuses the task status colours: decision and delay warn, stuck is an error, normal is running work.
  const VERDICT_DOT = { "decision-needed": "decision", stuck: "failed", delayed: "blocked", normal: "running" };
  function durationText(seconds) {
    if (typeof seconds !== "number") return t("maestro.unrecorded");
    return seconds < 60 ? t("duration.seconds", Math.floor(seconds)) : seconds < 3600 ? t("flow.duration.minutes", Math.floor(seconds / 60))
      : t("flow.duration.hours", Math.round(seconds / 360) / 10);
  }
  // Reason codes from the runtime, in words; an unknown code stays as recorded.
  function reasonText(code) {
    const [kind, ...rest] = String(code).split(":");
    if (kind === "loop-stopped") return t("maestro.reason.loopStopped", rest.join(" · ") || t("maestro.unrecorded"));
    if (kind === "repeated-error") { const match = /^(.*)x(\d+)$/.exec(rest.join(":")); return t("maestro.reason.repeatedError", match?.[1] || rest.join(":"), match?.[2] || "?"); }
    if (kind === "repeated-verification-fail") return t("maestro.reason.repeatedVerificationFail", rest.join("").replace(/^x/, ""));
    return ["decision-pending", "no-progress", "external-wait", "state-unknown"].includes(kind) ? t("maestro.reason." + kind) : String(code);
  }
  function opStateLabel(value) {
    return ["assigned", "running", "waiting-external", "waiting-decision", "blocked", "execution-ended", "work-completed", "check-passed", "unknown"].includes(value)
      ? t("maestro.opState." + value) : value || t("maestro.unrecorded");
  }
  function renderSupervision(rows) {
    detail.replaceChildren();
    delete detail.dataset.workerId; delete detail.dataset.workflowId; delete detail.dataset.taskId;
    detail.dataset.view = "supervision";
    const header = node("header", undefined, "maestro-detail-header");
    const back = button("", returnToList, "maestro-icon-button maestro-close");
    back.setAttribute("aria-label", t("maestro.returnList")); back.title = t("maestro.returnList");
    back.append(icon("M4 4l8 8M12 4l-8 8"));
    const titleRow = node("div", undefined, "maestro-detail-title");
    titleRow.append(node("h2", t("maestro.supervisionReport")), back);
    header.append(titleRow);
    const report = supervision?.report;
    if (report) {
      const settings = report.settings || {};
      const observed = node("p", t("maestro.supervisionBasis", settings.delayMinutes ?? "?", settings.stuckMinutes ?? "?"), "maestro-freshness");
      if (report.observedAt) observed.append(" · ", timeLabel(undefined, report.observedAt));
      header.append(observed);
    }
    detail.append(header);
    const actions = node("div", undefined, "maestro-actions");
    const again = button(t(supervision?.loading ? "maestro.supervisionLoading" : "maestro.supervisionRefresh"), requestSupervision, "maestro-button");
    again.disabled = Boolean(supervision?.loading);
    actions.append(again);
    detail.append(actions);
    if (supervision?.error) { const problem = node("p", t("maestro.supervisionFailed", supervision.error), "maestro-error"); problem.setAttribute("role", "alert"); detail.append(problem); }
    if (!report) { if (supervision?.loading) detail.append(node("p", t("maestro.supervisionLoading"), "maestro-text")); return; }
    const verdicts = (report.verdicts || []).slice().sort((left, right) => VERDICTS.indexOf(left.verdict) - VERDICTS.indexOf(right.verdict)
      || (right.idleSeconds ?? -1) - (left.idleSeconds ?? -1));
    // Counts per verdict, in the order the reader acts on them.
    const counts = node("p", undefined, "maestro-supervision-counts");
    for (const code of VERDICTS) {
      const count = verdicts.filter(value => value.verdict === code).length;
      if (count) counts.append(stateBadge(VERDICT_DOT[code], t("maestro.verdict." + code) + " " + count));
    }
    if (counts.children.length) detail.append(counts);
    const section = (title, values, key) => {
      const block = node("section", undefined, "maestro-block");
      block.dataset.supervision = key;
      block.append(node("h3", title));
      const items = node("ul", undefined, "maestro-supervision-list");
      for (const value of values) items.append(verdictItem(value, rows));
      block.append(items);
      detail.append(block);
    };
    if ((report.alerts || []).length) section(t("maestro.supervisionAlerts"), report.alerts, "alerts");
    if (verdicts.length) section(t("maestro.supervisionVerdicts"), verdicts, "verdicts");
    else detail.append(node("p", t("maestro.supervisionEmpty"), "maestro-text"));
    if ((report.errors || []).length) {
      const block = node("section", undefined, "maestro-block");
      block.append(node("h3", t("maestro.supervisionErrors")), ...report.errors.map(text => node("p", text, "maestro-error maestro-identity")));
      detail.append(block);
    }
  }
  // One verdict: label, task, recorded state, times and reasons; the runtime's next-action text stays in the tooltip.
  function verdictItem(value, rows) {
    const item = node("li", undefined, "maestro-supervision-item");
    item.dataset.verdict = value.verdict;
    const match = rows.find(row => row.entry.loopId === value.loopId && row.task.id === value.taskId)
      || rows.find(row => row.entry.loopId === value.loopId);
    const head = node("div", undefined, "maestro-supervision-head");
    const label = VERDICTS.includes(value.verdict) ? t("maestro.verdict." + value.verdict) : value.verdict;
    const badge = stateBadge(VERDICT_DOT[value.verdict] || "unknown", label);
    const title = match ? button(value.title || value.taskId, () => select(match.entry, match.task), "maestro-link maestro-supervision-title")
      : node("span", value.title || value.taskId, "maestro-supervision-title");
    title.title = value.title || value.taskId || "";
    head.append(badge, title);
    item.append(head);
    const facts = [opStateLabel(value.state), t("maestro.supervisionTimes", durationText(value.elapsedSeconds), durationText(value.idleSeconds)),
      ...(value.reasons || []).map(reasonText)];
    const line = node("p", facts.join(" · "), "maestro-freshness");
    if (value.nextAction) line.title = value.nextAction;
    item.append(line);
    if (value.verdict === "decision-needed") {
      // The decision itself is answered where it is asked: the task's Main conversation.
      const answer = button(t("maestro.decisionOpen"), () => openMessage(match.entry, match.task, "chat"), "maestro-button is-primary");
      answer.disabled = !match?.entry.mainAgentId;
      if (answer.disabled) answer.title = t("maestro.decisionUnlinked");
      item.append(answer);
    }
    return item;
  }
  return { render, receive, domainResult, workerResult, showNotice, supervisionResult, handoffModelsResult, workerOrderResult };
};
