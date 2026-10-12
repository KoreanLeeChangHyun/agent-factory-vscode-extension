globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.providers = function (host) {
  "use strict";

  const {
    appendNotice, t, vscode
  } = host;

  const providerNames = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity" };
  let providerSnapshot = { providers: [], busy: false, errors: {}, pluginUpdateMode: "auto", versions: {} };
  const providerDrafts = new Map();
  let providerNoticeShown = false;
  let providerVersionsRequested = false;
  let providerCatalog = null;
  let missingProviderExpanded = false;
  let factoryInstallVersion = "";
  const providerInstallVersions = new Map();
  let authSnapshot = { auth: {}, checking: false, signingIn: [] };
  const authStates = ["signed-in", "signed-out", "unknown", "missing"];

  function receiveAuth(message) {
    const auth = {};
    for (const id of Object.keys(providerNames)) {
      const value = message.auth?.[id];
      if (value && authStates.includes(value.state)) auth[id] = value;
    }
    authSnapshot = {
      auth,
      checking: message.checking === true,
      signingIn: Array.isArray(message.signingIn) ? message.signingIn.filter(id => Object.hasOwn(providerNames, id)) : []
    };
    renderProviderSettings();
  }

  // Detection says whether a CLI exists; only the CLI's own answer for this exact path says whether it is signed in.
  function authText(provider) {
    if (!provider.detected) return { state: "missing", text: t("ui.providers.auth.missing") };
    if (authSnapshot.signingIn.includes(provider.id)) return { state: "signing-in", text: t("ui.providers.auth.signing-in") };
    const value = authSnapshot.auth[provider.id];
    if (!value || value.path !== provider.path) return { state: "checking", text: authSnapshot.checking ? t("ui.providers.auth.checking") : "" };
    if (value.state === "signed-in") return { state: value.state, text: t(value.method === "api-key" ? "ui.providers.auth.signed-in.api-key" : "ui.providers.auth.signed-in") };
    if (value.state === "signed-out") return { state: value.state, text: t("ui.providers.auth.signed-out") };
    if (value.state === "missing") return { state: value.state, text: t("ui.providers.auth.missing") };
    const reason = ["unsupported", "timeout", "error"].includes(value.reason) ? value.reason : undefined;
    return { state: "unknown", text: t("ui.providers.auth.unknown"), detail: reason ? t("ui.providers.auth.unknown." + reason) : undefined };
  }

  // The sign-in state sits beside the name and the sign-in button beside the executable it runs,
  // so the fixed-height settings window keeps fitting every provider card.
  function renderAuthState(provider) {
    const group = document.createElement("span");
    group.className = "provider-auth";
    const { state, text, detail } = authText(provider);
    const label = document.createElement("span");
    label.className = "provider-auth-state";
    label.dataset.authState = state;
    label.textContent = text;
    if (detail) label.title = detail;
    group.append(label);
    if (!provider.detected) return group;
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "provider-auth-refresh";
    refresh.dataset.providerControl = provider.id + ":auth-refresh";
    refresh.textContent = "\u21bb";
    refresh.title = t("ui.providers.auth.refresh.label", providerNames[provider.id]);
    refresh.setAttribute("aria-label", refresh.title);
    refresh.disabled = providerSnapshot.busy || authSnapshot.checking;
    refresh.addEventListener("click", function () {
      authSnapshot = { ...authSnapshot, checking: true };
      renderProviderSettings();
      vscode.postMessage({ type: "providers.auth.request" });
    });
    group.append(refresh);
    return group;
  }

  function renderLogin(provider) {
    const login = document.createElement("button");
    login.type = "button";
    login.dataset.providerControl = provider.id + ":login";
    login.textContent = t("ui.providers.login");
    login.setAttribute("aria-label", t("ui.providers.login.label", providerNames[provider.id]));
    login.disabled = providerSnapshot.busy;
    login.addEventListener("click", function () { vscode.postMessage({ type: "providers.login", provider: provider.id }); });
    return login;
  }

  function receiveProviders(message) {
    const providers = Array.isArray(message.providers)
      ? message.providers.filter(item => item && Object.hasOwn(providerNames, item.id)) : [];
    providerSnapshot = {
      providers,
      busy: message.busy === true,
      errors: message.errors && typeof message.errors === "object" ? message.errors : {},
      pluginUpdateMode: message.pluginUpdateMode === "manual" ? "manual" : "auto",
      versions: message.versions && typeof message.versions === "object" ? message.versions : {}
    };
    if (!providerSnapshot.busy) providerDrafts.clear();
    // Without any CLI the chat stays open; point once to the place where a path can be set.
    if (!providerSnapshot.busy && providers.length && !providers.some(item => item.detected) && !providerNoticeShown) {
      providerNoticeShown = true;
      appendNotice("warning", t("ui.providers.none.chat"));
    }
    if (providers.some(item => item.detected)) providerNoticeShown = false;
    renderProviderSettings();
  }

  function populateVersionSelect(select, versions, selected, unavailable) {
    const values = Array.isArray(versions) ? versions : [];
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t(providerCatalog === null ? "ui.providers.version.loading"
      : unavailable ? "ui.providers.version.unavailable"
        : values.length ? "ui.providers.version.select" : "ui.providers.version.none");
    select.append(placeholder);
    for (const version of values) {
      const option = document.createElement("option");
      option.value = version;
      option.textContent = version;
      select.append(option);
    }
    select.value = values.includes(selected) ? selected : "";
    select.disabled = providerSnapshot.busy || !values.length;
  }

  function renderProviderSettings() {
    const root = document.getElementById("provider-settings");
    if (!root) return;
    const focused = root.contains(document.activeElement) ? document.activeElement.dataset.providerControl : undefined;
    const section = document.createElement("section");
    section.className = "provider-settings";
    const hasDetected = providerSnapshot.providers.some(provider => provider.detected);
    const update = document.createElement("button");
    update.type = "button";
    update.dataset.providerControl = "update-now";
    update.textContent = t(providerSnapshot.busy ? "ui.providers.update.updating" : "ui.providers.update.now");
    update.disabled = providerSnapshot.busy || !hasDetected;
    update.addEventListener("click", function () { vscode.postMessage({ type: "providers.update" }); });
    const factoryControls = document.createElement("div");
    factoryControls.className = "provider-version-controls provider-factory-version-controls";
    const factoryInput = document.createElement("select");
    factoryInput.setAttribute("aria-label", t("ui.providers.factory.version.label"));
    factoryInput.dataset.providerControl = "factory-install-version-select";
    populateVersionSelect(factoryInput, providerCatalog?.factory, factoryInstallVersion, providerCatalog?.errors?.factory);
    const factoryInstall = document.createElement("button");
    factoryInstall.type = "button";
    factoryInstall.dataset.providerControl = "factory-install-version";
    factoryInstall.textContent = t("ui.providers.install");
    const updateFactoryButton = () => { factoryInstall.disabled = providerSnapshot.busy || !hasDetected || !factoryInput.value; };
    const submitFactoryVersion = () => {
      if (factoryInstall.disabled) return;
      vscode.postMessage({ type: "providers.update", version: factoryInput.value });
    };
    factoryInput.addEventListener("change", function () { factoryInstallVersion = factoryInput.value; updateFactoryButton(); });
    factoryInstall.addEventListener("click", submitFactoryVersion);
    updateFactoryButton();
    factoryControls.append(factoryInput, factoryInstall, update);
    section.append(factoryControls);
    const missing = providerSnapshot.providers.filter(provider => !provider.detected);
    let missingList;
    let missingDetails;
    if (missing.length) {
      missingDetails = document.createElement("details");
      missingDetails.className = "provider-missing";
      missingDetails.open = !hasDetected || missingProviderExpanded;
      missingDetails.addEventListener("toggle", function () {
        if (hasDetected) missingProviderExpanded = missingDetails.open;
      });
      const summary = document.createElement("summary");
      summary.textContent = t("ui.providers.add.path");
      missingList = document.createElement("div");
      missingList.className = "provider-missing-list";
      missingDetails.append(summary, missingList);
    }
    for (const provider of providerSnapshot.providers) {
      const row = document.createElement("div");
      row.className = "provider-row";
      const head = document.createElement("div");
      head.className = "provider-row-head";
      const name = document.createElement("span");
      name.className = "provider-name";
      name.textContent = providerNames[provider.id];
      const status = document.createElement("span");
      status.className = "provider-state";
      status.dataset.detected = String(provider.detected === true);
      status.textContent = provider.detected
        ? t("ui.providers.detected") + " · " + t(provider.source === "configured" ? "ui.providers.source.configured" : "ui.providers.source.auto")
        : "";
      head.append(name, renderAuthState(provider));
      if (provider.detected) head.append(status);
      row.append(head);
      const versions = providerSnapshot.versions[provider.id];
      if (provider.detected && versions && (versions.cli || versions.plugin)) {
        const versionLine = document.createElement("span");
        versionLine.className = "provider-version";
        versionLine.textContent = [
          versions.cli ? t("ui.providers.version.cli", versions.cli) : undefined,
          versions.plugin ? t("ui.providers.version.plugin", versions.plugin) : undefined
        ].filter(Boolean).join(" · ");
        row.append(versionLine);
      }
      if (provider.detected && versions && typeof versions.pluginCurrent === "boolean") {
        const updateState = document.createElement("span");
        updateState.className = "provider-update-state";
        updateState.dataset.current = String(versions.pluginCurrent);
        updateState.textContent = t(versions.pluginCurrent ? "ui.providers.update.current" : "ui.providers.update.available");
        row.append(updateState);
      }
      if (provider.detected && provider.id !== "antigravity") {
        const versionControls = document.createElement("div");
        versionControls.className = "provider-version-controls";
        const versionInput = document.createElement("select");
        versionInput.setAttribute("aria-label", t("ui.providers.cli.version.label", providerNames[provider.id]));
        versionInput.dataset.providerControl = provider.id + ":install-version-select";
        populateVersionSelect(versionInput, providerCatalog?.cli?.[provider.id], providerInstallVersions.get(provider.id) ?? "", providerCatalog?.errors?.[provider.id]);
        const installVersion = document.createElement("button");
        installVersion.type = "button";
        installVersion.dataset.providerControl = provider.id + ":install-version";
        installVersion.textContent = t("ui.providers.install");
        const updateVersionButton = () => { installVersion.disabled = providerSnapshot.busy || !versionInput.value; };
        const submitVersion = () => {
          const version = versionInput.value;
          if (installVersion.disabled) return;
          vscode.postMessage({ type: "providers.cli.install", provider: provider.id, version });
        };
        versionInput.addEventListener("change", function () {
          providerInstallVersions.set(provider.id, versionInput.value);
          updateVersionButton();
        });
        installVersion.addEventListener("click", submitVersion);
        updateVersionButton();
        versionControls.append(versionInput, installVersion);
        row.append(versionControls);
      } else if (provider.detected) {
        const unsupported = document.createElement("span");
        unsupported.className = "provider-version";
        unsupported.textContent = t("ui.providers.cli.version.unsupported");
        row.append(unsupported);
      }
      const problems = [];
      if (!provider.detected && provider.configuredInvalid && typeof provider.configuredPath === "string") problems.push(t("ui.providers.configured.invalid"));
      if (typeof providerSnapshot.errors[provider.id] === "string") problems.push(t("ui.providers.plugin.failed", providerSnapshot.errors[provider.id]));
      for (const text of problems) {
        const problem = document.createElement("p");
        problem.className = "provider-error";
        problem.textContent = text;
        row.append(problem);
      }
      const edit = document.createElement("div");
      edit.className = "provider-path-edit";
      const input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      input.dataset.providerControl = provider.id + ":input";
      // A failed manual override can fall back to a working auto-detected executable.
      // Show the executable actually used for this provider, not the stale override.
      const displayedPath = provider.detected && typeof provider.path === "string"
        ? provider.path : provider.configuredPath ?? "";
      input.value = providerDrafts.get(provider.id) ?? displayedPath;
      input.placeholder = t("ui.providers.path.placeholder");
      input.setAttribute("aria-label", t("ui.providers.path", providerNames[provider.id]));
      input.disabled = providerSnapshot.busy;
      let lastSubmittedPath = displayedPath;
      const submit = () => {
        const path = input.value.trim();
        if (providerSnapshot.busy || !path || path === lastSubmittedPath) return;
        lastSubmittedPath = path;
        vscode.postMessage({ type: "providers.configure", provider: provider.id, path });
      };
      input.addEventListener("input", function () { providerDrafts.set(provider.id, input.value); });
      input.addEventListener("blur", function (event) {
        if (!edit.contains(event.relatedTarget)) submit();
      });
      input.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        submit();
      });
      const pick = document.createElement("button");
      pick.type = "button";
      pick.dataset.providerControl = provider.id + ":pick";
      pick.textContent = t("ui.providers.pick");
      pick.disabled = providerSnapshot.busy;
      pick.addEventListener("click", function () { vscode.postMessage({ type: "providers.pick", provider: provider.id }); });
      const clear = document.createElement("button");
      clear.type = "button";
      clear.dataset.providerControl = provider.id + ":clear";
      clear.textContent = t("ui.providers.clear");
      clear.disabled = providerSnapshot.busy;
      clear.setAttribute("aria-pressed", String(provider.detected ? provider.source !== "configured" : !provider.configuredPath));
      clear.addEventListener("click", function () {
        providerDrafts.delete(provider.id);
        vscode.postMessage({ type: "providers.configure", provider: provider.id, path: "" });
      });
      edit.append(input, pick, clear);
      if (provider.detected) edit.append(renderLogin(provider));
      row.append(edit);
      if (provider.detected) section.append(row);
      else missingList?.append(row);
    }
    if (missingDetails) section.append(missingDetails);
    root.replaceChildren(section);
    if (focused) {
      const target = root.querySelector('[data-provider-control="' + focused + '"]');
      if (target && !target.disabled) target.focus();
      else if (providerSnapshot.busy) root.querySelector('[data-provider-control$=":input"]')?.focus();
    }
  }

  return {
    receiveProviders,
    receiveAuth,
    get providerCatalog() { return providerCatalog; },
    set providerCatalog(value) { providerCatalog = value; },
    get providerVersionsRequested() { return providerVersionsRequested; },
    set providerVersionsRequested(value) { providerVersionsRequested = value; },
    renderProviderSettings
  };
};
