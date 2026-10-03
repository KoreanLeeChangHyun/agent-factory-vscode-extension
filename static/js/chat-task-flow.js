globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.taskFlow = function (host) {
  "use strict";

  const {
    indexedTimeline, state, t, vscode, runStageList, selectQuestionTab, historyEmpty, runDetails,
    runStatus, runStatusToggle, runStatusAgents, runDetailsSummary, runStopButton,
    childAgentStatusLabel
  } = host;

  const taskFlowParseCache = new WeakMap();
  let taskFlowSnapshot;
  // Loops whose revision-limit decision was clicked and is not answered by the host yet.
  const workflowDecisionsPending = new Set();
  // Revisions one "Continue" authorizes; the host passes the same number to the runtime.
  const REVISION_LIMIT_EXTENSION = 3;
  function extractTaskFlows(text) {
    const flows = [];
    const rest = text.replace(/^```task-flow\s*\n([\s\S]*?)^```\s*$/gm, function (block, json) {
      try {
        const flow = JSON.parse(json);
        const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
        const validText = value => typeof value === "string" && value.trim();
        const statuses = ["pending", "running", "verifying", "completed", "failed", "blocked", "cancelled"];
        if (!validId(flow.id) || !validText(flow.title) || !Array.isArray(flow.tasks) || !flow.tasks.length) return block;
        if (!flow.tasks.every(task => task && validId(task.id) && validText(task.title) && statuses.includes(task.status) &&
          (task.description === undefined || (typeof task.description === "string")) &&
          (task.agentId === undefined || validId(task.agentId)) && (task.runId === undefined || validId(task.runId)))) return block;
        if (new Set(flow.tasks.map(task => task.id)).size !== flow.tasks.length) return block;
        flows.push(flow);
        return "";
      } catch { return block; }
    });
    return { text: rest, flows };
  }
  function currentTaskFlows() {
    const index = indexedTimeline();
    const inputs = [index, index.flowRevision, state.taskFlows,
      state.childAgents, state.workflows, t("ui.verification")];
    if (taskFlowSnapshot && inputs.every((value, index) => value === taskFlowSnapshot.inputs[index])) {
      return taskFlowSnapshot.flows;
    }
    const flows = new Map(index.flows);
    for (const savedFlow of state.taskFlows || []) {
      for (const flow of extractTaskFlows("```task-flow\n" + JSON.stringify(savedFlow) + "\n```").flows) flows.set(flow.id, flow);
    }
    // Announced task lists keep their announced order; every other card is ordered by its dispatch time below.
    const announced = new Set(index.flows.keys());
    for (const flow of flows.values()) if (!validDispatchTime(flow.dispatchedAt)) announced.add(flow.id);
    const dispatchTimes = new Map();
    // Runtime-accepted task metadata is authoritative even when commentary is absent.
    for (const agent of state.childAgents.slice().reverse()) {
      const binding = agent.taskBinding;
      if (!acceptedTaskAgent(agent) || !binding) continue;
      const task = { id: binding.taskId, title: binding.title, description: binding.description,
        status: agent.status === "completed" ? "pending" : agent.status === "needs-human-decision" ? "blocked" :
          ["failed", "cancelled"].includes(agent.status) ? agent.status : agent.status === "running" ? (agent.role === "verification" ? "verifying" : "running") : "pending",
        agentId: agent.agentId, runId: agent.runId, sessionRole: agent.role };
      if (recordedWorkProfile(agent.workProfile)) task.workProfile = agent.workProfile;
      if (typeof binding.completionCriteria === "string") task.description += "\n\n" + binding.completionCriteria;
      const candidate = { id: binding.workflowId, title: binding.workflowTitle, tasks: [task] };
      if (!extractTaskFlows("```task-flow\n" + JSON.stringify(candidate) + "\n```").flows.length) continue;
      // The earliest accepted run of a card without a loop is its dispatch; `updatedAt` moves while runs execute.
      if (validDispatchTime(agent.dispatchedAt) && !(dispatchTimes.get(candidate.id) <= agent.dispatchedAt)) dispatchTimes.set(candidate.id, agent.dispatchedAt);
      const existing = flows.get(candidate.id);
      const flow = existing ? { ...existing, tasks: [...existing.tasks] } : { ...candidate, tasks: [] };
      const index = flow.tasks.findIndex(entry => entry.id === task.id);
      if (index < 0) flow.tasks.push(task);
      else {
        const previous = flow.tasks[index];
        flow.tasks[index] = { ...task, status: previous.status === "completed" && previous.runId === task.runId ? "completed" : task.status };
      }
      flows.set(flow.id, flow);
    }
    for (const snapshot of state.workflows || []) {
      const workflow = snapshot.workflow;
      if (!workflow || !Array.isArray(workflow.tasks)) continue;
      const verification = ["work-verification", "plan-work-verification"].includes(snapshot.taskMode);
      const tasks = workflow.tasks.flatMap((task, index) => {
        const description = [task.description, task.completionCriteria].filter(Boolean).join("\n\n");
        const stages = [{ id: verification ? "stage-" + index + ".work" : task.id, taskId: task.id, title: task.title, description, status: task.workStatus, sessionAgentId: task.workAgentId || snapshot.workAgentId, sessionRunId: task.workRunId, sessionRole: "work",
          ...(recordedWorkProfile(snapshot.workProfile) ? { workProfile: snapshot.workProfile } : {}) }];
        if (verification) stages.push({ id: "stage-" + index + ".verification", taskId: task.id, title: String(task.title).slice(0, 280) + " · " + t("ui.verification"), description, status: task.verificationStatus === "running" ? "verifying" : task.verificationStatus, sessionAgentId: task.verificationAgentId || snapshot.verificationAgentId, sessionRunId: task.verificationRunId, sessionRole: "verification" });
        return stages;
      });
      const candidate = { id: workflow.id, title: workflow.title, tasks };
      if (!extractTaskFlows("```task-flow\n" + JSON.stringify(candidate) + "\n```").flows.length) continue;
      const pause = revisionLimitPause(snapshot);
      flows.set(workflow.id, { ...candidate, engine: true, loopId: snapshot.loopId, workAgentId: snapshot.workAgentId, closable: snapshot.status === "runtime-error",
        ...(pause ? { pause } : {}) });
      // A loop's start outlives its revisions and repair runs, so it wins over any single run's time.
      if (validDispatchTime(snapshot.dispatchedAt)) dispatchTimes.set(workflow.id, snapshot.dispatchedAt);
    }
    const result = orderTaskFlows([...flows.values()], announced, dispatchTimes);
    taskFlowSnapshot = { inputs, flows: result };
    return result;
  }
  function validDispatchTime(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value);
  }
  // Announced flows stay first in their announced order. Dispatched cards follow, oldest dispatch first with the
  // flow identifier as tie-break; the time is kept on the flow so a restored panel orders them the same way.
  function orderTaskFlows(flows, announced, dispatchTimes) {
    const dispatched = [];
    const ordered = [];
    for (const flow of flows) {
      if (announced.has(flow.id)) { ordered.push(flow); continue; }
      const dispatchedAt = dispatchTimes.get(flow.id) || flow.dispatchedAt;
      if (!validDispatchTime(dispatchedAt)) { ordered.push(flow); continue; }
      dispatched.push(flow.dispatchedAt === dispatchedAt ? flow : { ...flow, dispatchedAt });
    }
    dispatched.sort((left, right) => left.dispatchedAt < right.dispatchedAt ? -1 : left.dispatchedAt > right.dispatchedAt ? 1
      : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return [...ordered, ...dispatched];
  }
  // The runtime's structured stop on the revision limit, reduced to what the decision view shows.
  function revisionLimitPause(snapshot) {
    const pause = snapshot.pause;
    if (!pause || pause.code !== "revision_limit_reached" || snapshot.status !== "needs-human-decision") return undefined;
    const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
    if (!validId(snapshot.loopId) || !validId(snapshot.workAgentId)) return undefined;
    const count = value => Number.isInteger(value) && value >= 0 ? value : undefined;
    const text = value => typeof value === "string" ? value : "";
    const summaries = new Map((Array.isArray(pause.findings) ? pause.findings : []).filter(finding => finding && typeof finding.id === "string")
      .map(finding => [finding.id, finding]));
    const ids = (Array.isArray(pause.pendingFindingIds) ? pause.pendingFindingIds : []).filter(id => typeof id === "string" && id).slice(0, 100);
    const current = snapshot.workflow.tasks[Number.isInteger(snapshot.workflow.index) ? snapshot.workflow.index : 0];
    return { taskId: current?.id, revisionCount: count(pause.revisionCount), maxRevisions: count(pause.maxRevisions),
      findings: ids.map(id => ({ id, path: text(summaries.get(id)?.path), problem: text(summaries.get(id)?.problem) })) };
  }
  function liveTaskStatus(task) {
    let status = task.status;
    const agent = task.agentId && task.runId && state.childAgents.find(agent => agent.agentId === task.agentId && agent.runId === task.runId);
    if (agent && status !== "completed") {
      if (["failed", "cancelled"].includes(agent.status)) status = agent.status;
      else if (agent.status === "needs-human-decision") status = "blocked";
      else if (agent.status === "running") status = agent.role === "verification" ? "verifying" : "running";
      // A finished child is not proof that the whole task passed verification.
      else if (["running", "verifying"].includes(status)) status = "pending";
    }
    return status;
  }
  function summarizeTaskFlow(flow, live) {
    const groups = new Map();
    const assignments = { workLight: new Set(), work: new Set(), unrecorded: new Set() };
    for (const task of flow.tasks) {
      const id = task.taskId || task.id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(task);
      const worker = task.sessionAgentId || task.agentId;
      if (worker && task.sessionRole !== "verification") {
        assignments[workProfileForTask(task) || "unrecorded"].add(worker);
      }
    }
    const counts = { pending: 0, running: 0, verifying: 0, completed: 0, blocked: 0, failed: 0, cancelled: 0 };
    const current = [];
    const statusOf = task => live ? liveTaskStatus(task) : task.status;
    for (const stages of groups.values()) {
      const work = stages.find(task => task.sessionRole !== "verification") || stages[0];
      const verification = stages.find(task => task.sessionRole === "verification");
      // A finished Work stage still waits for its selected Verification stage.
      const selected = statusOf(work) === "completed" && verification ? verification : work;
      const status = statusOf(selected);
      if (Object.hasOwn(counts, status)) counts[status] += 1;
      if (["running", "verifying"].includes(status)) current.push(t("flow.summary.current.task", work.title, t("flow.status." + status)));
    }
    return { total: groups.size,
      assignments: Object.fromEntries(Object.entries(assignments).map(([profile, agents]) => [profile, agents.size])), counts, current };
  }
  function recordedWorkProfile(value) {
    return value === "work" || value === "workLight" ? value : undefined;
  }
  function workProfileForTask(task) {
    const agentId = task.sessionAgentId || task.agentId;
    const runId = task.sessionRunId || task.runId;
    const agent = state.childAgents.find(candidate => candidate.role === "work" && candidate.agentId === agentId &&
      (!runId || candidate.runId === runId));
    // Only the profile Main recorded at dispatch (on the run, else the loop) counts. Both profiles can share
    // settings and settings change later, so a task without a record is shown as "no record", never guessed.
    return recordedWorkProfile(agent?.workProfile) || recordedWorkProfile(task.workProfile);
  }
  function taskHasActiveWorker(task) {
    const agentId = task.sessionAgentId || task.agentId;
    const runId = task.sessionRunId || task.runId;
    if (!agentId || !runId) return false;
    return state.childAgents.some(agent => agent.agentId === agentId && agent.runId === runId &&
      agent.status === "running" && acceptedTaskAgent(agent));
  }
  function createSingleTaskFlowCard(flow, stages, live) {
    const work = stages.find(task => task.sessionRole !== "verification") || stages[0];
    const verification = stages.find(task => task.sessionRole === "verification");
    const selected = liveTaskStatus(work) === "completed" && verification ? verification : work;
    const status = live ? liveTaskStatus(selected) : selected.status;
    const disclosure = document.createElement("details");
    disclosure.className = "task-flow-single";
    disclosure.dataset.status = status;
    disclosure.dataset.taskId = work.taskId || work.id;
    disclosure.dataset.workerActive = String(taskHasActiveWorker(selected));
    if (work.sessionRunId || work.runId) disclosure.dataset.runId = work.sessionRunId || work.runId;
    if (["running", "verifying"].includes(status)) disclosure.setAttribute("aria-current", "step");
    const summary = document.createElement("summary");
    const heading = document.createElement("span");
    heading.className = "task-flow-single-heading";
    const title = document.createElement("strong");
    title.className = "task-flow-single-title";
    title.textContent = work.title;
    title.title = work.title;
    const label = document.createElement("span");
    label.className = "task-flow-state";
    label.textContent = t("flow.status." + status);
    heading.append(title, label);
    const assignments = document.createElement("span");
    assignments.className = "task-flow-assignments";
    const dispatched = Boolean(work.sessionAgentId || work.agentId);
    const assignedProfile = dispatched ? workProfileForTask(work) : undefined;
    for (const profile of ["workLight", "work"]) {
      const assigned = assignedProfile === profile;
      const badge = document.createElement("span");
      badge.className = "task-flow-assignment";
      badge.dataset.assigned = String(assigned);
      badge.textContent = t("flow.assignment." + (profile === "workLight" ? "worker" : "expert") + "." + (assigned ? "assigned" : "unassigned"));
      assignments.append(badge);
    }
    if (dispatched && !assignedProfile) {
      // A dispatched task whose profile was never recorded: say so instead of marking either profile.
      const badge = document.createElement("span");
      badge.className = "task-flow-assignment";
      badge.dataset.assigned = "false";
      badge.dataset.unrecorded = "true";
      badge.textContent = t("flow.assignment.unrecorded");
      assignments.append(badge);
    }
    summary.append(heading, assignments);
    disclosure.append(summary);
    const detail = document.createElement("div");
    detail.className = "task-flow-detail";
    if (work.description) {
      const descriptionBlock = document.createElement("div");
      descriptionBlock.className = "task-flow-description";
      const detailHeading = document.createElement("strong");
      detailHeading.textContent = t("flow.request.details");
      const description = document.createElement("div");
      description.textContent = work.description;
      descriptionBlock.append(detailHeading, description);
      detail.append(descriptionBlock);
    }
    for (const task of stages) {
      const agentId = task.sessionAgentId || task.agentId;
      const runId = task.sessionRunId || task.runId;
      const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
      if (!validId(agentId) || !validId(runId)) continue;
      const agent = state.childAgents.find(candidate => candidate.agentId === agentId && candidate.runId === runId && acceptedTaskAgent(candidate));
      if (!task.sessionRunId && !agent) continue;
      const role = task.sessionRole || agent?.role;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "task-flow-open setting-button";
      const profile = role === "verification" ? undefined : workProfileForTask(task);
      open.textContent = role === "verification" ? t("flow.open.verification.session")
        : profile ? t(profile === "workLight" ? "flow.open.work.session" : "flow.open.expert.session")
        : t("flow.assignment.unrecorded") + t("ui.open.session");
      open.setAttribute("aria-label", work.title + " · " + open.textContent);
      open.title = agentId;
      open.addEventListener("click", function () { vscode.postMessage({ type: "agent.open", agentId }); });
      detail.append(open);
    }
    if (detail.childElementCount) disclosure.append(detail);
    return disclosure;
  }
  function createTaskFlow(flow, live = false) {
    const section = document.createElement("section");
    section.className = "task-flow";
    section.dataset.flowId = flow.id;
    section.setAttribute("aria-label", flow.title);
    const totals = summarizeTaskFlow(flow, live);
    const logicalTasks = new Map();
    for (const task of flow.tasks) {
      const id = task.taskId || task.id;
      if (!logicalTasks.has(id)) logicalTasks.set(id, []);
      logicalTasks.get(id).push(task);
    }
    const decision = live && flow.pause && state.role === "main";
    if (live && totals.total === 1) {
      section.classList.add("task-flow-single-container");
      section.append(createSingleTaskFlowCard(flow, logicalTasks.values().next().value, live));
      if (decision) section.append(createRevisionLimitDecision(flow, flow.tasks[0].title));
      return section;
    }
    const title = document.createElement("strong");
    title.textContent = flow.title;
    section.append(title);
    if (live && flow.closable && state.role === "main") {
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = t("flow.close.failed");
      close.addEventListener("click", () => {
        vscode.postMessage({ type: "workflow.close", workAgentId: flow.workAgentId, loopId: flow.loopId });
      });
      section.append(close);
    }
    const summary = document.createElement("div");
    summary.className = "task-flow-summary";
    summary.setAttribute("role", "group");
    summary.setAttribute("aria-label", t("flow.summary.label"));
    const size = document.createElement("strong");
    size.className = "task-flow-total";
    size.textContent = t("flow.task.count", totals.total);
    const assignments = document.createElement("span");
    assignments.className = "task-flow-assignments task-flow-summary-assignments";
    for (const profile of ["workLight", "work"]) {
      const count = totals.assignments[profile];
      const badge = document.createElement("span");
      badge.className = "task-flow-assignment";
      badge.dataset.assigned = String(count > 0);
      badge.textContent = count > 0
        ? t("flow.assignment." + (profile === "workLight" ? "worker" : "expert") + ".count", count)
        : t("flow.assignment." + (profile === "workLight" ? "worker" : "expert") + ".unassigned");
      assignments.append(badge);
    }
    if (totals.assignments.unrecorded > 0) {
      const badge = document.createElement("span");
      badge.className = "task-flow-assignment";
      badge.dataset.assigned = "false";
      badge.dataset.unrecorded = "true";
      badge.textContent = t("flow.assignment.unrecorded.count", totals.assignments.unrecorded);
      assignments.append(badge);
    }
    summary.append(size, assignments);
    for (const [status, count] of Object.entries(totals.counts)) {
      if (count === 0) continue;
      const metric = document.createElement("span");
      metric.dataset.summaryStatus = status;
      metric.textContent = t("flow.summary.count", t("flow.status." + status), count);
      summary.append(metric);
    }
    const current = document.createElement("p");
    current.className = "task-flow-current";
    current.textContent = totals.current.length ? t("flow.summary.current", totals.current.join(" · ")) : t("flow.summary.current.none");
    if (live) {
      current.setAttribute("role", "status");
      current.setAttribute("aria-live", "polite");
      current.setAttribute("aria-atomic", "true");
    }
    section.append(summary, current);
    if (decision) {
      const paused = flow.tasks.find(task => (task.taskId || task.id) === flow.pause.taskId) || flow.tasks[0];
      section.append(createRevisionLimitDecision(flow, paused.title));
    }
    const list = document.createElement("ol");
    list.className = "task-flow-list";
    flow.tasks.forEach(function (task, index) {
      const status = live ? liveTaskStatus(task) : task.status;
      const item = document.createElement("li");
      item.className = "task-flow-step";
      item.dataset.status = status;
      item.dataset.taskId = task.taskId || task.id;
      item.dataset.workerActive = String(taskHasActiveWorker(task));
      if (task.sessionRunId || task.runId) item.dataset.runId = task.sessionRunId || task.runId;
      if (["running", "verifying"].includes(status)) item.setAttribute("aria-current", "step");
      const disclosure = document.createElement("details");
      disclosure.className = "task-flow-disclosure";
      const taskSummary = document.createElement("summary");
      const marker = document.createElement("span");
      marker.className = "task-flow-number";
      marker.textContent = String(index + 1);
      const name = document.createElement("span");
      name.className = "task-flow-name";
      name.textContent = task.title;
      name.title = task.title;
      const label = document.createElement("span");
      label.className = "task-flow-state";
      label.textContent = t("flow.status." + status);
      taskSummary.append(marker, name, label);
      disclosure.append(taskSummary);
      const detail = document.createElement("div");
      detail.className = "task-flow-detail";
      if (task.description) {
        const descriptionBlock = document.createElement("div");
        descriptionBlock.className = "task-flow-description";
        const heading = document.createElement("strong");
        heading.textContent = t("flow.request.details");
        const description = document.createElement("div");
        description.textContent = task.description;
        descriptionBlock.append(heading, description);
        detail.append(descriptionBlock);
      }
      const agentId = task.sessionAgentId || task.agentId;
      const runId = task.sessionRunId || task.runId;
      const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
      if (validId(agentId) && validId(runId)) {
        const agent = state.childAgents.find(agent => agent.agentId === agentId && agent.runId === runId && acceptedTaskAgent(agent));
        if (task.sessionRunId || agent) {
          const role = task.sessionRole || agent?.role;
          const open = document.createElement("button");
          open.type = "button";
          open.className = "task-flow-open setting-button";
          const profile = role === "verification" ? undefined : workProfileForTask(task);
          open.textContent = role === "verification" ? t("flow.open.verification.session")
            : profile ? t(profile === "workLight" ? "flow.open.work.session" : "flow.open.expert.session")
            : t("flow.assignment.unrecorded") + t("ui.open.session");
          open.setAttribute("aria-label", task.title + " · " + open.textContent);
          open.title = agentId;
          open.addEventListener("click", function () { vscode.postMessage({ type: "agent.open", agentId }); });
          detail.append(open);
        }
      }
      if (detail.childElementCount) disclosure.append(detail);
      item.append(disclosure);
      list.append(item);
    });
    section.append(list);
    return section;
  }
  // A loop stopped on its revision limit: what was tried, what remains, and the Human's two decisions.
  function createRevisionLimitDecision(flow, taskTitle) {
    const pause = flow.pause;
    const view = document.createElement("div");
    view.className = "task-flow-decision";
    view.dataset.loopId = flow.loopId;
    view.setAttribute("role", "group");
    const heading = document.createElement("strong");
    heading.className = "task-flow-decision-title";
    heading.textContent = t("flow.decision.title");
    const used = document.createElement("span");
    used.className = "task-flow-decision-revisions";
    used.textContent = pause.maxRevisions === undefined ? t("flow.decision.revisions.used", pause.revisionCount ?? 0)
      : t("flow.decision.revisions", pause.revisionCount ?? pause.maxRevisions, pause.maxRevisions);
    const remaining = document.createElement("span");
    remaining.className = "task-flow-decision-count";
    remaining.textContent = t("flow.decision.findings", pause.findings.length);
    const header = document.createElement("div");
    header.className = "task-flow-decision-header";
    header.append(heading, used, remaining);
    view.setAttribute("aria-label", taskTitle + " · " + heading.textContent);
    view.append(header);
    if (pause.findings.length) {
      const list = document.createElement("ul");
      list.className = "task-flow-decision-findings";
      for (const finding of pause.findings) {
        const item = document.createElement("li");
        const id = document.createElement("code");
        id.className = "task-flow-decision-finding-id";
        id.textContent = finding.id;
        item.append(id);
        // The identifier never wraps; its path and problem go below it.
        for (const [className, text] of [["task-flow-decision-finding-path", finding.path], ["task-flow-decision-finding-problem", finding.problem]]) {
          if (!text) continue;
          const detail = document.createElement("span");
          detail.className = className;
          detail.textContent = text;
          item.append(detail);
        }
        list.append(item);
      }
      view.append(list);
    }
    const actions = document.createElement("div");
    actions.className = "task-flow-decision-actions";
    const pending = workflowDecisionsPending.has(flow.loopId);
    for (const decision of ["continue", "stop"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "task-flow-decision-action setting-button";
      button.dataset.decision = decision;
      button.textContent = decision === "continue" ? t("flow.decision.continue") : t("flow.decision.stop");
      button.title = decision === "continue" ? t("flow.decision.continue.detail", REVISION_LIMIT_EXTENSION) : t("flow.decision.stop.detail");
      button.setAttribute("aria-label", taskTitle + " · " + button.textContent);
      button.disabled = pending;
      button.addEventListener("click", function () {
        if (workflowDecisionsPending.has(flow.loopId)) return;
        workflowDecisionsPending.add(flow.loopId);
        for (const action of actions.querySelectorAll("button")) action.disabled = true;
        vscode.postMessage({ type: "workflow.decision", workAgentId: flow.workAgentId, loopId: flow.loopId, decision });
      });
      actions.append(button);
    }
    view.append(actions);
    return view;
  }
  // A failed decision command leaves the loop stopped: offer both actions again.
  function releaseWorkflowDecisions() {
    if (!workflowDecisionsPending.size) return;
    workflowDecisionsPending.clear();
    delete runStageList.dataset.flowSignature;
    renderWorkLoopPanel();
  }
  function createTaskHistoryEntry(flow) {
    const item = document.createElement("li");
    const disclosure = document.createElement("details");
    disclosure.className = "task-history-disclosure";
    disclosure.dataset.historyId = flow.id;
    const heading = document.createElement("summary");
    const name = document.createElement("span");
    name.className = "task-history-name";
    name.textContent = flow.title;
    const count = document.createElement("span");
    count.className = "task-history-count";
    count.textContent = t("flow.task.count", summarizeTaskFlow(flow, true).total);
    heading.append(name, count);
    disclosure.append(heading, createTaskFlow(flow, true));
    item.append(disclosure);
    return item;
  }
  function acceptedTaskAgent(agent) {
    return Boolean(agent.runId) && ["accepted", "queued", "starting", "running", "cancelling", "needs-human-decision", "completed", "failed", "cancelled"].includes(agent.status);
  }
  function displayTaskFlows() {
    const agents = state.childAgents.filter(acceptedTaskAgent);
    const flows = currentTaskFlows().filter(flow => {
      if (flow.engine) return true;
      const bound = agents.filter(agent => flow.tasks.some(task => task.agentId === agent.agentId && task.runId === agent.runId));
      if (!bound.length) return false;
      // A cached plan is not a live workflow after its accepted runs have ended.
      // Keep explicit terminal flow snapshots; unresolved legacy plans remain in chat.
      return bound.some(agent => !["completed", "failed", "cancelled"].includes(agent.status)) ||
        flow.tasks.every(task => ["completed", "failed", "cancelled"].includes(task.status));
    });

    return flows;
  }
  function unfinishedFlow(flow) {
    return flow.tasks.some(task => ["pending", "running", "verifying", "blocked"].includes(liveTaskStatus(task)));
  }
  function renderWorkLoopPanel() {
    const contractList = document.getElementById("contract-list");
    const flows = displayTaskFlows();
    const active = flows.filter(unfinishedFlow);
    const history = flows.filter(flow => !unfinishedFlow(flow));
    const boundRuns = new Set(flows.flatMap(flow => flow.tasks.map(task => task.agentId + "/" + task.runId)));
    const legacyHistory = state.childAgents.filter(agent => acceptedTaskAgent(agent) &&
      ["completed", "failed", "cancelled"].includes(agent.status) && !boundRuns.has(agent.agentId + "/" + agent.runId) &&
      !(state.workflows || []).some(snapshot => snapshot.workflow?.id === agent.taskBinding?.workflowId));
    const historyPanel = document.getElementById("task-history");
    const historyList = document.getElementById("task-history-list");
    contractList.hidden = state.role !== "main";
    if (contractList.hidden) contractList.open = false;
    historyPanel.hidden = state.role !== "main";
    document.getElementById("question-tab-history").hidden = state.role !== "main";
    if (state.role !== "main" && document.getElementById("question-tab-history").getAttribute("aria-selected") === "true") {
      selectQuestionTab("questions", false, false);
    }
    if (historyPanel.hidden) historyPanel.open = false;
    const historySignature = JSON.stringify([history, state.childAgents, t("flow.status.pending")]);
    if (historyList.dataset.signature !== historySignature) {
      historyList.dataset.signature = historySignature;
      const expanded = new Set(Array.from(historyList.querySelectorAll(".task-history-disclosure[open]"), item => item.dataset.historyId));
      const list = document.createElement("ul");
      list.className = "task-history-entries";
      list.append(...history.map(createTaskHistoryEntry), ...legacyHistory.map(agent => {
        const item = document.createElement("li");
        item.append(createRunStage(agent));
        return item;
      }));
      for (const item of list.querySelectorAll(".task-history-disclosure")) item.open = expanded.has(item.dataset.historyId);
      historyList.replaceChildren(history.length || legacyHistory.length ? list : historyEmpty("ui.task.history.empty"));
    }
    const hasActive = active.length > 0;
    if (hasActive && runDetails.dataset.hasActive !== "true") state.runPanelExpanded = true;
    runDetails.dataset.hasActive = String(hasActive);
    if (!hasActive) {
      state.runPanelExpanded = false;
      runStageList.replaceChildren();
      delete runStageList.dataset.flowSignature;
    }
    const expandable = state.role === "main" && hasActive;
    const expanded = expandable && state.runPanelExpanded && !runStatus.hidden;
    runStatusToggle.disabled = !expandable;
    runStatusToggle.setAttribute("aria-expanded", String(expanded));
    runStatus.classList.toggle("is-expanded", expanded);
    const hasRunningStage = active.some(flow => flow.tasks.some(task =>
      ["running", "verifying"].includes(liveTaskStatus(task))));
    runStatus.classList.toggle("is-running", state.running || hasRunningStage);
    runDetails.hidden = !expanded;
    runStatusAgents.hidden = !expandable || state.workUnits.activeUnits === 0;
    runStatusAgents.textContent = state.workUnits.activeUnits > 0
      ? t("status.runningAgents", state.workUnits.workActive, state.workUnits.verificationActive) : "";
    if (!expanded) return;
    runDetailsSummary.textContent = active.length ? t("flow.task.count", active.reduce((sum, flow) => sum + summarizeTaskFlow(flow, true).total, 0)) : t("ui.preparing");
    const signature = JSON.stringify([active, state.childAgents, t("flow.status.pending")]);
    runStopButton.hidden = !state.running;
    if (runStageList.dataset.flowSignature === signature) return;
    const expandedTasks = new Set(Array.from(runStageList.querySelectorAll(".task-flow-disclosure[open], .task-flow-single[open]"), item => {
      const task = item.closest("[data-task-id]");
      const flow = item.closest(".task-flow");
      return flow?.dataset.flowId + "/" + task?.dataset.taskId;
    }));
    runStageList.dataset.flowSignature = signature;
    runStageList.replaceChildren(...active.map(flow => createTaskFlow(flow, true)));
    for (const item of runStageList.querySelectorAll(".task-flow-disclosure, .task-flow-single")) {
      const task = item.closest("[data-task-id]");
      const flow = item.closest(".task-flow");
      item.open = expandedTasks.has(flow?.dataset.flowId + "/" + task?.dataset.taskId);
    }
  }
  function childTaskName(agent) {
    const title = agent.taskBinding?.title;
    if (typeof title === "string" && title.trim()) return title;
    // Historical Main snapshots are usable only with the exact accepted run binding.
    if (agent.runId) {
      const flows = currentTaskFlows();
      for (const flow of flows) {
        const task = flow.tasks.find(task => task.agentId === agent.agentId && task.runId === agent.runId);
        if (task) return task.title;
      }
    }
    return t("ui.task.name.unavailable");
  }
  function createRunStage(agent) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "run-stage";
    item.dataset.status = agent.status;
    item.title = agent.agentId + t("ui.open.session");
    const marker = document.createElement("span");
    marker.className = "run-stage-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = childAgentStatusMarker(agent.status);
    const copy = document.createElement("span");
    copy.className = "run-stage-copy";
    const name = document.createElement("span");
    name.className = "run-stage-name";
    name.textContent = agent.role === "work" ? t("ui.work") : t("ui.verification");
    const id = document.createElement("span");
    id.className = "run-stage-id";
    id.textContent = childTaskName(agent);
    copy.append(name, id);
    const status = document.createElement("span");
    status.className = "run-stage-status";
    status.textContent = childAgentStatusLabel(agent.status);
    item.append(marker, copy, status);
    item.addEventListener("click", function () {
      vscode.postMessage({ type: "agent.open", agentId: agent.agentId });
    });
    return item;
  }
  function countChildAgents(role) {
    return state.childAgents.filter(function (agent) { return agent.role === role; }).length;
  }
  function childAgentStatusMarker(status) {
    if (status === "completed") return "✓";
    if (status === "failed" || status === "cancelled") return "×";
    if (status === "needs-human-decision") return "!";
    return "●";
  }

  return {
    renderWorkLoopPanel, currentTaskFlows, workflowDecisionsPending, extractTaskFlows,
    releaseWorkflowDecisions, taskFlowParseCache, createTaskFlow, displayTaskFlows, unfinishedFlow,
    childTaskName
  };
};
