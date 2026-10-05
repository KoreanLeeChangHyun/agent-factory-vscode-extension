globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.taskFlow = function (host) {
  "use strict";

  const {
    indexedTimeline, state, t, vscode, runStageList, selectQuestionTab, historyEmpty, runDetails,
    runStatus, runStatusToggle, runStatusAgents,
    childAgentStatusLabel, persist
  } = host;

  const taskFlowParseCache = new WeakMap();
  let taskFlowSnapshot;
  // Loops whose revision-limit decision was clicked and is not answered by the host yet.
  const workflowDecisionsPending = new Set();
  const taskStopsPending = new Set();
  const taskStopErrors = new Map();
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
        status: agent.status === "completed" ? "completed" : agent.status === "needs-human-decision" ? "blocked" :
          ["failed", "cancelled"].includes(agent.status) ? agent.status : agent.status === "running" ? (agent.role === "verification" ? "verifying" : "running") : "pending",
        agentId: agent.agentId, runId: agent.runId, sessionRole: agent.role,
        ...(typeof agent.model === "string" && agent.model.trim() ? { model: agent.model } : {}) };
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
        const description = [task.description, task.completionCriteria, task.workspaceSummary].filter(Boolean).join("\n\n");
        const stages = [{ id: verification ? "stage-" + index + ".work" : task.id, taskId: task.id, title: task.title, description, status: task.workStatus, sessionAgentId: task.workAgentId || snapshot.workAgentId, sessionRunId: task.workRunId, sessionRole: "work",
          ...(typeof task.workModel === "string" ? { model: task.workModel } : {}),
          ...(recordedWorkProfile(task.workProfile || snapshot.workProfile) ? { workProfile: task.workProfile || snapshot.workProfile } : {}) }];
        if (verification) stages.push({ id: "stage-" + index + ".verification", taskId: task.id, title: String(task.title).slice(0, 280) + " · " + t("ui.verification"), description, status: task.verificationStatus === "running" ? "verifying" : task.verificationStatus, sessionAgentId: task.verificationAgentId || snapshot.verificationAgentId, sessionRunId: task.verificationRunId, sessionRole: "verification",
          ...(typeof task.verificationModel === "string" ? { model: task.verificationModel } : {}) });
        return stages;
      });
      const candidate = { id: workflow.id, title: workflow.title, tasks };
      if (!extractTaskFlows("```task-flow\n" + JSON.stringify(candidate) + "\n```").flows.length) continue;
      const pause = revisionLimitPause(snapshot);
      flows.set(workflow.id, { ...candidate, engine: true, loopId: snapshot.loopId, workAgentId: snapshot.workAgentId, closable: snapshot.status === "runtime-error", engineStatus: snapshot.status, stopPending: snapshot.stopPending === true,
        ...(snapshot.status === "needs-human-decision" && (workflow.tasks.length === 1 || Number.isInteger(workflow.index))
          ? { decisionTaskId: workflow.tasks[workflow.index ?? 0]?.id } : {}),
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
      runId && candidate.runId === runId);
    // Only the profile Main recorded at dispatch (on the run, else the loop) counts. Both profiles can share
    // settings and settings change later, so a task without a record is shown as "no record", never guessed.
    return recordedWorkProfile(agent?.workProfile) || recordedWorkProfile(task.workProfile);
  }
  // Identity comes from this exact accepted run, never from the next composer settings.
  // `stage` places the tag and model in the worker or verifier column; `running` animates the model like Main's.
  function appendTaskIdentity(summary, task, stage = "work", running = false) {
    summary.classList.add("task-flow-row");
    const agentId = task.sessionAgentId || task.agentId;
    const runId = task.sessionRunId || task.runId;
    const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
    const agent = validId(runId) && state.childAgents.find(candidate => candidate.agentId === agentId &&
      candidate.runId === runId && acceptedTaskAgent(candidate));
    const profile = workProfileForTask(task);
    const role = task.sessionRole || agent?.role;
    // Expert and worker tags are plain labels (their session opens from the row icon); only the verifier tag opens a chat.
    const canOpen = state.role === "main" && (stage === "verification" || role === "verification") &&
      validId(agentId) && validId(runId) && Boolean(task.sessionRunId || agent);
    const assignment = document.createElement(canOpen ? "button" : "span");
    assignment.className = "task-flow-assignment task-flow-agent";
    assignment.dataset.assigned = String(Boolean(agentId && (profile || role === "verification")));
    const key = stage === "verification" || role === "verification" ? "ui.verification" : !agentId ? "flow.role.unassigned"
      : profile ? "flow.role." + (profile === "workLight" ? "worker" : "expert") : "flow.role.unavailable";
    assignment.textContent = t(key);
    assignment.title = agentId || assignment.textContent;
    if (agentId && role !== "verification" && !profile) assignment.dataset.unrecorded = "true";
    // A subtle text tint distinguishes the recorded role; the label still carries the meaning.
    if (agentId && (role === "verification" || profile)) assignment.dataset.agentRole = role === "verification" ? "verifier" : profile === "workLight" ? "worker" : "expert";
    if (canOpen) {
      assignment.type = "button";
      assignment.setAttribute("aria-label", task.title + " · " + assignment.textContent + t("ui.open.session"));
      assignment.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        vscode.postMessage({ type: "agent.open", agentId, runId });
      });
    }
    const model = document.createElement("span");
    model.className = "task-flow-model";
    const captured = agent?.model || (task.sessionRunId ? task.model : undefined);
    model.textContent = typeof captured === "string" && captured.trim() ? captured : t("flow.model.unavailable");
    model.title = model.textContent;
    assignment.dataset.stage = model.dataset.stage = stage;
    model.dataset.running = String(running);
    // A stage whose run has not started yet (a Verification awaiting its Work) is shown dimmed.
    if (!runId) {
      assignment.dataset.waiting = model.dataset.waiting = "true";
      model.textContent = "—";
    }
    summary.append(assignment, model);
  }
  function taskStageAgent(task) {
    const agentId = task.sessionAgentId || task.agentId;
    const runId = task.sessionRunId || task.runId;
    return agentId && runId ? state.childAgents.find(agent => agent.agentId === agentId && agent.runId === runId) : undefined;
  }
  function taskStageRunning(task, flow) {
    return ["running", "verifying"].includes(liveTaskStatus(task)) &&
      (taskHasActiveWorker(task, flow) || Boolean(flow.engine && flow.engineStatus === "active" && taskStageAgent(task)));
  }
  // Two lines per task: title | worker | verifier | status | action, then activity | models | steps.
  function appendTaskColumns(summary, flow, stages, selected, label, live) {
    const work = stages.find(task => task.sessionRole !== "verification") || stages[0];
    const verification = stages.find(task => task.sessionRole === "verification");
    appendTaskIdentity(summary, work, "work", live && taskStageRunning(work, flow));
    if (verification) appendTaskIdentity(summary, verification, "verification", live && taskStageRunning(verification, flow));
    summary.append(label);
    if (!live) return;
    // The agent's own record only: its latest commentary line and its to-do list count.
    const agent = taskStageAgent(selected) || taskStageAgent(work);
    // Under the title: the agent's latest commentary line, else the first line of the recorded request.
    const requestLine = typeof work.description === "string"
      ? (work.description.split("\n").map(line => line.replace(/^#+\s*/, "").trim()).find(line => line && line !== work.title.trim() && !/^(Goal|Scope|Done|Report)$/i.test(line)) || "") : "";
    const activityText = (typeof agent?.activity === "string" ? agent.activity.trim() : "") || requestLine;
    if (activityText) {
      const activity = document.createElement("span");
      activity.className = "task-flow-activity";
      activity.textContent = activityText;
      activity.title = activityText;
      activity.setAttribute("aria-label", t("flow.activity.label", activityText));
      summary.append(activity);
    }
    // A task whose agent kept no to-do list is one step: 0/1 until it completes, then 1/1.
    const recorded = agent?.planProgress;
    const progress = recorded && Number.isInteger(recorded.completed) && Number.isInteger(recorded.total) && recorded.total > 0
      ? recorded : { completed: liveTaskStatus(work) === "completed" ? 1 : 0, total: 1 };
    {
      const steps = document.createElement("span");
      steps.className = "task-flow-progress";
      steps.textContent = progress.completed + "/" + progress.total;
      steps.title = t("flow.progress", progress.completed, progress.total);
      steps.setAttribute("aria-label", steps.title);
      summary.append(steps);
    }
  }
  function taskHasActiveWorker(task, flow) {
    if (flow?.engine && flow.engineStatus !== "active") return false;
    const agentId = task.sessionAgentId || task.agentId;
    const runId = task.sessionRunId || task.runId;
    if (!agentId || !runId) return false;
    return state.childAgents.some(agent => agent.agentId === agentId && agent.runId === runId &&
      agent.status === "running" && acceptedTaskAgent(agent));
  }
  // A loop remains the same execution across Work/Verification revisions. Direct runs do not.
  function taskDismissKey(flow, stages) {
    const work = stages.find(task => task.sessionRole !== "verification") || stages[0];
    const agentId = work.sessionAgentId || work.agentId || "";
    const runId = work.sessionRunId || work.runId || "";
    return JSON.stringify([flow.id, work.taskId || work.id,
      flow.loopId ? ["loop", flow.loopId, flow.workAgentId || agentId] : ["run", agentId, runId]]);
  }
  function visibleTaskFlows(flows) {
    const dismissed = new Set(state.dismissedTasks || []);
    return flows.flatMap(flow => {
      const groups = new Map();
      for (const task of flow.tasks) {
        const id = task.taskId || task.id;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(task);
      }
      const tasks = flow.tasks.filter(task => !dismissed.has(taskDismissKey(flow, groups.get(task.taskId || task.id))));
      return tasks.length ? [{ ...flow, tasks, originalTaskCount: groups.size,
        ...(flow.pause && !tasks.some(task => (task.taskId || task.id) === flow.pause.taskId) ? { pause: undefined } : {}) }] : [];
    });
  }
  function createTaskDismiss(flow, stages) {
    return createDismissButton(stages[0].title, [taskDismissKey(flow, stages)]);
  }
  // Delete only hides entries from this conversation's lists; runs, snapshots and Agent history are kept.
  function createDismissButton(title, keys) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-flow-dismiss";
    button.title = t("flow.dismiss.detail");
    button.setAttribute("aria-label", title + " · " + t("flow.dismiss"));
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4");
    icon.append(path);
    button.append(icon);
    button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      state.dismissedTasks = [...new Set([...(state.dismissedTasks || []), ...keys])];
      renderWorkLoopPanel();
      persist();
    });
    return button;
  }
  function taskStopKey(flow, task) { return flow.id + "/" + (task.taskId || task.id); }
  // The stage a stop targets: Verification once Work completed, otherwise Work.
  function taskStopTarget(flow, stages) {
    const work = stages.find(task => task.sessionRole !== "verification") || stages[0];
    const selected = liveTaskStatus(work) === "completed" ? stages.find(task => task.sessionRole === "verification") || work : work;
    const agentId = selected.sessionAgentId || selected.agentId;
    const runId = selected.sessionRunId || selected.runId;
    const agent = state.childAgents.find(agent => agent.agentId === agentId && agent.runId === runId);
    return { work, selected, agentId, runId, agent, key: taskStopKey(flow, work) };
  }
  // A task is active until it ends: queued or running stages, a pending Loop stop, or an unanswered stop request.
  function taskStopActive(flow, stages) {
    const { selected, agent, key } = taskStopTarget(flow, stages);
    return Boolean(flow.stopPending) || taskStopsPending.has(key) || agent?.status === "cancelling" ||
      ["pending", "running", "verifying", "blocked"].includes(liveTaskStatus(selected));
  }
  // One action slot per task: stop while the task is active, delete (hide from the panel) only after it ended.
  // `rowStages` is the row's own stage; `stages` is its whole logical task, which delete hides together.
  function appendTaskAction(container, flow, stages, live, rowStages = stages) {
    if (!live || state.role !== "main") return;
    const controls = document.createElement("span");
    controls.className = "task-flow-stop-controls";
    if (taskStopActive(flow, rowStages)) controls.append(createTaskStop(flow, rowStages));
    else if (!taskStopActive(flow, stages) && (rowStages === stages || !stages.some(stage => taskStopActive(flow, [stage])))) {
      controls.append(createTaskDismiss(flow, stages));
    }
    if (controls.childElementCount) container.append(controls);
    // A stop failure gets its own full-width line below the row, never the narrow action slot.
    const key = taskStopTarget(flow, rowStages).key;
    if (taskStopErrors.has(key)) {
      const error = document.createElement("span");
      error.className = "task-flow-stop-error";
      error.setAttribute("role", "alert"); error.textContent = taskStopErrors.get(key);
      container.append(error);
    }
  }
  // Second-line icon under stop/delete: opens the session of the stage now shown (Verification once Work completed).
  function appendTaskSessionIcon(container, flow, stages, live) {
    if (!live || state.role !== "main") return;
    const { selected, agentId, runId, agent } = taskStopTarget(flow, stages);
    const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
    const canOpen = validId(agentId) && validId(runId) && Boolean(selected.sessionRunId || (agent && acceptedTaskAgent(agent)));
    const control = document.createElement(canOpen ? "button" : "span");
    control.className = "task-flow-session";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const bubble = document.createElementNS("http://www.w3.org/2000/svg", "path");
    bubble.setAttribute("d", "M3 3.5h10a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H7l-3 2.5V11H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1ZM5 7h.01M8 7h.01M11 7h.01");
    icon.append(bubble);
    control.append(icon);
    if (canOpen) {
      control.type = "button";
      const label = stages[0].title + t("ui.open.session");
      control.title = label;
      control.setAttribute("aria-label", label);
      control.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        vscode.postMessage({ type: "agent.open", agentId, runId });
      });
    } else control.setAttribute("aria-hidden", "true");
    container.append(control);
  }
  function createTaskStop(flow, stages) {
    const { work, agentId, runId, agent, key } = taskStopTarget(flow, stages);
    const taskId = work.taskId || work.id;
    const logical = new Set(flow.tasks.map(task => task.taskId || task.id));
    const unsupported = flow.engine ? (flow.originalTaskCount || logical.size) !== 1 : !agent || !["accepted", "queued", "starting", "running", "cancelling"].includes(agent.status);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-flow-stop task-flow-icon-button";
    const stopLabel = t(taskStopsPending.has(key) || agent?.status === "cancelling" ? "flow.stop.pending" : "flow.stop");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const square = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    for (const [name, value] of [["x", "4.5"], ["y", "4.5"], ["width", "7"], ["height", "7"], ["rx", "1"]]) square.setAttribute(name, value);
    icon.append(square);
    button.append(icon);
    button.dataset.label = stopLabel;
    button.disabled = unsupported || taskStopsPending.has(key) || agent?.status === "cancelling";
    button.title = unsupported ? t(flow.engine ? "flow.stop.multi.unsupported" : "flow.stop.unbound") : work.title + " · " + stopLabel;
    button.setAttribute("aria-label", work.title + " · " + stopLabel);
    button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      if (button.disabled || taskStopsPending.has(key)) return;
      taskStopsPending.add(key); taskStopErrors.delete(key);
      button.disabled = true; button.dataset.label = t("flow.stop.pending"); button.setAttribute("aria-label", work.title + " · " + button.dataset.label);
      vscode.postMessage({ type: "task.stop", workflowId: flow.id, taskId,
        ...(flow.engine ? { workAgentId: flow.workAgentId, loopId: flow.loopId } : { agentId, runId }) });
    });
    return button;
  }
  function finishTaskStop(message) {
    const key = message.workflowId + "/" + message.taskId;
    taskStopsPending.delete(key);
    if (message.error) taskStopErrors.set(key, message.error);
    else taskStopErrors.delete(key);
    delete runStageList.dataset.flowSignature;
    renderWorkLoopPanel();
  }
  // Presentation only: preserve the task/loop status and use only this exact run's observed lifecycle.
  function createTaskStatus(task, flow, status, live) {
    const label = document.createElement("span");
    label.className = "task-flow-state";
    label.textContent = t("flow.status." + status);
    if (!live) return label;
    const agentId = task.sessionAgentId || task.agentId;
    const runId = task.sessionRunId || task.runId;
    const agent = agentId && runId && state.childAgents.find(candidate => candidate.agentId === agentId &&
      candidate.runId === runId && acceptedTaskAgent(candidate));
    let observed = status;
    if (["pending", "running", "verifying"].includes(status) &&
      ["accepted", "queued", "starting", "cancelling"].includes(agent?.status)) observed = agent.status;
    if (["pending", "running", "verifying", "blocked"].includes(status) &&
      (agent?.status === "needs-human-decision" || (flow.engineStatus === "needs-human-decision" &&
        (status === "blocked" || flow.decisionTaskId === (task.taskId || task.id))))) {
      observed = "needs-human-decision";
    }
    const verification = (task.sessionRole || agent?.role) === "verification";
    label.dataset.observedStatus = observed;
    label.textContent = t(observed === "completed" && verification ? "flow.display.verification.completed"
      : ["accepted", "queued", "starting", "cancelling", "needs-human-decision"].includes(observed)
        ? "flow.display." + observed : "flow.status." + observed);
    // A row whose run is actually executing uses the workflow header's pulse: breathing core and staggered rings.
    if (["running", "verifying"].includes(observed) && taskStageRunning(task, flow)) {
      const pulse = document.createElement("span");
      pulse.className = "run-status-pulse";
      pulse.setAttribute("aria-hidden", "true");
      label.dataset.pulse = "true";
      label.prepend(pulse);
    }
    const detail = t(observed === "completed" ? "flow.status.detail." + (verification ? "verification.completed" : "completed")
      : "flow.status.detail." + observed);
    label.title = detail;
    label.setAttribute("aria-label", label.textContent + " · " + detail);
    label.setAttribute("role", "status");
    label.setAttribute("aria-live", "polite");
    label.setAttribute("aria-atomic", "true");
    return label;
  }
  function trackDisclosureState(disclosure, summary) {
    summary.setAttribute("aria-expanded", String(disclosure.open));
    disclosure.addEventListener("toggle", () => summary.setAttribute("aria-expanded", String(disclosure.open)));
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
    disclosure.dataset.workerActive = String(taskHasActiveWorker(selected, flow));
    if (work.sessionRunId || work.runId) disclosure.dataset.runId = work.sessionRunId || work.runId;
    if (["running", "verifying"].includes(status)) disclosure.setAttribute("aria-current", "step");
    const summary = document.createElement("summary");
    const title = document.createElement("strong");
    title.className = "task-flow-single-title";
    title.textContent = work.title;
    title.title = work.title;
    const label = createTaskStatus(selected, flow, status, live);
    summary.append(title);
    appendTaskColumns(summary, flow, stages, selected, label, live);
    appendTaskAction(summary, flow, stages, live);
    appendTaskSessionIcon(summary, flow, stages, live);
    disclosure.append(summary);
    trackDisclosureState(disclosure, summary);
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
      open.addEventListener("click", function () { vscode.postMessage({ type: "agent.open", agentId, runId }); });
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
    // Live rows are logical tasks whose Work and Verification share one row; snapshots keep each stage.
    const rows = live ? [...logicalTasks.values()].map(stages => ({ task: stages.find(stage => stage.sessionRole !== "verification") || stages[0], stages }))
      : flow.tasks.map(task => ({ task, stages: [task] }));
    rows.forEach(function ({ task, stages }, index) {
      const verificationStage = stages.find(stage => stage !== task && stage.sessionRole === "verification");
      const selected = live && verificationStage && liveTaskStatus(task) === "completed" ? verificationStage : task;
      const status = live ? liveTaskStatus(selected) : task.status;
      const item = document.createElement("li");
      item.className = "task-flow-step";
      item.dataset.status = status;
      item.dataset.taskId = task.taskId || task.id;
      item.dataset.workerActive = String(taskHasActiveWorker(selected, flow));
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
      const label = createTaskStatus(selected, flow, status, live);
      if (live) {
        taskSummary.append(name);
        appendTaskColumns(taskSummary, flow, stages, selected, label, live);
      } else taskSummary.append(marker, name, label);
      appendTaskAction(taskSummary, flow, stages, live);
      appendTaskSessionIcon(taskSummary, flow, stages, live);
      disclosure.append(taskSummary);
      if (live) trackDisclosureState(disclosure, taskSummary);
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
      for (const stage of stages) {
        const agentId = stage.sessionAgentId || stage.agentId;
        const runId = stage.sessionRunId || stage.runId;
        const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
        if (!validId(agentId) || !validId(runId)) continue;
        const agent = state.childAgents.find(agent => agent.agentId === agentId && agent.runId === runId && acceptedTaskAgent(agent));
        if (!stage.sessionRunId && !agent) continue;
        const role = stage.sessionRole || agent?.role;
        const open = document.createElement("button");
        open.type = "button";
        open.className = "task-flow-open setting-button";
        const profile = role === "verification" ? undefined : workProfileForTask(stage);
        open.textContent = role === "verification" ? t("flow.open.verification.session")
          : profile ? t(profile === "workLight" ? "flow.open.work.session" : "flow.open.expert.session")
          : t("flow.assignment.unrecorded") + t("ui.open.session");
        open.setAttribute("aria-label", task.title + " · " + open.textContent);
        open.title = agentId;
        open.addEventListener("click", function () { vscode.postMessage({ type: "agent.open", agentId, runId }); });
        detail.append(open);
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
  // History rows share the task panel's row: a single task is that very row; a group or another
  // conversation's brief gets a heading with the same chevron, title, meta and status-dot columns.
  function createTaskHistoryEntry(flow) {
    const item = document.createElement("li");
    const totals = summarizeTaskFlow(flow, true);
    if (totals.total === 1) {
      const section = createTaskFlow(flow, true);
      const card = section.querySelector(".task-flow-single");
      if (card) card.dataset.historyId = flow.id;
      item.append(section);
      return item;
    }
    const disclosure = document.createElement("details");
    disclosure.className = "task-history-disclosure";
    disclosure.dataset.historyId = flow.id;
    const status = flowHistoryStatus(totals.counts);
    disclosure.dataset.status = status;
    const heading = historyRowHeading(flow.title, t("flow.task.count", totals.total), status);
    if (state.role === "main") heading.append(createDismissButton(flow.title, taskGroups(flow).map(stages => taskDismissKey(flow, stages))));
    disclosure.append(heading, createTaskFlow(flow, true));
    item.append(disclosure);
    return item;
  }
  function flowHistoryStatus(counts) {
    for (const status of ["running", "verifying", "blocked", "failed", "pending"]) if (counts[status]) return status;
    return counts.completed ? "completed" : counts.cancelled ? "cancelled" : "pending";
  }
  function historyRowHeading(title, meta, status) {
    const heading = document.createElement("summary");
    const name = document.createElement("strong");
    name.className = "task-history-name";
    name.textContent = title;
    name.title = title;
    const count = document.createElement("span");
    count.className = "task-history-count";
    count.textContent = meta;
    count.title = meta;
    const state = document.createElement("span");
    state.className = "task-history-state";
    state.dataset.status = status;
    state.textContent = t("flow.status." + status);
    heading.append(name, count, state);
    return heading;
  }
  // A brief from another conversation of this project: its tasks, statuses and request, without run controls.
  function createProjectHistoryEntry(entry) {
    const item = document.createElement("li");
    const disclosure = document.createElement("details");
    disclosure.className = "task-history-disclosure project-history-entry";
    disclosure.dataset.historyId = entry.id;
    const status = projectTaskStatus(entry.status);
    disclosure.dataset.status = status;
    const meta = [entry.contract ? entry.contract.id + (entry.contract.version ? " v" + entry.contract.version : "") : "",
      entry.tasks.length > 1 ? t("flow.task.count", entry.tasks.length) : ""].filter(Boolean).join(" · ");
    const heading = historyRowHeading(entry.title, meta, status);
    const body = document.createElement("div");
    body.className = "task-flow-detail project-history-detail";
    for (const task of entry.tasks) {
      const description = document.createElement("div");
      description.className = "task-flow-description";
      const title = document.createElement("strong");
      title.textContent = task.title + " · " + t("flow.status." + projectTaskStatus(task.workStatus));
      const text = document.createElement("div");
      text.textContent = task.description || "";
      description.append(title, text);
      body.append(description);
    }
    if (state.role === "main") heading.append(createDismissButton(entry.title, [projectHistoryDismissKey(entry)]));
    disclosure.append(heading, body);
    item.append(disclosure);
    return item;
  }
  function projectHistoryDismissKey(entry) { return JSON.stringify(["project", entry.id]); }
  function projectTaskStatus(status) {
    return { active: "running", running: "running", verifying: "verifying", completed: "completed", cancelled: "cancelled",
      failed: "failed", "runtime-error": "failed", "needs-human-decision": "blocked", blocked: "blocked" }[status] || "pending";
  }
  function renderProjectHistory() {
    delete document.getElementById("task-history-panel").dataset.signature;
    renderWorkLoopPanel();
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
  // A logical task has ended once its shown stage is terminal and no stop for it is still unanswered.
  function taskGroupEnded(flow, stages) {
    const { selected, key } = taskStopTarget(flow, stages);
    return !flow.stopPending && !taskStopsPending.has(key) && ["completed", "failed", "cancelled"].includes(liveTaskStatus(selected));
  }
  function taskGroups(flow) {
    const groups = new Map();
    for (const task of flow.tasks) {
      const id = task.taskId || task.id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(task);
    }
    return [...groups.values()];
  }
  // The same flow restricted to the logical tasks `keep` accepts; undefined when none remain.
  function flowWithTaskGroups(flow, keep) {
    const tasks = taskGroups(flow).filter(keep).flat();
    return tasks.length ? { ...flow, tasks,
      ...(flow.pause && !tasks.some(task => (task.taskId || task.id) === flow.pause.taskId) ? { pause: undefined } : {}) } : undefined;
  }
  function unfinishedFlow(flow) {
    return flow.stopPending || flow.tasks.some(task => ["pending", "running", "verifying", "blocked"].includes(liveTaskStatus(task)));
  }
  function renderWorkLoopPanel() {
    const allFlows = displayTaskFlows();
    const flows = visibleTaskFlows(allFlows);
    // The task panel lists only work still in progress; ended tasks move to Task history, even while siblings run.
    const active = flows.filter(unfinishedFlow).map(flow => flowWithTaskGroups(flow, stages => !taskGroupEnded(flow, stages))).filter(Boolean);
    const history = flows.map(flow => unfinishedFlow(flow) ? flowWithTaskGroups(flow, stages => taskGroupEnded(flow, stages)) : flow).filter(Boolean);
    const boundRuns = new Set(allFlows.flatMap(flow => flow.tasks.map(task => (task.sessionAgentId || task.agentId) + "/" + (task.sessionRunId || task.runId))));
    const legacyHistory = state.childAgents.filter(agent => acceptedTaskAgent(agent) &&
      ["completed", "failed", "cancelled"].includes(agent.status) &&
      !(state.dismissedTasks || []).includes(taskDismissKey({ id: agent.taskBinding?.workflowId },
        [{ id: agent.taskBinding?.taskId, agentId: agent.agentId, runId: agent.runId }])) && !boundRuns.has(agent.agentId + "/" + agent.runId) &&
      !(state.workflows || []).some(snapshot => snapshot.workflow?.id === agent.taskBinding?.workflowId));
    const legacyDismissKey = agent => taskDismissKey({ id: agent.taskBinding?.workflowId },
      [{ id: agent.taskBinding?.taskId, agentId: agent.agentId, runId: agent.runId }]);
    const historyPanel = document.getElementById("task-history");
    const historyList = document.getElementById("task-history-panel");
    historyPanel.hidden = state.role !== "main";
    document.getElementById("question-tab-history").hidden = state.role !== "main";
    if (state.role !== "main" && document.getElementById("question-tab-history").getAttribute("aria-selected") === "true") {
      selectQuestionTab("questions", false, false);
    }
    if (historyPanel.hidden) historyPanel.open = false;
    const ownFlowIds = new Set(allFlows.map(flow => flow.id));
    // This conversation's records come from its own panel state (with dismissals); others are read-only briefs.
    const projectHistory = (state.projectTasks || []).filter(entry => entry && !(state.agentId && entry.mainAgentId === state.agentId) && !ownFlowIds.has(entry.id) &&
      !(state.dismissedTasks || []).includes(projectHistoryDismissKey(entry)));
    const historySignature = JSON.stringify([history, state.childAgents, projectHistory, state.dismissedTasks, t("flow.status.pending")]);
    if (historyList.dataset.signature !== historySignature) {
      historyList.dataset.signature = historySignature;
      const expanded = new Set(Array.from(historyList.querySelectorAll("details[data-history-id][open]"), item => item.dataset.historyId));
      const list = document.createElement("ul");
      list.className = "task-history-entries";
      list.append(...history.map(createTaskHistoryEntry), ...legacyHistory.map(agent => {
        const item = document.createElement("li");
        item.className = "task-history-legacy";
        item.append(createRunStage(agent));
        if (state.role === "main") item.append(createDismissButton(childTaskName(agent), [legacyDismissKey(agent)]));
        return item;
      }), ...projectHistory.map(createProjectHistoryEntry));
      for (const item of list.querySelectorAll("details[data-history-id]")) item.open = expanded.has(item.dataset.historyId);
      historyList.replaceChildren(history.length || legacyHistory.length || projectHistory.length ? list : historyEmpty("ui.task.history.empty"));
    }
    const hasActive = active.length > 0;
    if (hasActive && runDetails.dataset.hasActive !== "true" && !state.runPanelUserChoice) state.runPanelExpanded = true;
    runDetails.dataset.hasActive = String(hasActive);
    const expandable = state.role === "main";
    runStatus.hidden = !expandable;
    const expanded = expandable && state.runPanelExpanded;
    document.getElementById("run-status-title").textContent = t(active.length ? "ui.task.workflow" : "flow.empty");
    runStatusToggle.disabled = !expandable;
    runStatusToggle.setAttribute("aria-expanded", String(expanded));
    runStatus.classList.toggle("is-expanded", expanded);
    // Main's working indicator leads the open panel's header and returns to the composer dock when closed.
    const progress = document.getElementById("agent-progress");
    const progressHome = expanded ? runStatus : document.querySelector(".agent-progress-dock");
    if (progress && progressHome && progress.parentElement !== progressHome) progressHome.prepend(progress);
    const hasRunningStage = flows.some(flow => flow.tasks.some(task =>
      (taskHasActiveWorker(task, flow) || (flow.engine && flow.engineStatus === "active" &&
        (task.sessionAgentId || task.agentId) && (task.sessionRunId || task.runId))) && ["running", "verifying"].includes(liveTaskStatus(task))));
    runStatus.classList.toggle("is-running", hasRunningStage);
    runDetails.hidden = !expanded;
    // Header: in-progress roles from durable run status, then the visible task total; zero roles are omitted.
    const headerParts = runningRoleCounts().filter(([, count]) => count > 0).map(([key, count]) => t(key, count));
    if (active.length) headerParts.push(t("flow.task.count", active.reduce((sum, flow) => sum + summarizeTaskFlow(flow, true).total, 0)));
    runStatusAgents.hidden = state.role !== "main" || !headerParts.length;
    runStatusAgents.textContent = headerParts.length ? "· " + headerParts.join(" · ") : "";
    runStatusAgents.title = headerParts.join(" · ");
    runStatusToggle.setAttribute("aria-label", [document.getElementById("run-status-title").textContent, ...headerParts].join(" · "));
    if (!expanded) return;
    const signature = JSON.stringify([active, state.childAgents, [...taskStopsPending], [...taskStopErrors], t("flow.status.pending"), t("flow.empty")]);
    if (runStageList.dataset.flowSignature === signature) return;
    const expandedTasks = new Set(Array.from(runStageList.querySelectorAll(".task-flow-disclosure[open], .task-flow-single[open]"), item => {
      const task = item.closest("[data-task-id]");
      const flow = item.closest(".task-flow");
      return flow?.dataset.flowId + "/" + task?.dataset.taskId;
    }));
    runStageList.dataset.flowSignature = signature;
    runStageList.replaceChildren(...(active.length ? active.map(flow => createTaskFlow(flow, true)) : [historyEmpty("flow.empty")]));
    for (const item of runStageList.querySelectorAll(".task-flow-disclosure, .task-flow-single")) {
      const task = item.closest("[data-task-id]");
      const flow = item.closest(".task-flow");
      item.open = expandedTasks.has(flow?.dataset.flowId + "/" + task?.dataset.taskId);
    }
  }
  function runningRoleCounts() {
    const active = new Set(["accepted", "queued", "starting", "running", "verifying", "cancelling"]);
    const counts = { expert: 0, worker: 0, verifier: 0, unrecorded: 0 };
    for (const agent of state.childAgents) {
      if (!active.has(agent.status)) continue;
      if (agent.role === "verification") counts.verifier += 1;
      else if (agent.role === "work") counts[agent.workProfile === "work" ? "expert" : agent.workProfile === "workLight" ? "worker" : "unrecorded"] += 1;
    }
    return Object.entries(counts).map(([role, count]) => ["flow.header." + role, count]);
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
      vscode.postMessage({ type: "agent.open", agentId: agent.agentId, ...(agent.runId ? { runId: agent.runId } : {}) });
    });
    return item;
  }
  function childAgentStatusMarker(status) {
    if (status === "completed") return "✓";
    if (status === "failed" || status === "cancelled") return "×";
    if (status === "needs-human-decision") return "!";
    return "●";
  }

  return {
    renderWorkLoopPanel, renderProjectHistory, currentTaskFlows, workflowDecisionsPending, finishTaskStop, extractTaskFlows,
    releaseWorkflowDecisions, taskFlowParseCache, createTaskFlow, displayTaskFlows, visibleTaskFlows, taskDismissKey, unfinishedFlow,
    childTaskName
  };
};
