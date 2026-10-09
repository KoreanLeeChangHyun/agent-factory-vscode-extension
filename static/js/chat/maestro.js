globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
// Display is a projection of recorded state. Opening a view never drives a loop.
globalThis.AgentFactoryChat.maestroStatus = function (entry, task) {
  const run = task.runs?.find(value => value.role === "work");
  if (entry.status === "completed" || task.workStatus === "completed") {
    if (["running", "pending"].includes(task.verificationStatus)) return "running";
    if (task.verificationStatus === "failed") return "failed";
    return run?.receipt?.outcome === "completed" ? "completed" : "unknown";
  }
  if (entry.status === "needs-human-decision" || run?.status === "needs-human-decision") return "decision";
  if (["failed", "runtime-error"].includes(entry.status) || run?.status === "failed") return "failed";
  if (entry.status === "cancelled" || run?.status === "cancelled") return "cancelled";
  if (task.workStatus === "blocked") return "blocked";
  if (["running", "verifying"].includes(task.workStatus) || run?.status === "running") return "running";
  if (["pending", "queued"].includes(task.workStatus)) {
    if ([...(task.allocation?.dependencies || []), ...(task.allocation?.sharedResources || [])].some(value => value.confirmed === false)) return "blocked";
    return "waiting";
  }
  return "unknown";
};
globalThis.AgentFactoryChat.maestro = function (host) {
  "use strict";
  const { state, t, vscode, persist } = host;
  const list = document.getElementById("maestro-tasks");
  const detail = document.getElementById("maestro-detail");
  const scope = document.getElementById("maestro-scope");
  const status = document.getElementById("maestro-status");
  const search = document.getElementById("maestro-search");
  const statuses = ["running", "waiting", "blocked", "decision", "completed", "failed", "cancelled", "unknown"];
  let observedAt, error, loading = false;
  let renderKey;
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (text, action) => {
    const element = node("button", text);
    element.type = "button";
    element.addEventListener("click", action);
    return element;
  };
  function request() {
    loading = true;
    vscode.postMessage({ type: "project.tasks.request" });
    render();
  }
  document.getElementById("maestro-refresh").addEventListener("click", request);
  for (const element of [scope, status, search]) element.addEventListener("input", function () {
    state.centerFilter = { scope: scope.value, status: status.value, search: search.value };
    renderKey = undefined;
    render();
    persist(false);
  });
  function receive(message) {
    loading = false;
    error = message.error;
    observedAt = error ? undefined : new Date().toISOString();
    renderKey = undefined;
    render();
  }
  function row(label, value) {
    detail.append(node("h4", label), node("p", value === undefined || value === null || value === "" ? t("maestro.unrecorded") : String(value)));
  }
  function select(entry, task) {
    state.centerSelection = { workflowId: entry.id, taskId: task.id };
    renderKey = undefined;
    render();
    detail.focus();
    persist(false);
  }
  function renderDetail(entry, task) {
    detail.replaceChildren();
    if (!entry || !task) { detail.append(node("p", t("maestro.select"))); return; }
    detail.dataset.workflowId = entry.id;
    detail.dataset.taskId = task.id;
    detail.append(node("h3", task.title), node("p", entry.id + " / " + task.id), node("p", t("maestro.status." + globalThis.AgentFactoryChat.maestroStatus(entry, task))));
    const controls = node("div", undefined, "maestro-detail-actions");
    for (const target of ["chat", "run", "records"]) {
      const action = button(t("maestro." + target), () => {
        vscode.postMessage({ type: "project.task.open", workflowId: entry.id, taskId: task.id, target });
      });
      action.disabled = target === "run" ? !task.runs?.length : target === "records" ? !entry.loopId : !entry.mainAgentId;
      controls.append(action);
    }
    controls.append(button(t("maestro.feedback"), function () {
      vscode.postMessage({ type: "project.task.open", workflowId: entry.id, taskId: task.id, target: "feedback" });
    }));
    detail.append(controls);
    row(t("maestro.request"), task.description);
    row(t("maestro.success"), task.completionCriteria);
    row(t("maestro.updated"), entry.updatedAt);
    const allocation = task.allocation;
    if (allocation) {
      row(t("maestro.assignment"), [allocation.profile?.id, allocation.profile?.reason, allocation.session?.strategy, allocation.session?.reason].filter(Boolean).join(" · "));
      row(t("maestro.boundary"), allocation.writeScopeReason);
      const dependencies = node("section"); dependencies.append(node("h4", t("maestro.dependencies")));
      for (const dependency of allocation.dependencies || []) {
        const label = [dependency.taskId, dependency.source, dependency.revision, dependency.capturedAt, t(dependency.confirmed ? "maestro.confirmed" : "maestro.unconfirmed")].filter(Boolean).join(" · ");
        const predecessor = entry.tasks.find(value => value.id === dependency.taskId);
        dependencies.append(predecessor ? button(label, () => select(entry, predecessor)) : node("p", label));
      }
      if (!(allocation.dependencies || []).length) dependencies.append(node("p", t("maestro.none")));
      detail.append(dependencies);
      for (const [key, label] of [["inputs", "maestro.sources"], ["sharedResources", "maestro.ownership"]]) {
        const section = node("details"); section.append(node("summary", t(label)));
        for (const record of allocation[key] || []) section.append(node("p", Object.entries(record).map(([key, value]) => key + ": " + value).join(" · ")));
        detail.append(section);
      }
      row(t("maestro.parallel"), allocation.parallelCandidate === true ? t("maestro.candidate") : t("maestro.sequential"));
    } else row(t("maestro.assignment"), undefined);
    for (const run of task.runs || []) {
      const section = node("details"); section.open = true;
      section.append(node("summary", [run.role, run.workProfile, run.model, run.status].filter(Boolean).join(" · ")));
      const lines = [run.agentId + "/" + run.runId];
      for (const key of ["acceptedAt", "startedAt", "finishedAt", "updatedAt", "attempt", "errorCode"]) lines.push(key + ": " + (run[key] ?? t("maestro.unrecorded")));
      lines.push("receipt: " + (run.receipt?.outcome ?? t("maestro.unconfirmed")));
      if (run.receipt?.checks) lines.push(run.receipt.checks);
      lines.push(t("maestro.accounting"));
      for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"]) lines.push(key + ": " + (run.usage?.[key] ?? t("maestro.unrecorded")));
      for (const [label, record] of [["context", run.context], ["handoff", run.handoff]]) lines.push(label + ": " + (record ? JSON.stringify(record) : t("maestro.unrecorded")));
      for (const message of state.timeline.filter(value => value.type === "user" && typeof run.parentRunId === "string" && value.submission?.runId === run.parentRunId)) lines.push("message: " + message.id + " · received: " + (message.submittedAt ?? t("maestro.unrecorded")) + " · accepted: " + (message.submission.acceptedAt ?? t("maestro.unrecorded")));
      section.append(node("pre", lines.join("\n")));
      detail.append(section);
    }
  }
  function render() {
    const entries = state.projectTasks || [];
    const filter = state.centerFilter || {};
    const key = [entries, state.centerSelection, state.centerFilter, loading, error, observedAt, t("maestro.center")];
    if (renderKey && key.every((value, i) => value === renderKey[i])) return;
    renderKey = key;
    const selected = state.centerSelection;
    const mainIds = [...new Set(entries.map(entry => entry.mainAgentId).filter(Boolean))];
    function options(element, values, value) {
      element.replaceChildren(...values.map(([id, label]) => { const option = node("option", label); option.value = id; return option; }));
      element.value = value || "";
    }
    options(scope, [["", t("maestro.all")], ...mainIds.map(id => [id, id])], filter.scope);
    options(status, [["", t("maestro.all")], ...statuses.map(id => [id, t("maestro.status." + id)])], filter.status);
    if (search.value !== (filter.search || "")) search.value = filter.search || "";
    const rows = entries.flatMap(entry => entry.tasks.map(task => ({ entry, task, status: globalThis.AgentFactoryChat.maestroStatus(entry, task) })));
    const visible = rows.filter(value => (!filter.scope || value.entry.mainAgentId === filter.scope) && (!filter.status || value.status === filter.status) && (!filter.search || (value.task.title + " " + value.task.id + " " + value.entry.title).toLocaleLowerCase().includes(filter.search.toLocaleLowerCase())));
    document.getElementById("maestro-observation").textContent = loading ? t("maestro.loading") : error ? t("maestro.error", error) : observedAt ? t("maestro.observed", observedAt) : t("maestro.stale");
    document.getElementById("maestro-overview").replaceChildren(...statuses.map(id => button(t("maestro.status." + id) + " " + rows.filter(value => value.status === id).length, () => {
      state.centerFilter = { ...filter, status: id }; renderKey = undefined; render(); persist(false);
    })));
    // Preserve focus when refreshing the same selected task.
    const focused = document.activeElement?.dataset?.centerTask;
    list.replaceChildren(...visible.map(({ entry, task, status }) => {
      const item = button(task.title + " · " + t("maestro.status." + status), () => select(entry, task));
      item.dataset.centerTask = entry.id + "/" + task.id;
      item.setAttribute("aria-current", String(selected?.workflowId === entry.id && selected?.taskId === task.id));
      return item;
    }));
    if (!visible.length) list.append(node("p", t("maestro.empty")));
    if (focused) [...list.querySelectorAll("button")].find(value => value.dataset.centerTask === focused)?.focus();
    const chosen = rows.find(value => value.entry.id === selected?.workflowId && value.task.id === selected?.taskId);
    renderDetail(chosen?.entry, chosen?.task);
  }
  return { render, receive };
};
