(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const state = { centerSelection: saved.centerSelection, centerFilter: saved.centerFilter, projectTasks: [], timeline: [] };
  const language = globalThis.AgentFactoryI18n.locale("auto", document.documentElement.dataset.hostLanguage);
  const t = (key, ...args) => globalThis.AgentFactoryI18n.format(key, language, ...args);
  const persist = () => vscode.setState({ centerSelection: state.centerSelection, centerFilter: state.centerFilter });
  globalThis.AgentFactoryI18n.apply(document, language);
  const center = globalThis.AgentFactoryChat.maestro({ state, t, vscode, persist });
  window.addEventListener("message", ({ data: message }) => {
    if (message.type === "project.tasks") {
      if (!message.error) state.projectTasks = Array.isArray(message.entries) ? message.entries : [];
      center.receive(message);
    } else if (message.type === "control.center.selection") {
      state.centerSelection = { workflowId: message.workflowId, taskId: message.taskId };
      state.centerFilter = {};
      center.render(); persist();
    } else if (message.type === "host.notice") {
      document.getElementById("maestro-observation").textContent = message.text;
    }
  });
  center.render();
  vscode.postMessage({ type: "client.ready" });
})();
