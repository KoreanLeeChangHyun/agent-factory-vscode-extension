globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.terminal = function (host) {
  "use strict";

  const {
    t, createActivityPhase, timeline, chatSyntax
  } = host;

  let commandDisclosureObserver;
  let commandDisclosureFrame;
  let commandOutputObserver;
  let commandOutputFrame;
  const lazyCommandOutputs = new WeakMap();
  const dirtyCommandBlocks = new Set();
  const dirtyOutputBlocks = new Set();
  let measureAllCommands = false;
  let measureAllOutputs = false;
  function renderTerminalCommand(container, command, phaseValue, title) {
    container.classList.add("terminal-command-content");
    const row = document.createElement("div");
    row.className = "terminal-command-row";
    const prompt = document.createElement("span");
    prompt.className = "terminal-command-prompt";
    prompt.textContent = phaseValue === "failed" ? t("ui.failed.0f4f56") : phaseValue === "completed" ? t("ui.ran") : t("ui.running");
    const text = document.createElement("div");
    text.className = "bash-command-text";
    if (title) {
      const context = document.createElement("span");
      context.className = "terminal-command-context";
      context.textContent = readActivityDisplayTitle(title, phaseValue);
      context.title = command;
      text.append(context);
      row.append(createActivityPhase(phaseValue), text);
      container.append(row);
      return;
    }
    const commandCode = document.createElement("span");
    commandCode.className = "syntax-code";
    commandCode.textContent = command;
    text.append(prompt, commandCode);
    row.append(createActivityPhase(phaseValue), text);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "bash-command-toggle";
    toggle.setAttribute("aria-label", t("ui.expand.full.command"));
    toggle.title = t("ui.expand.full.command");
    toggle.setAttribute("aria-expanded", "false");
    toggle.hidden = true;
    const toggleIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    toggleIcon.setAttribute("viewBox", "0 0 16 16");
    toggleIcon.setAttribute("aria-hidden", "true");
    toggleIcon.setAttribute("focusable", "false");
    const togglePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    togglePath.setAttribute("d", "m4 6 4 4 4-4");
    toggleIcon.append(togglePath);
    toggle.append(toggleIcon);
    toggle.addEventListener("click", function () {
      setCommandExpanded(text, toggle, !text.classList.contains("is-expanded"));
    });
    const commandBlock = document.createElement("div");
    commandBlock.className = "terminal-command-block";
    commandBlock.append(row, toggle);
    container.append(commandBlock);
    if (!commandDisclosureObserver) {
      commandDisclosureObserver = new ResizeObserver(function () {
        measureAllCommands = true;
        scheduleCommandDisclosureMeasurement();
      });
      commandDisclosureObserver.observe(timeline);
    }
    scheduleCommandDisclosureMeasurement(commandBlock);
    void chatSyntax.applySyntaxHighlighting(commandCode, command, "bash").then(function () {
      scheduleCommandDisclosureMeasurement(commandBlock);
    });
  }
  function setCommandExpanded(text, toggle, expanded) {
    text.classList.toggle("is-expanded", expanded);
    toggle.classList.toggle("is-expanded", expanded);
    toggle.setAttribute("aria-label", expanded ? t("ui.collapse.command") : t("ui.expand.full.command"));
    toggle.title = expanded ? t("ui.collapse.command") : t("ui.expand.full.command");
    toggle.setAttribute("aria-expanded", String(expanded));
    if (expanded) toggle.hidden = false;
  }
  function scheduleCommandDisclosureMeasurement(block) {
    if (block) dirtyCommandBlocks.add(block);
    if (commandDisclosureFrame) return;
    commandDisclosureFrame = requestAnimationFrame(function () {
      commandDisclosureFrame = undefined;
      const blocks = measureAllCommands ? timeline.querySelectorAll(".terminal-command-block") : dirtyCommandBlocks;
      const updates = [];
      for (const block of blocks) {
        if (!block.isConnected) continue;
        const text = block.querySelector(".bash-command-text");
        const toggle = block.querySelector(".bash-command-toggle");
        if (!text || !toggle || text.classList.contains("is-expanded")) continue;
        updates.push([toggle, text.scrollHeight <= text.clientHeight + 1]);
      }
      dirtyCommandBlocks.clear();
      measureAllCommands = false;
      for (const [toggle, hidden] of updates) if (toggle.hidden !== hidden) toggle.hidden = hidden;
    });
  }
  function readActivityDisplayTitle(title, phase) {
    const skill = /^(?:Read Skill|Skill 읽기) · (.*)$/.exec(title);
    if (skill) return t(phase === "started" ? "activity.skill.reading" : "activity.skill.read", skill[1]);
    if (["Read run result", "실행 결과 읽기"].includes(title)) return t(phase === "started" ? "activity.result.reading" : "activity.result.read");
    return title;
  }
  function createCommandOutput(text) {
    const output = document.createElement("pre");
    output.className = "terminal-command-output";
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    marker.setAttribute("viewBox", "0 0 16 24");
    marker.setAttribute("aria-hidden", "true");
    marker.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M4 3v9h7");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    marker.append(path);
    output.append(marker, globalThis.agentFactoryAnsi
      ? globalThis.agentFactoryAnsi.render(text, document)
      : document.createTextNode(text));
    return output;
  }
  function renderCommandOutput(container, output, collapsed) {
    if (typeof output !== "string") return;
    const block = document.createElement("div");
    block.className = "terminal-output-block";
    block.classList.toggle("terminal-output-collapsed", collapsed);
    const text = output || t("ui.no.output");
    block.classList.toggle("is-empty", !output);
    // Bound preview work by both lines and bytes; full evidence stays available on demand.
    let previewText = text.slice(0, 2048).split("\n").slice(0, 8).join("\n");
    const truncated = previewText.length < text.length;
    if (truncated) previewText += "\x1b[0m…";
    const preview = createCommandOutput(previewText);
    preview.classList.add("terminal-output-preview");
    const details = document.createElement("details");
    details.className = "terminal-output-details";
    const summary = document.createElement("summary");
    summary.textContent = t("ui.view.run.result");
    details.append(summary);
    let loaded = false;
    function loadOutput() {
      if (loaded) return;
      loaded = true;
      details.append(createCommandOutput(text));
    }
    lazyCommandOutputs.set(details, loadOutput);
    summary.addEventListener("click", function () {
      if (!details.open) loadOutput();
    });
    details.addEventListener("toggle", function () {
      if (details.open) loadOutput();
      scheduleCommandOutputMeasurement(block);
    });
    block.dataset.truncated = String(truncated);
    block.append(preview, details);
    container.append(block);
    if (!commandOutputObserver) {
      commandOutputObserver = new ResizeObserver(function () {
        measureAllOutputs = true;
        scheduleCommandOutputMeasurement();
      });
      commandOutputObserver.observe(timeline);
    }
    scheduleCommandOutputMeasurement(block);
  }
  function scheduleCommandOutputMeasurement(block) {
    if (block) dirtyOutputBlocks.add(block);
    if (commandOutputFrame) return;
    commandOutputFrame = requestAnimationFrame(function () {
      commandOutputFrame = undefined;
      const blocks = measureAllOutputs ? timeline.querySelectorAll(".terminal-output-block") : dirtyOutputBlocks;
      const updates = [];
      for (const block of blocks) {
        if (!block.isConnected) continue;
        const preview = block.querySelector(".terminal-output-preview");
        const details = block.querySelector(".terminal-output-details");
        updates.push([details, !details.open && block.dataset.truncated !== "true" && !block.classList.contains("terminal-output-collapsed") && preview.scrollHeight <= preview.clientHeight + 1]);
      }
      dirtyOutputBlocks.clear();
      measureAllOutputs = false;
      for (const [details, hidden] of updates) if (details.hidden !== hidden) details.hidden = hidden;
    });
  }

  return {
    readActivityDisplayTitle, renderTerminalCommand, renderCommandOutput, lazyCommandOutputs,
    setCommandExpanded
  };
};
