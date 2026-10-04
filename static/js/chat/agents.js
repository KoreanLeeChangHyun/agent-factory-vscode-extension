globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.agents = function (host) {
  "use strict";

  const {
    agentsMenu, state, renderStatusBar, vscode, agentsList, t
  } = host;

  function openAgentsMenu() {
    if (!agentsMenu.hidden) {
      closeAgentsMenu();
      return;
    }
    state.agentsLoading = true;
    agentsMenu.hidden = false;
    renderAgentsList();
    renderStatusBar();
    vscode.postMessage({ type: "agents.request" });
    agentsMenu.querySelector("button:not(:disabled)")?.focus();
  }

  function closeAgentsMenu() {
    host.closeWorktreeMenu();
    agentsMenu.hidden = true;
    renderStatusBar();
  }

  function renderAgentsList() {
    agentsList.replaceChildren();
    if (state.agentsLoading) {
      agentsList.append(emptyAgentItem(t("ui.loading.called.agents")));
      return;
    }
    if (state.childAgents.length === 0) {
      agentsList.append(emptyAgentItem(t("ui.no.work.or.verification.agents.have.been.called.yet")));
      return;
    }
    for (const agent of state.childAgents) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "agent-item";
      item.setAttribute("role", "option");
      item.title = agent.agentId + t("ui.chat.with.session");
      const main = document.createElement("span");
      main.className = "agent-item-main";
      const role = document.createElement("span");
      role.className = "agent-role";
      role.textContent = agent.role === "work" ? t("ui.work") : t("ui.verification");
      const id = document.createElement("span");
      id.className = "agent-id";
      id.textContent = host.chatTaskFlow.childTaskName(agent);
      const status = document.createElement("span");
      status.className = "agent-status";
      status.textContent = childAgentStatusLabel(agent.status) + t("ui.click.to.chat");
      main.append(role, id);
      item.append(main, status);
      item.addEventListener("click", function () {
        closeAgentsMenu();
        vscode.postMessage({ type: "agent.open", agentId: agent.agentId });
      });
      agentsList.append(item);
    }
  }

  function emptyAgentItem(text) {
    const item = document.createElement("div");
    item.className = "session-empty";
    item.textContent = text;
    return item;
  }

  function isChildAgent(agent) {
    return agent && typeof agent.agentId === "string" &&
      ["work", "verification"].includes(agent.role) && typeof agent.status === "string";
  }

  function summarizeChildAgents(agents) {
    const activeStatuses = new Set(["accepted", "queued", "starting", "running", "verifying", "cancelling"]);
    return {
      activeUnits: agents.filter(function (agent) { return activeStatuses.has(agent.status); }).length,
      workActive: agents.filter(function (agent) { return agent.role === "work" && activeStatuses.has(agent.status); }).length,
      verificationActive: agents.filter(function (agent) { return agent.role === "verification" && activeStatuses.has(agent.status); }).length,
      totalCalled: agents.length
    };
  }

  function childAgentStatusLabel(status) {
    const labels = {
      accepted: t("ui.queued"),
      queued: t("ui.queued"),
      starting: t("ui.starting"),
      running: t("ui.running.73989d"),
      verifying: t("flow.status.verifying"),
      cancelling: t("ui.cancelling"),
      completed: t("ui.completed"),
      failed: t("ui.failed.09fef5"),
      cancelled: t("ui.cancelled"),
      "needs-human-decision": t("ui.user.decision.required"),
      unknown: t("ui.status.unknown")
    };
    return labels[status] || status;
  }

  return {
    childAgentStatusLabel, closeAgentsMenu, isChildAgent, summarizeChildAgents, renderAgentsList,
    openAgentsMenu
  };
};
