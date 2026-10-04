globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.agentSettings = function (host) {
  "use strict";

  const {
    state, t, fastModeButton, currentCapabilities, settingOptions, reasoningDisplayLabel, createId,
    uiLocale, normalizeAgentFastModes, persist, saveComposerSettings, updateModeControls, vscode,
    modelMenu, createModeIcon, fastModeSetting, closeSettingMenu, executionModeName,
    executionModeExplanation, renderStatusBar
  } = host;

  function agentSettingRole(role) {
    return role === "main" ? state.role || "main" : role;
  }
  function effectiveAgentValue(role, field) {
    const own = role === "main" ? (field === "model" ? state.model : field === "reasoningEffort" ? state.reasoning : state.fastMode) : state.agentModels?.[role]?.[field];
    if (field !== "fast") return own || "";
    const model = role === "main" ? state.model : state.agentModels?.[role]?.model || (role === "workLight" ? state.agentModels?.work?.model : "");
    return agentFastMode(role, model, own);
  }
  function effectiveDelegatedModels() {
    return Object.fromEntries(["work", "workLight", "verification"].map(role => {
      const model = effectiveAgentValue(role, "model");
      return [role, {
        model: model || undefined,
        reasoningEffort: effectiveAgentValue(role, "reasoningEffort") || undefined,
        ...(model && modelRoute(model) === "codex" ? { fast: effectiveAgentValue(role, "fast") } : {})
      }];
    }));
  }
  function createAgentSettingControl(role, label, field, current, onChange, lockRoute = true) {
    const wrapper = document.createElement(field === "fast" ? "div" : "label");
    const fieldLabel = field === "model" ? t("ui.model") : field === "reasoningEffort" ? t("ui.reasoning") : t("ui.fast");
    const caption = document.createElement("span");
    caption.className = "agent-model-caption";
    caption.textContent = fieldLabel;
    wrapper.append(caption);
    if (field === "fast") {
      wrapper.classList.add("agent-fast-control");
      const control = fastModeButton.cloneNode(true);
      control.removeAttribute("id");
      control.removeAttribute("hidden");
      control.dataset.role = role;
      control.dataset.field = field;
      const value = control.querySelector("span");
      value?.removeAttribute("id");
      const update = () => {
        control.setAttribute("aria-pressed", String(current === true));
        control.setAttribute("aria-label", label + " " + (current === true ? t("ui.fast.mode.on") : t("ui.fast.mode.off")));
        control.title = t("ui.fast") + " · " + t(current === true ? "ui.on" : "ui.off");
        if (value) value.textContent = t(current === true ? "ui.on" : "ui.off");
      };
      control.disabled = lockRoute && role === "main" && currentCapabilities().fast !== true;
      control.addEventListener("click", function (event) {
        event.stopPropagation();
        if (control.disabled) return;
        current = current !== true;
        update();
        onChange(current);
      });
      update();
      wrapper.append(control);
      return wrapper;
    }
    const explicitValues = field === "model" ? [...new Set([...settingOptions.model, current].filter(value => typeof value === "string" && value.length > 0))] : settingOptions.reasoning.filter(Boolean);
    const values = explicitValues;
    const isReasoning = field === "reasoningEffort";
    const control = document.createElement(isReasoning ? "input" : "button");
    control.dataset.role = role;
    control.dataset.field = field;
    control.setAttribute("aria-label", label + " " + fieldLabel);
    const output = document.createElement("span");
    let slider;
    let progress;
    if (isReasoning) {
      wrapper.classList.add("agent-reasoning-control");
      output.className = "agent-reasoning-value";
      control.type = "range";
      control.min = "0";
      control.max = String(values.length - 1);
      control.step = "1";
      control.value = String(Math.max(0, values.indexOf(current || "")));
      wrapper.append(output);
      slider = document.createElement("span");
      slider.className = "agent-reasoning-slider";
      progress = document.createElement("progress");
      progress.max = values.length - 1;
      progress.setAttribute("aria-hidden", "true");
      const ticks = document.createElement("span");
      ticks.className = "agent-reasoning-ticks";
      ticks.setAttribute("aria-hidden", "true");
      for (const value of values) {
        const tick = document.createElement("span");
        tick.title = reasoningDisplayLabel(value);
        ticks.append(tick);
      }
      slider.append(progress, ticks);
    } else {
      control.type = "button";
      control.id = "agent-model-" + role + "-" + createId();
      renderModelPicker(wrapper, control, values, current || "", role === "main" && lockRoute);
    }
    const selectedValue = () => isReasoning ? values[Number(control.value)] : control.value;
    const showEffort = () => {
      if (!isReasoning) return;
      const value = selectedValue();
      const ultra = value === "max";
      wrapper.classList.toggle("is-ultra", ultra);
      output.textContent = ultra ? "ULTRA" : value && uiLocale() === "en" ? value.toUpperCase() : reasoningDisplayLabel(value);
      output.title = ultra ? t("ui.ultra.max.reasoning.effort") : reasoningDisplayLabel(value);
      control.setAttribute("aria-valuetext", reasoningDisplayLabel(value));
      progress.value = Number(control.value);
    };
    showEffort();
    control.disabled = lockRoute && currentCapabilities()[isReasoning ? "reasoning" : "model"] !== true;
    if (isReasoning) {
      control.addEventListener("input", function () {
        if (control.disabled) return;
        showEffort();
      });
      control.addEventListener("change", function () {
        if (control.disabled) return;
        showEffort();
        onChange(selectedValue());
      });
    } else control.addEventListener("change", function () {
      if (control.disabled) return;
      onChange(selectedValue());
    });
    if (slider) {
      slider.append(control);
      wrapper.append(slider);
    } else if (!control.classList.contains("model-picker-button")) wrapper.append(control);
    return wrapper;
  }

  // Vendor tabs group a long catalog. A route is the CLI that runs the model: Codex, Claude Code
  // or Antigravity (gemini-* and antigravity/<id>, which may be another vendor's model).
  const MODEL_VENDORS = [["openai", "OpenAI"], ["anthropic", "Anthropic"], ["google", "Google"]];
  function agentFastMode(role, model, fallback = false) {
    return model && typeof state.agentFastModes?.[agentSettingRole(role)]?.[model] === "boolean" ? state.agentFastModes[agentSettingRole(role)][model] : fallback === true;
  }
  function setAgentFastMode(role, model, enabled) {
    if (!model) return;
    const storedRole = agentSettingRole(role);
    state.agentFastModes = {...state.agentFastModes, [storedRole]: {...state.agentFastModes?.[storedRole], [model]: enabled === true}};
    if (role === "main" && state.model === model) state.fastMode = enabled === true;
    else if (state.agentModels?.[role]?.model === model) state.agentModels = {...state.agentModels, [role]: {...state.agentModels[role], fast: enabled === true}};
  }
  function modelRoute(model) {
    return model.startsWith("antigravity/") || model.startsWith("gemini-") ? "antigravity" : model.startsWith("claude-") ? "claude" : "codex";
  }
  function modelVendor(model) {
    const id = model.replace(/^antigravity\//, "");
    return id.startsWith("claude-") ? "anthropic" : id.startsWith("gemini-") ? "google" : "openai";
  }
  function modelOptionLabel(model) {
    return model.startsWith("antigravity/") ? model.slice("antigravity/".length) + " · Antigravity" : model;
  }

  function hasStartedModelConversation() {
    return Boolean(state.running || state.pendingRequests?.some(item => !item.rejected) ||
      state.startedMessageIds?.length || state.timeline?.some(item => item.type === "user" || item.type === "assistant"));
  }

  function renderModelPicker(wrapper, control, values, current, lockRoute) {
    const models = values.filter(Boolean);
    wrapper.classList.add("agent-model-picker");
    const locked = lockRoute ? currentCapabilities().sessionProvider : undefined;
    const popup = document.createElement("div");
    popup.className = "model-picker-popup";
    popup.hidden = true;
    const tabs = document.createElement("div");
    tabs.className = "model-vendor-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", t("ui.model.vendor"));
    let active = current ? modelVendor(current) : (MODEL_VENDORS.find(([vendor]) => models.some(m => modelVendor(m) === vendor)) || MODEL_VENDORS[0])[0];
    let selectedModel = current || "";
    const list = document.createElement("div");
    list.className = "model-picker-list";
    list.id = control.id + "-list";
    list.setAttribute("role", "listbox");
    control.className = "model-picker-button";
    control.value = selectedModel;
    control.setAttribute("role", "combobox");
    control.setAttribute("aria-haspopup", "dialog");
    control.setAttribute("aria-controls", list.id);
    control.setAttribute("aria-expanded", "false");
    const close = (focus = false) => {
      popup.hidden = true;
      control.setAttribute("aria-expanded", "false");
      if (focus) control.focus();
    };
    const open = () => {
      if (control.disabled) return;
      popup.hidden = false;
      control.setAttribute("aria-expanded", "true");
      show();
      const box = control.getBoundingClientRect();
      const width = Math.min(Math.max(box.width, 250), window.innerWidth - 16);
      popup.style.left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8)) + "px";
      popup.style.width = width + "px";
      popup.style.bottom = Math.max(8, window.innerHeight - box.top + 4) + "px";
      popup.style.maxHeight = Math.max(72, box.top - 12) + "px";
      list.style.maxHeight = Math.max(32, box.top - 60) + "px";
      (list.querySelector('[aria-selected="true"]') || list.querySelector("button:not(:disabled)"))?.focus();
    };
    const show = () => {
      for (const tab of tabs.children) {
        const selected = tab.dataset.vendor === active;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      list.replaceChildren();
      for (const model of models.filter(item => modelVendor(item) === active)) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "model-picker-option";
        option.dataset.value = model;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(model === selectedModel));
        option.textContent = modelOptionLabel(model);
        option.disabled = Boolean(locked && modelRoute(model) !== locked && model !== current);
        option.addEventListener("click", event => {
          event.stopPropagation();
          if (option.disabled) return;
          selectedModel = model;
          control.value = model;
          control.textContent = modelOptionLabel(model);
          control.title = modelOptionLabel(model);
          active = modelVendor(model);
          control.dispatchEvent(new Event("change"));
          close(true);
        });
        list.append(option);
      }
    };
    for (const [vendor, name] of MODEL_VENDORS) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "model-vendor-tab";
      tab.dataset.vendor = vendor;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", list.id);
      tab.textContent = name;
      tab.disabled = !models.some(model => modelVendor(model) === vendor && (!locked || modelRoute(model) === locked || model === current));
      tab.addEventListener("click", event => {
        event.stopPropagation();
        if (tab.disabled || control.disabled) return;
        active = vendor;
        show();
        list.querySelector("button:not(:disabled)")?.focus();
      });
      tab.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const enabled = [...tabs.children].filter(item => !item.disabled);
        const index = enabled.indexOf(tab);
        const next = event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1)
          : enabled[(index + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length];
        next?.click();
        next?.focus();
      });
      tabs.append(tab);
    }
    control.textContent = selectedModel ? modelOptionLabel(selectedModel) : t("ui.default");
    control.title = selectedModel ? modelOptionLabel(selectedModel) : "";
    control.addEventListener("click", () => popup.hidden ? open() : close(false));
    popup.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !event.target.classList.contains("model-picker-option")) return;
      event.preventDefault();
      const enabled = [...list.querySelectorAll("button:not(:disabled)")];
      const index = enabled.indexOf(event.target);
      const next = event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1)
        : enabled[(index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length];
      next?.focus();
    });
    wrapper.addEventListener("focusout", event => {
      if (!wrapper.contains(event.relatedTarget)) close(false);
    });
    show();
    popup.append(tabs, list);
    wrapper.append(control, popup);
  }

  function agentSettingsApplyError(values) {
    const nextOwn = values?.[state.role === "main" ? "main" : state.role] || {};
    const nextModel = nextOwn.model || state.model || settingOptions.model.find(Boolean);
    const nextReasoning = nextOwn.reasoningEffort || state.reasoning || "medium";
    const capabilities = currentCapabilities();
    const started = hasStartedModelConversation();
    const locked = capabilities.sessionProvider;
    if (locked && modelRoute(nextModel) !== locked) return t("ui.model.provider.fixed");
    if (started && capabilities.model !== true && nextModel !== state.model) return t("ui.model.change.unavailable.active.chat");
    if (started && capabilities.reasoning !== true && nextReasoning !== (state.reasoning || "medium")) return t("ui.reasoning.change.unavailable.active.chat");
    return "";
  }

  function applyAgentSettingsToChat(values, scope, name) {
    const error = agentSettingsApplyError(values);
    const status = document.getElementById("agent-preset-status");
    if (error) { status.hidden = false; status.textContent = error; return false; }
    const nextOwn = values?.[state.role === "main" ? "main" : state.role] || {};
    state.model = nextOwn.model || state.model || settingOptions.model.find(Boolean);
    state.reasoning = nextOwn.reasoningEffort || state.reasoning || "medium";
    state.agentFastModes = normalizeAgentFastModes(values?.fastByRoleModel, values?.fastByModel);
    if (nextOwn.model) state.fastMode = agentFastMode("main", nextOwn.model, nextOwn.fast);
    if (state.role === "main") state.agentModels = {
      ...state.agentModels,
      ...(values.work ? {work: {...values.work, fast: agentFastMode("work", values.work.model, values.work.fast)}} : {}),
      ...(values.workLight || values.work ? {workLight: {...(values.work || {}), ...(values.workLight || {}), fast: agentFastMode("workLight", values.workLight?.model || values.work?.model, values.workLight?.fast ?? values.work?.fast)}} : {}),
      ...(values.verification ? {verification: {...values.verification, fast: agentFastMode("verification", values.verification.model, values.verification.fast)}} : {})
    };
    state.agentSettingsScope = scope;
    state.agentSettingsSet = name;
    const scopeControl = document.getElementById("agent-default-scope");
    if (scopeControl) scopeControl.value = scope;
    status.textContent = "";
    status.hidden = true;
    persist();
    saveComposerSettings();
    updateModeControls();
    return true;
  }

  function renderAgentDefaults() {
    const container = document.getElementById("agent-default-fields");
    const scopeControl = document.getElementById("agent-default-scope");
    if (!container || !scopeControl) return;
    const settings = state.agentDefaults || {};
    if (!settings.projectAvailable && scopeControl.value === "project") scopeControl.value = "chat";
    const projectOption = scopeControl.querySelector('option[value="project"]');
    if (projectOption) projectOption.disabled = !settings.projectAvailable;
    const scope = scopeControl.value;
    if (scope === "chat") return; // Chat overrides are the model menu's own rows.
    container.replaceChildren();
    container.classList.add("aligned-settings");
    renderAgentPresets();
    const columns = document.createElement("div");
    columns.className = "agent-settings-columns";
    columns.setAttribute("aria-hidden", "true");
    for (const key of ["ui.agent", "ui.model", "ui.reasoning", "ui.fast"]) {
      const column = document.createElement("span"); column.textContent = t(key); columns.append(column);
    }
    container.append(columns);
    for (const role of ["main", "work", "workLight", "verification"]) {
      const row = document.createElement("div"); row.className = "agent-model-row";
      row.dataset.agentRole = role;
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", t("ui.role." + role));
      const heading = document.createElement("strong"); heading.textContent = t("ui.role." + role); heading.className = "agent-model-name"; heading.prepend(createAgentRoleIcon(role)); row.append(heading);
      for (const field of ["model", "reasoningEffort", "fast"]) {
        const selectedModel = settings[scope]?.[role]?.model || "";
        const current = field === "fast" ? modelFastModeFromSettings(settings[scope], role, selectedModel, settings[scope]?.[role]?.fast) : settings[scope]?.[role]?.[field] || "";
        if (field === "fast" && (!selectedModel || modelRoute(selectedModel) !== "codex")) { row.append(createFastPlaceholder()); continue; }
        row.append(createAgentSettingControl(role, t("ui.role." + role), field, current, value => {
          const nextSettings = field === "fast"
            ? {...(settings[scope] || {}), fastByRoleModel: {...settings[scope]?.fastByRoleModel, [role]: {...settings[scope]?.fastByRoleModel?.[role], [selectedModel]: value === true}}}
            : {...(settings[scope] || {}), [role]: {...(settings[scope]?.[role] || {}), [field]: value}};
          state.agentDefaults[scope] = nextSettings;
          if (field === "fast") {
            vscode.postMessage({ type: "agent.defaults.fast", scope, role, model: selectedModel, value: value === true });
            autoSavePresetFast(role, selectedModel, value === true);
          } else {
            vscode.postMessage({ type: "agent.defaults.save", scope, role, field, value });
            autoSavePresetField(role, field, value);
          }
          renderAgentDefaults();
        }, false));
      }
      container.append(row);
    }
    if (agentPresetBusy) for (const control of container.querySelectorAll("input, select, button")) control.disabled = true;
  }

  function autoSavePresetField(role, field, value) {
    const name = document.getElementById("agent-preset-select").value;
    if (!name) return;
    vscode.postMessage({type: "agent.preset.field", scope: document.getElementById("agent-default-scope").value, name, role, field, value});
  }
  function autoSavePresetFast(role, model, value) {
    const name = document.getElementById("agent-preset-select").value;
    if (!name || !model) return;
    vscode.postMessage({type: "agent.preset.fast", scope: document.getElementById("agent-default-scope").value, name, role: agentSettingRole(role), model, value});
  }
  function modelFastModeFromSettings(settings, role, model, fallback = false) {
    return model && typeof settings?.fastByRoleModel?.[role]?.[model] === "boolean" ? settings.fastByRoleModel[role][model] : fallback === true;
  }
  function createFastPlaceholder() {
    const placeholder = document.createElement("div");
    placeholder.className = "agent-fast-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    return placeholder;
  }
  let agentPresetBusy = false;
  let pendingPresetName = "";
  let pendingPresetAction = "";
  function renderAgentPresets() {
    const select = document.getElementById("agent-preset-select");
    const scope = document.getElementById("agent-default-scope").value;
    const presets = (state.agentDefaults?.presets || []).filter(preset => preset.scope === scope);
    const desired = pendingPresetName || (state.agentSettingsScope === scope ? state.agentSettingsSet : "") || select.value;
    const selected = presets.some(preset => preset.name === desired) ? desired : presets.find(preset => preset.isDefault)?.name || "";
    select.replaceChildren();
    const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = t("preset.choose"); select.append(placeholder);
    for (const preset of presets) {
      const option = document.createElement("option"); option.value = preset.name; option.textContent = preset.isDefault ? t("preset.default") : preset.name;
      const error = scope === "chat" ? agentSettingsApplyError(preset.settings || {}) : "";
      option.disabled = Boolean(error);
      if (error) option.title = error;
      select.append(option);
    }
    select.value = Array.from(select.options).some(option => option.value === selected) ? selected : "";
    if (select.value === pendingPresetName) pendingPresetName = "";
    const providerBound = scope === "chat" && Boolean(currentCapabilities().sessionProvider);
    select.disabled = agentPresetBusy || providerBound;
    const selectedPreset = presets.find(preset => preset.name === select.value);
    document.getElementById("agent-preset-delete").disabled = agentPresetBusy || !select.value || selectedPreset?.isDefault === true;
    const rename = document.getElementById("agent-preset-rename");
    rename.querySelector("summary").setAttribute("aria-disabled", String(agentPresetBusy || !select.value || selectedPreset?.isDefault === true));
    document.getElementById("agent-preset-rename-name").disabled = agentPresetBusy || !select.value || selectedPreset?.isDefault === true;
    document.getElementById("agent-preset-rename-save").disabled = agentPresetBusy || !select.value || selectedPreset?.isDefault === true || !document.getElementById("agent-preset-rename-name").value.trim();
    document.getElementById("agent-preset-save").disabled = agentPresetBusy || !document.getElementById("agent-preset-name").value.trim();
    document.getElementById("agent-preset-name").disabled = agentPresetBusy;
    document.getElementById("agent-default-scope").disabled = agentPresetBusy;
  }
  function performPresetAction(action) {
    if (agentPresetBusy) return;
    if (action === "apply" && document.getElementById("agent-default-scope").value === "chat" && currentCapabilities().sessionProvider) return;
    const name = document.getElementById(action === "save" ? "agent-preset-name" : "agent-preset-select").value.trim();
    if (!name) return;
    const scope = document.getElementById("agent-default-scope").value;
    if (action === "apply") {
      const preset = state.agentDefaults?.presets?.find(item => item.scope === scope && item.name === name);
      if (!preset) return;
      const error = scope === "chat" ? agentSettingsApplyError(preset.settings || {}) : "";
      if (error) {
        const status = document.getElementById("agent-preset-status"); status.hidden = false; status.textContent = error;
        return;
      }
    }
    const newName = action === "rename" ? document.getElementById("agent-preset-rename-name").value.trim() : "";
    if (action === "rename" && !newName) return;
    if (action === "save" || action === "update" || action === "apply" || action === "rename") pendingPresetName = newName || name;
    pendingPresetAction = action;
    agentPresetBusy = true;
    const status = document.getElementById("agent-preset-status"); status.hidden = false; status.textContent = t("preset.busy");
    renderAgentDefaults();
    renderAgentPresets();
    if (scope === "chat" && action !== "delete") saveComposerSettings();
    vscode.postMessage({type: "agent.preset", action, scope: document.getElementById("agent-default-scope").value, name, ...(newName ? {newName} : {})});
  }
  for (const action of ["save", "delete"]) document.getElementById("agent-preset-" + action).addEventListener("click", () => performPresetAction(action));
  document.getElementById("agent-preset-name").addEventListener("input", renderAgentPresets);
  document.getElementById("agent-preset-rename-name").addEventListener("input", renderAgentPresets);
  document.getElementById("agent-preset-rename").addEventListener("toggle", event => {
    if (!event.currentTarget.open) return;
    const select = document.getElementById("agent-preset-select");
    const preset = (state.agentDefaults?.presets || []).find(item => item.scope === document.getElementById("agent-default-scope").value && item.name === select.value);
    if (!preset || preset.isDefault || agentPresetBusy) { event.currentTarget.open = false; return; }
    if (!document.getElementById("agent-preset-rename-name").value.trim()) document.getElementById("agent-preset-rename-name").value = preset.name;
    renderAgentPresets();
  });
  document.getElementById("agent-preset-rename-save").addEventListener("click", () => performPresetAction("rename"));
  document.getElementById("agent-preset-select").addEventListener("change", () => performPresetAction("apply"));

  document.getElementById("agent-default-scope")?.addEventListener("change", event => {
    if (host.openSettingId !== "model") { renderAgentDefaults(); return; }
    document.getElementById("agent-preset-select").value = "";
    renderModelSettings(modelMenu, true);
    event.currentTarget.focus(); // Re-rendering moves the select; keep keyboard focus on it.
  });

  function createAgentRoleIcon(role) {
    const paths = {
      main: "M4 5h16v11H9l-5 4V5Zm4 4h8m-8 3h5",
      work: "M9 7V4h6v3M3 7h18v13H3V7Zm0 5h18m-11 0v3h4v-3",
      workLight: "M9 7V4h6v3M3 7h18v13H3V7Zm5 7h8",
      verification: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6"
    };
    return createModeIcon(paths[role] || paths.main, "agent-role-icon");
  }

  function appendFastSetting(menu) {
    menu.append(fastModeSetting);
  }

  function renderModelSettings(menu, preserveScope = false, globalEditor = false) {
    // Scope and default controls are persistent nodes; park them so they stay in the document.
    document.getElementById("agent-scope-parts").append(document.getElementById("agent-scope-row"), document.getElementById("agent-defaults-content"));
    document.getElementById("agent-defaults-content").append(document.getElementById("agent-preset-content"));
    document.getElementById("agent-scope-parts").append(document.getElementById("agent-preset-picker"), document.getElementById("agent-preset-create"), document.getElementById("agent-preset-rename"), document.getElementById("agent-preset-delete"));
    menu.replaceChildren();
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", t("ui.models.and.reasoning"));
    const header = document.createElement("div");
    header.className = "agent-settings-heading";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "agent-settings-close";
    close.setAttribute("aria-label", t("ui.close.agent.settings"));
    close.append(createModeIcon("m6 6 12 12M18 6 6 18", "agent-settings-close-icon"));
    close.addEventListener("click", function () { closeSettingMenu(true); });
    const scopeControl = document.getElementById("agent-default-scope");
    const previousScope = scopeControl.value;
    scopeControl.replaceChildren();
    for (const [value, key] of globalEditor ? [["global", "ui.global.defaults"]] : [["project", "ui.project.defaults"], ["chat", "ui.chat.scope"]]) {
      const option = document.createElement("option"); option.value = value; option.textContent = t(key);
      option.disabled = value === "project" && !state.agentDefaults?.projectAvailable;
      scopeControl.append(option);
    }
    scopeControl.value = globalEditor ? "global" : preserveScope && ["project", "chat"].includes(previousScope) ? previousScope : "chat";
    document.getElementById("agent-scope-row").hidden = globalEditor;
    close.hidden = globalEditor;
    if (globalEditor) {
      const title = document.createElement("strong"); title.textContent = t("ui.global.agent.settings"); header.append(title);
    }
    header.append(document.getElementById("agent-scope-row"), document.getElementById("agent-preset-picker"), document.getElementById("agent-preset-create"), document.getElementById("agent-preset-rename"), document.getElementById("agent-preset-delete"), close);
    menu.classList.add("aligned-settings");
    menu.append(header);
    if (state.role !== "main" && state.capturedRun) {
      const captured = document.createElement("div");
      captured.className = "agent-captured-run";
      captured.textContent = t("ui.captured.run.model") + " · " + state.capturedRun.runId + " · " + (state.capturedRun.model || t("flow.model.unavailable"));
      menu.append(captured);
    }
    renderAgentPresets();
    if (scopeControl.value !== "chat") {
      menu.append(document.getElementById("agent-defaults-content"));
      renderAgentDefaults();
      return;
    }
    const columns = document.createElement("div");
    columns.className = "agent-settings-columns";
    columns.setAttribute("aria-hidden", "true");
    for (const text of [t("ui.agent"), t("ui.model"), t("ui.reasoning"), t("ui.fast")]) {
      const column = document.createElement("span");
      column.textContent = text;
      columns.append(column);
    }
    menu.append(columns);
    const roles = state.role === "main" ? [["main", t("ui.role.main")], ["work", t("ui.role.work")], ["workLight", t("ui.role.workLight")], ["verification", t("ui.role.verification")]] : [["main", state.role === "work" ? t("ui.work") : t("ui.verification")]];
    let initialized = false;
    for (const [role, label] of roles) {
      const row = document.createElement("div");
      row.className = "agent-model-row";
      row.dataset.agentRole = role;
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", label);
      const legend = document.createElement("strong");
      legend.className = "agent-model-name";
      legend.textContent = state.role !== "main" && state.capturedRun ? t("ui.next.message.model") : label;
      legend.prepend(createAgentRoleIcon(state.role === "main" ? role : state.role));
      row.append(legend);
      for (const field of ["model", "reasoningEffort", "fast"]) {
        const own = role === "main" ? (field === "model" ? state.model : field === "reasoningEffort" ? state.reasoning : state.fastMode) : state.agentModels?.[role]?.[field];
        // The light Work profile starts from the Work profile, never from Main's model.
        const current = field === "fast" ? effectiveAgentValue(role, field) : own || effectiveAgentValue(role, field) || (role === "workLight" ? effectiveAgentValue("work", field) : "") || (field === "model" ? state.model || settingOptions.model.find(Boolean) || "" : state.reasoning || "medium");
        const selectedModel = field === "model" ? current : effectiveAgentValue(role, "model") || (role === "workLight" ? effectiveAgentValue("work", "model") : "");
        if (field === "fast" && (!selectedModel || modelRoute(selectedModel) !== "codex")) { row.append(createFastPlaceholder()); continue; }
        if (own === undefined && current !== "") {
          if (role === "main") state[field === "model" ? "model" : field === "reasoningEffort" ? "reasoning" : "fastMode"] = current;
          else state.agentModels = { ...state.agentModels, [role]: { ...state.agentModels?.[role], [field]: current } };
          initialized = true;
        }
        row.append(createAgentSettingControl(role, label, field, current, value => {
          state.agentSettingsScope = "chat";
          state.agentSettingsSet = document.getElementById("agent-preset-select").value || "Default";
          if (field === "fast") setAgentFastMode(role, selectedModel, value === true);
          else if (role === "main") {
            state[field === "reasoningEffort" ? "reasoning" : "model"] = value;
            if (field === "model") state.fastMode = agentFastMode(role, value);
          } else {
            state.agentModels = { ...state.agentModels, [role]: { ...state.agentModels?.[role], [field]: value || undefined } };
            if (field === "model") state.agentModels[role].fast = agentFastMode(role, value);
          }
          updateModeControls();
          persist();
          saveComposerSettings();
          if (field === "fast") autoSavePresetFast(role, selectedModel, value === true);
          else autoSavePresetField(agentSettingRole(role), field, value);
          if ((field === "model" || field === "fast") && host.openSettingId === "model") renderModelSettings(modelMenu, true);
        }));
      }
      menu.append(row);
    }
    menu.append(document.getElementById("agent-preset-content"));
    if (initialized) { persist(); saveComposerSettings(); }
  }

  function renderGeneralSettings() {
    const menu = document.getElementById("general-permissions");
    menu.replaceChildren();
    if (state.role === "main") {
      const row = document.createElement("div");
      row.className = "agent-permissions-row";
      const legend = document.createElement("div");
      legend.className = "agent-permissions-heading";
      const name = document.createElement("strong");
      name.textContent = t("ui.permissions");
      legend.append(name);
      const select = document.createElement("select");
      select.dataset.setting = "permissions";
      select.setAttribute("aria-label", t("ui.execution.permissions"));
      for (const value of settingOptions.execution) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = executionModeName(value);
        option.selected = value === (state.executionMode ?? "cli-default");
        select.append(option);
      }
      const help = document.createElement("p");
      help.id = "agent-permissions-description";
      select.setAttribute("aria-describedby", help.id);
      const explain = () => { help.textContent = executionModeExplanation(select.value); help.hidden = !help.textContent; };
      explain();
      select.disabled = state.running;
      select.addEventListener("change", function () {
        if (state.running) return;
        state.executionMode = select.value;
        vscode.postMessage({ type: "execution.select", mode: select.value });
        explain(); renderStatusBar(); persist(); saveComposerSettings();
      });
      row.append(legend, select, help);
      menu.append(row);
    }
    if (state.role === "main") renderModelSettings(document.getElementById("global-agent-settings"), true, true);
    host.chatProviders.renderProviderSettings();
  }

  return {
    get agentPresetBusy() { return agentPresetBusy; },
    set agentPresetBusy(value) { agentPresetBusy = value; },
    get pendingPresetName() { return pendingPresetName; },
    set pendingPresetName(value) { pendingPresetName = value; },
    get pendingPresetAction() { return pendingPresetAction; },
    set pendingPresetAction(value) { pendingPresetAction = value; },
    applyAgentSettingsToChat, renderAgentDefaults, renderAgentPresets, renderModelSettings,
    effectiveDelegatedModels, effectiveAgentValue, renderGeneralSettings, modelOptionLabel
  };
};
