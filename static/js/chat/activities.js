globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.activities = function (host) {
  "use strict";

  const {
    state, t, uiLocale, vscode, activityPhaseAccessibleLabel, chatTerminal, taskModeNames, chatAgents
  } = host;

  function renderDecisionActions(content, runId) {
    const approval = state.pendingDecisionApproval;
    const irreversible = approval ? approval.irreversible : [];
    if (!state.pendingDecisionCanApprove && !irreversible.length) return;
    if (approval && approval.request) {
      const target = document.createElement("p");
      target.className = "decision-target";
      const label = document.createElement("span");
      label.className = "decision-target-label";
      label.textContent = t("ui.approval.target");
      const request = document.createElement("q");
      request.textContent = approval.request;
      target.append(label, " ", request);
      content.append(target);
    }
    if (irreversible.length) {
      // Irreversible operations need an explicit typed reply; the host also refuses one-click approval.
      const notice = document.createElement("div");
      notice.className = "decision-irreversible";
      notice.setAttribute("role", "note");
      const description = document.createElement("p");
      description.textContent = t("ui.this.proposal.includes.irreversible.operations.reply.directly.naming.the.operations.to.approve");
      const list = document.createElement("ul");
      for (const operation of irreversible) {
        const item = document.createElement("li");
        const code = document.createElement("code");
        code.textContent = operation;
        item.append(code);
        list.append(item);
      }
      notice.append(description, list);
      content.append(notice);
      return;
    }
    const actions = document.createElement("div");
    actions.className = "decision-actions";
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", t("ui.respond.to.the.proposal.above"));
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = t("ui.proceed.as.proposed");
    approve.disabled = state.running || state.decisionSubmitting || !state.runtimeAvailable;
    approve.addEventListener("click", function () {
      if (!state.pendingDecisionCanApprove || state.running || state.decisionSubmitting || state.pendingDecisionRunId !== runId) return;
      state.decisionSubmitting = true;
      approve.disabled = true;
      vscode.postMessage({ type: "decision.approve", runId, language: uiLocale() });
    });
    actions.append(approve);
    content.append(actions);
  }

  function renderSkillDocuments(container, documents, event) {
    container.classList.add("skill-read-card");
    const details = document.createElement("details");
    details.className = "skill-read-details";
    const summary = document.createElement("summary");
    summary.className = "skill-read-document";
    summary.title = activityPhaseAccessibleLabel(event.phase);
    for (const documentInfo of documents) {
      if (summary.childNodes.length) summary.append(document.createTextNode(" · "));
      const name = document.createElement("strong");
      name.textContent = documentInfo.skill;
      const file = document.createElement("span");
      file.textContent = documentInfo.document;
      file.title = documentInfo.path;
      summary.append(name, document.createTextNode(" "), file);
    }
    details.append(summary);
    chatTerminal.renderTerminalCommand(details, event.text, event.phase);
    chatTerminal.renderCommandOutput(details, event.output, false);
    container.append(details);
  }

  function renderCommandError(container, outcome) {
    if (!outcome.detail) return;
    const detail = document.createElement("div");
    detail.className = "command-error-summary";
    detail.textContent = outcome.detail;
    container.append(detail);
  }

  function renderFactoryScripts(container, scripts, documents, event) {
    container.classList.add("managed-agent-card");
    const outcome = globalThis.agentFactoryExecutionReferences.commandOutcome(event);
    container.dataset.status = outcome.status;
    const row = document.createElement("div");
    row.className = "managed-agent-heading";
    const heading = document.createElement("strong");
    const labels = { doctor: t("ui.check.execution.environment"), capabilities: t("ui.check.supported.features"), submit: t("ui.submit.task"), send: t("ui.send.follow.up"), status: t("ui.check.task.status"), result: t("ui.read.task.result"), start: t("ui.start.task") };
    heading.textContent = scripts.map(function (script) {
      if (script.skill === "agent" && ["exec.py", "loop.py"].includes(script.script) && labels[script.action]) return labels[script.action];
      return script.script + (script.action ? " · " + script.action : "");
    }).join(" / ");
    const badge = document.createElement("span");
    badge.className = "managed-agent-status";
    badge.textContent = outcome.status === "completed" ? t(scripts.some(script => ["start", "submit", "send"].includes(script.action)) ? "activity.request.command.completed" : "activity.command.completed") : activityPhaseAccessibleLabel(outcome.status === "running" ? "started" : outcome.status);
    row.append(heading, badge);
    container.append(row);
    renderCommandError(container, outcome);
    // Keep mixed commands and failures intact, including their non-Factory output.
    renderSkillDocuments(container, documents.length ? documents : scripts.map(function (script) {
      return { skill: "agent-factory:" + script.skill, document: script.script, path: script.path };
    }), event);
  }

  function renderManagedAgent(container, managed, events) {
    container.classList.add("managed-agent-card");
    const child = state.childAgents.find(function (agent) { return agent.agentId === managed.agentId; });
    const pendingRequest = ["submit", "send", "start", "resume"].includes(managed.action) && !managed.runId;
    const matchesRun = managed.kind !== "loop" && child && !pendingRequest && (!managed.runId || child.runId === managed.runId);
    const role = managed.role || child?.role;
    const last = events[events.length - 1];
    const outcome = globalThis.agentFactoryExecutionReferences.commandOutcome(last);
    const status = pendingRequest && outcome.status === "failed" ? "failed" : matchesRun ? child.status : managed.observedStatus || "unknown";
    container.dataset.status = status;
    const heading = document.createElement("div");
    heading.className = "managed-agent-heading";
    const label = document.createElement("strong");
    label.textContent = managed.taskMode === "plan" ? t("ui.plan.work.agent") : managed.kind === "loop" ? taskModeNames()[managed.taskMode] || t("ui.work.verification") : role === "verification" ? t("ui.verification.agent") : role === "work" ? t("ui.work.agent") : t("ui.agent");
    const badge = document.createElement("span");
    badge.className = "managed-agent-status";
    badge.textContent = status === "active" ? t("ui.in.progress") : status === "runtime-error" ? t("ui.runtime.error") : chatAgents.childAgentStatusLabel(status);
    if (["work", "plan-work"].includes(managed.taskMode) && status === "completed") badge.textContent += t("ui.no.separate.verification.requested");
    heading.append(label, badge);
    const identity = document.createElement("div");
    identity.className = "managed-agent-identity";
    identity.textContent = managed.agentId + (managed.runId ? " · " + managed.runId : "");
    const progress = document.createElement("div");
    progress.className = "managed-agent-progress";
    const actions = { submit: t("ui.submit.run"), start: t("ui.start.work"), send: t("ui.send.follow.up"), status: t("ui.check.status"), result: t("ui.get.result"), updates: t("ui.get.updates"), cancel: t("ui.cancel"), resume: t("ui.resume"), reconcile: t("ui.reconcile.work"), "recover-receipt": t("ui.recover.run"), skip: t("ui.skip.verification") };
    progress.textContent = (actions[managed.action] || t("ui.check.run")) + (outcome.status === "failed" ? t("ui.failed") : outcome.status === "running" ? t("ui.in.progress.3d921e") : pendingRequest ? t("ui.acceptance.unconfirmed") : t("ui.processed"));
    if (["submit", "send", "start", "resume"].includes(managed.action)) {
      progress.textContent = outcome.status === "failed" ? t("activity.request.failed") :
        outcome.status === "running" ? t("activity.request.pending") :
        managed.runId && (matchesRun || ["accepted", "queued", "starting", "running", "active", "completed", "failed", "cancelled", "needs-human-decision"].includes(managed.observedStatus)) ? t("activity.request.accepted") : t("activity.request.unconfirmed");
    }
    container.append(heading, identity, progress);
    renderCommandError(container, outcome);
    if (child && state.role === "main") {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "managed-agent-open setting-button";
      open.textContent = t("ui.open.chat");
      open.addEventListener("click", function () {
        if (state.childAgents.some(function (agent) { return agent.agentId === managed.agentId; })) vscode.postMessage({ type: "agent.open", agentId: managed.agentId });
      });
      container.append(open);
    }
    const details = document.createElement("details");
    details.className = "managed-agent-details";
    const summary = document.createElement("summary");
    summary.textContent = t("ui.command.and.run.history") + events.length;
    details.append(summary);
    for (const event of events) {
      const raw = document.createElement("div");
      chatTerminal.renderTerminalCommand(raw, event.text, event.phase, event.title);
      chatTerminal.renderCommandOutput(raw, event.output, Boolean(event.title));
      raw.querySelectorAll("details").forEach(function (item, index) {
        item.dataset.disclosureKey = event.id + ":" + index;
      });
      details.append(raw);
    }
    container.append(details);
  }

  return {
    renderDecisionActions, renderManagedAgent, renderFactoryScripts, renderSkillDocuments,
    renderCommandError
  };
};
