globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.workUnits = function (host) {
  "use strict";

  const {
    openSetting, closeSettingMenu, vscode, handleSettingMenuKeydown, t, promptSurface, prompt,
    updateSendButton
  } = host;

  const worktreeButton = document.getElementById("worktree-button");
  const worktreeMenu = document.getElementById("worktree-menu");
  worktreeButton.addEventListener("click", () => openSetting("worktree"));
  let conversationWorktree;
  let worktreeBusy = false;
  let worktreeSupported = false;
  for (const action of ["create", "merge", "refresh"]) {
    document.getElementById("worktree-" + action)?.addEventListener("click", () => {
      if (action !== "refresh") closeSettingMenu(false);
      else vscode.postMessage({ type: "worktree.repositories" });
      vscode.postMessage({ type: "worktree." + action });
    });
    document.getElementById("worktree-" + action)?.addEventListener("keydown", handleSettingMenuKeydown);
  }
  const unitDialog = document.getElementById("unit-create-dialog");
  const unitForm = document.getElementById("unit-create-form");
  const unitRepository = document.getElementById("unit-repository");
  const unitName = document.getElementById("unit-name");
  const unitBase = document.getElementById("unit-base");
  const unitError = document.getElementById("unit-create-error");
  const unitStatus = document.getElementById("unit-create-status");
  let unitRepositories = [], unitBusy = false;
  function unitSelectRepository() {
    const repo = unitRepositories.find(r => r.path === unitRepository.value);
    unitBase.replaceChildren();
    for (const branch of repo?.branches || []) { const option = document.createElement("option"); option.value = branch; option.textContent = branch; unitBase.append(option); }
    if (repo?.defaultBranch) unitBase.value = repo.defaultBranch;
  }
  function unitSetBusy(busy) {
    unitBusy = busy;
    for (const control of unitForm.querySelectorAll("input, select, textarea, button")) control.disabled = busy;
    document.getElementById("unit-create-submit").disabled = busy;
    unitForm.setAttribute("aria-busy", String(busy));
  }
  function openUnitCreate(repository) {
    closeSettingMenu(false);
    unitForm.reset(); unitError.hidden = true;
    unitRepository.replaceChildren();
    for (const repo of unitRepositories) { const option = document.createElement("option"); option.value = repo.path; option.textContent = repo.path; unitRepository.append(option); }
    unitRepository.value = repository;
    unitSelectRepository();
    unitSetBusy(false); unitStatus.textContent = "";
    unitDialog.showModal(); unitName.focus();
  }
  unitRepository.addEventListener("change", unitSelectRepository);
  document.getElementById("unit-create-cancel").addEventListener("click", () => unitDialog.close());
  unitDialog.addEventListener("cancel", event => { if (unitBusy) event.preventDefault(); });
  unitDialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const controls = [...unitDialog.querySelectorAll("input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)")];
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  unitDialog.addEventListener("close", () => worktreeButton.focus());
  unitForm.addEventListener("submit", event => {
    event.preventDefault();
    if (unitBusy || !unitForm.reportValidity()) return;
    unitError.hidden = true; unitStatus.textContent = t("unit.creating");
    unitSetBusy(true);
    vscode.postMessage({ type: "worktree.create", repository: unitRepository.value, name: unitName.value.trim(), base: unitBase.value });
  });
  function positionWorktreeMenu() {
    if (worktreeMenu.hidden) return;
    const anchor = worktreeButton.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(320, window.innerWidth - margin * 2);
    worktreeMenu.style.width = width + "px";
    worktreeMenu.style.left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin)) + "px";
    worktreeMenu.style.bottom = Math.max(margin, window.innerHeight - anchor.top + 8) + "px";
    worktreeMenu.style.maxHeight = Math.max(48, anchor.top - margin * 2) + "px";
  }
  window.addEventListener("resize", positionWorktreeMenu);
  const worktreePositionObserver = new ResizeObserver(positionWorktreeMenu);
  worktreePositionObserver.observe(document.getElementById("worktree-picker"));
  worktreePositionObserver.observe(promptSurface);

  // GitHub deploy: the host detects manually dispatchable workflows; the dialog collects
  // their declared inputs and requires a review step before anything is dispatched.
  let deployTarget, deployError = "", deployLoading = false, deployRun, deployRepository = "", deployWorkflow, deployValues, deployBusy = false;
  const deployDialog = document.getElementById("deploy-dialog");
  const deployForm = document.getElementById("deploy-form");
  const deployFields = document.getElementById("deploy-fields");
  const deployErrorNode = document.getElementById("deploy-error");
  const deployStatusNode = document.getElementById("deploy-status");
  function deployAvailable() { return Boolean(deployTarget?.workflows?.length || deployRun); }
  function deployActive() { return Boolean(deployRun && deployRun.status !== "completed"); }
  function deployStateLabel(run) {
    if (run.status !== "completed") return t("deploy.state.running", run.status);
    return run.conclusion === "success" ? t("deploy.state.success") : t("deploy.state.failed", run.conclusion || run.status);
  }
  function renderDeploy() {
    const controls = document.getElementById("deploy-controls");
    if (!controls) return;
    controls.hidden = host.state.role !== "main" || (!deployAvailable() && !deployError);
    const summary = document.getElementById("deploy-summary");
    summary.textContent = deployLoading ? t("deploy.detecting") : deployError || (deployTarget ? deployTarget.repository + " · " + deployTarget.ref : "");
    const list = document.getElementById("deploy-workflows");
    list.replaceChildren();
    for (const workflow of deployTarget?.workflows || []) {
      for (const secret of workflow.missingSecrets || []) {
        const setup = document.createElement("button");
        setup.type = "button"; setup.className = "setting-option"; setup.setAttribute("role", "menuitem");
        setup.textContent = t("deploy.token.setup", secret);
        setup.title = t("deploy.token.setup.title", secret);
        setup.dataset.deploySecret = secret;
        setup.addEventListener("click", () => { closeSettingMenu(false); vscode.postMessage({ type: "deploy.token", secret: secret }); });
        setup.addEventListener("keydown", handleSettingMenuKeydown);
        list.append(setup);
      }
      const button = document.createElement("button");
      button.type = "button"; button.className = "setting-option"; button.setAttribute("role", "menuitem");
      button.textContent = t("deploy.workflow", workflow.name);
      button.title = workflow.path;
      button.disabled = deployActive() || Boolean(workflow.missingSecrets?.length);
      button.addEventListener("click", () => openDeploy(workflow));
      button.addEventListener("keydown", handleSettingMenuKeydown);
      list.append(button);
    }
    const link = document.getElementById("deploy-run-link");
    link.hidden = !deployRun;
    if (deployRun) link.textContent = t("deploy.run.link", deployRun.workflow, deployStateLabel(deployRun));
    document.getElementById("deploy-refresh").disabled = deployLoading;
  }
  function requestDeployTargets() {
    deployLoading = true; deployError = "";
    renderDeploy();
    vscode.postMessage({ type: "deploy.detect" });
  }
  document.getElementById("deploy-refresh").addEventListener("click", requestDeployTargets);
  document.getElementById("deploy-refresh").addEventListener("keydown", handleSettingMenuKeydown);
  document.getElementById("deploy-run-link").addEventListener("click", () => { if (deployRun?.url) vscode.postMessage({ type: "link.open", href: deployRun.url }); });
  document.getElementById("deploy-run-link").addEventListener("keydown", handleSettingMenuKeydown);
  function deploySetBusy(busy) {
    deployBusy = busy;
    for (const control of deployForm.querySelectorAll("input, select, button")) control.disabled = busy;
    deployForm.setAttribute("aria-busy", String(busy));
  }
  function openDeploy(workflow) {
    closeSettingMenu(false);
    deployWorkflow = workflow; deployValues = undefined;
    document.getElementById("deploy-target").textContent = t("deploy.target", deployTarget.repository, deployTarget.ref, workflow.name);
    deployFields.replaceChildren();
    for (const input of workflow.inputs) {
      const label = document.createElement("label");
      const caption = document.createElement("span");
      caption.textContent = input.name + (input.required ? " *" : "");
      let control;
      if (input.type === "boolean") {
        label.className = "deploy-checkbox";
        control = document.createElement("input"); control.type = "checkbox";
        control.checked = input.default === "true";
      } else if (input.type === "choice") {
        control = document.createElement("select");
        for (const value of input.options || []) { const option = document.createElement("option"); option.value = option.textContent = value; control.append(option); }
        if (input.default) control.value = input.default;
      } else {
        control = document.createElement("input");
        control.type = input.type === "number" ? "number" : "text";
        control.autocomplete = "off";
        control.value = input.default ?? input.suggestion ?? "";
        if (input.suggestion) control.pattern = "\\d+\\.\\d+\\.\\d+";
      }
      control.dataset.deployInput = input.name;
      control.required = input.required && input.type !== "boolean";
      if (input.type === "boolean") label.append(control, caption); else label.append(caption, control);
      if (input.description) { const hint = document.createElement("small"); hint.textContent = input.description; label.append(hint); }
      deployFields.append(label);
    }
    deployErrorNode.hidden = true; deployStatusNode.textContent = "";
    deploySetBusy(false);
    deployDialog.showModal();
    deployFields.querySelector("input, select")?.focus();
  }
  function collectDeployValues() {
    const values = {};
    for (const control of deployFields.querySelectorAll("[data-deploy-input]")) {
      values[control.dataset.deployInput] = control.type === "checkbox" ? control.checked : control.value.trim();
    }
    return values;
  }
  deployForm.addEventListener("submit", event => {
    event.preventDefault();
    if (deployBusy || !deployWorkflow) return;
    deployErrorNode.hidden = true;
    {
      for (const control of deployFields.querySelectorAll("[data-deploy-input]")) {
        if (control.required && !control.value.trim()) { control.focus(); deployErrorNode.textContent = t("deploy.required", control.dataset.deployInput); deployErrorNode.hidden = false; return; }
        if (control.pattern && control.value && !new RegExp("^(?:" + control.pattern + ")$").test(control.value.trim())) {
          control.focus(); deployErrorNode.textContent = t("deploy.invalid.version", control.dataset.deployInput); deployErrorNode.hidden = false; return;
        }
      }
      // One confirmation: the dialog itself shows the target and values.
      deployValues = collectDeployValues();
    }
    deploySetBusy(true);
    deployStatusNode.textContent = t("deploy.dispatching");
    vscode.postMessage({ type: "deploy.run", workflowId: deployWorkflow.id, inputs: deployValues });
  });
  document.getElementById("deploy-cancel").addEventListener("click", () => deployDialog.close());
  deployDialog.addEventListener("cancel", event => { if (deployBusy) event.preventDefault(); });
  deployDialog.addEventListener("close", () => worktreeButton.focus());
  function worktreeLocationDescription() {
    const tree = conversationWorktree?.worktree;
    const isolated = tree && tree.phase !== "merged";
    return t(isolated ? "worktree.isolated" : "worktree.workspace") +
      (conversationWorktree?.workingDirectory ? " · " + conversationWorktree.workingDirectory : "") +
      (conversationWorktree?.branch ? " · " + conversationWorktree.branch : "") +
      (conversationWorktree?.conflicts?.length ? " · " + t("worktree.conflicts", conversationWorktree.conflicts.join(", ")) : "");
  }

  function renderWorktree() {
    const controls = document.getElementById("worktree-controls");
    if (!controls) return;
    const unavailable = !worktreeSupported || host.state.role !== "main";
    const pickerHidden = host.state.role !== "main" || (unavailable && !deployAvailable());
    document.getElementById("worktree-picker").hidden = pickerHidden;
    controls.hidden = unavailable;
    renderDeploy();
    if (pickerHidden && host.openSettingId === "worktree") closeSettingMenu(false);
    const tree = conversationWorktree?.worktree;
    const isolated = tree && tree.phase !== "merged";
    worktreeButton.classList.toggle("is-connected", Boolean(isolated));
    worktreeButton.title = t("worktree.isolated");
    worktreeButton.setAttribute("aria-label", t("worktree.isolated"));
    const summary = document.getElementById("worktree-summary");
    summary.hidden = !isolated;
    summary.textContent = isolated ? (tree.name || tree.branch) + " · " + tree.branch : "";
    const busy = worktreeBusy || host.state.running || (host.state.pendingRequests || []).length > 0 || host.state.queueCount > 0;
    const create = document.getElementById("worktree-create");
    const merge = document.getElementById("worktree-merge");
    create.hidden = true;
    merge.hidden = (!isolated && !(tree?.workUnit && !tree.cleaned)) || tree?.phase === "creating";
    prompt.readOnly = Boolean(tree?.workUnit && tree.phase === "merged");
    updateSendButton();
    create.disabled = merge.disabled = busy;
    document.getElementById("worktree-refresh").disabled = worktreeBusy;
  }
  function receiveUnitCreated(message) {
    unitSetBusy(false); unitStatus.textContent = "";
    if (message.error) {
      unitError.textContent = message.error; unitError.hidden = false;
      if (message.created) document.getElementById("unit-create-submit").disabled = true;
    } else unitDialog.close();
  }

  function receiveDeployTargets(message) {
    deployLoading = false;
    deployTarget = message.target;
    deployError = message.error || "";
    renderWorktree();
  }

  function receiveDeployStatus(message) {
    if (message.error) {
      if (deployDialog.open) { deploySetBusy(false); deployStatusNode.textContent = ""; deployErrorNode.textContent = message.error; deployErrorNode.hidden = false; }
      else deployError = message.error;
    } else if (message.run) {
      deployRun = message.run; deployRepository = message.repository || deployRepository;
      if (deployDialog.open) { deploySetBusy(false); deployDialog.close(); }
    }
    renderWorktree();
  }

  function receiveUnitRepositories(message) {
    unitRepositories = message.repositories;
    const list = document.getElementById("worktree-repositories");
    list.replaceChildren();
    for (const repo of message.repositories) {
      const button = document.createElement("button"); button.type = "button"; button.className = "setting-option";
      button.setAttribute("role", "menuitem"); button.classList.add("worktree-repository");
      button.title = repo.path;
      const name = document.createElement("strong"); name.textContent = repo.path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || repo.path;
      const path = document.createElement("span"); path.className = "worktree-repository-path"; path.textContent = repo.path;
      const action = document.createElement("span"); action.className = "worktree-repository-action"; action.textContent = "+ " + t("worktree.create");
      button.append(name, path, action);
      button.addEventListener("click", () => { openUnitCreate(repo.path); });
      button.addEventListener("keydown", handleSettingMenuKeydown); list.append(button);
    }
    if (!message.repositories.length) {
      const empty = document.createElement("p"); empty.className = "worktree-summary"; empty.textContent = t("worktree.empty"); list.append(empty);
    }
    positionWorktreeMenu();
  }

  function receiveWorktree(message) {
    if (typeof message.supported === "boolean") worktreeSupported = message.supported;
    if (typeof message.busy === "boolean") worktreeBusy = message.busy;
    conversationWorktree = message.value;
    renderWorktree();
  }

  return {
    worktreeLocationDescription, unitDialog, receiveUnitCreated, receiveDeployTargets,
    receiveDeployStatus, receiveUnitRepositories, receiveWorktree, renderWorktree,
    get conversationWorktree() { return conversationWorktree; },
    requestDeployTargets, positionWorktreeMenu, worktreeButton, worktreeMenu
  };
};
