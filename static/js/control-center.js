(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const state = { centerSelection: saved.centerSelection, centerFilter: saved.centerFilter, centerView: saved.centerView || "workers", centerCollapsed: saved.centerCollapsed || {}, centerDetailOpen: saved.centerDetailOpen !== false, centerCommandLog: Array.isArray(saved.centerCommandLog) ? saved.centerCommandLog : [], projectRoot: typeof saved.projectRoot === "string" ? saved.projectRoot : undefined, workerOrder: Array.isArray(saved.workerOrder) ? saved.workerOrder : undefined, projectTasks: [], timeline: [] };
  const language = globalThis.AgentFactoryI18n.locale("auto", document.documentElement.dataset.hostLanguage);
  const t = (key, ...args) => globalThis.AgentFactoryI18n.format(key, language, ...args);
  const persist = () => vscode.setState({ centerSelection: state.centerSelection, centerFilter: state.centerFilter, centerView: state.centerView, centerCollapsed: state.centerCollapsed, centerDetailOpen: state.centerDetailOpen, centerCommandLog: state.centerCommandLog, projectRoot: state.projectRoot, workerOrder: state.workerOrder });
  document.documentElement.lang = language;
  globalThis.AgentFactoryI18n.apply(document, language);
  const center = globalThis.AgentFactoryChat.maestro({ state, t, vscode, persist, language });
  window.addEventListener("message", ({ data: message }) => {
    if (message.type === "project.tasks") {
      if (!message.error) {
        state.projectTasks = Array.isArray(message.entries) ? message.entries : [];
        // The editable domain list arrives with the tasks; a failed domain read keeps the last list and is reported.
        if (message.domains && typeof message.domains === "object") state.projectDomains = message.domains;
        else if (!message.domainsError) state.projectDomains = undefined;
        state.domainsError = message.domainsError;
      }
      center.receive(message);
    } else if (message.type === "control.center.project") {
      // VS Code returns this saved state to the host when it restores the tab after reload or restart.
      if (typeof message.projectRoot === "string" && message.projectRoot !== state.projectRoot) { state.projectRoot = message.projectRoot; persist(); }
    } else if (message.type === "control.center.selection") {
      state.centerSelection = { workflowId: message.workflowId, taskId: message.taskId };
      state.centerFilter = {};
      state.centerView = "tasks";
      state.centerDetailOpen = true;
      center.render(); persist();
    } else if (message.type === "worker.result") {
      center.workerResult(message);
    } else if (message.type === "supervision.report") {
      center.supervisionResult(message);
    } else if (message.type === "handoff.models") {
      center.handoffModelsResult(message);
    } else if (message.type === "worker.order.result") {
      center.workerOrderResult(message);
    } else if (message.type === "domain.result") {
      center.domainResult(message);
    } else if (message.type === "host.notice") {
      center.showNotice(message.text);
    }
  });
  center.render();
  vscode.postMessage({ type: "client.ready" });
})();
