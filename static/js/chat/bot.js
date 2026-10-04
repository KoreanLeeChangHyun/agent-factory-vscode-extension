globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.bot = function (host) {
  "use strict";

  const {
    state, vscode, factoryBot, uiLocale, botDisplayName, persist, t, prompt, chatShortcuts
  } = host;

  let botOutcome;
  let botWaveTimer;
  let botIdleTimer;
  let botIdleSince;
  let botCareTimer;
  const botMenu = document.getElementById("bot-menu");
  let companionSnapshot;
  let botReplyEmotion;
  let companionWorking = 0;
  let companionOutcome;
  let companionOutcomeUntil = 0;
  let companionTimer;
  let companionReactionDismissedUntil = 0;
  const companionDock = document.getElementById("companion-dock");
  let botDrag;
  let suppressDragClick = false;
  function interactCompanion(action) {
    if (state.botsEnabled && state.companionAvailable) vscode.postMessage({ type: "bot.interact", action: action });
  }
  const companionRasterCache = new Map();
  const companionSources = new Map();
  function smoothCompanionSheet(sprite, scale) {
    if (!companionSources.has(sprite.dataset.sheet)) {
      sprite.style.backgroundImage = "";
      companionSources.set(sprite.dataset.sheet, getComputedStyle(sprite).backgroundImage);
    }
    const source = companionSources.get(sprite.dataset.sheet);
    sprite.dataset.source = source;
    const pixels = Math.max(1, Math.round(1254 * scale * window.devicePixelRatio));
    const key = source + ":" + pixels;
    if (sprite.dataset.rasterKey === key) return;
    sprite.dataset.rasterKey = key;
    sprite.style.backgroundImage = source;
    delete sprite.dataset.smoothed;
    if (!companionRasterCache.has(key)) {
      // Resample once at physical display resolution, rather than repeatedly
      // sampling the full atlas with the CSS background minification filter.
      const raster = (async function () {
        const sourceImage = new Image();
        sourceImage.src = source.slice(4, -1).replace(/^["']|["']$/g, "");
        await sourceImage.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = pixels;
        const context = canvas.getContext("2d");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(sourceImage, 0, 0, pixels, pixels);
        return canvas.toDataURL("image/png");
      })();
      companionRasterCache.set(key, raster);
    }
    companionRasterCache.get(key).then(function (url) {
      if (sprite.dataset.rasterKey !== key) return;
      sprite.style.backgroundImage = 'url("' + url + '")';
      sprite.dataset.smoothed = String(pixels);
    }).catch(function (error) {
      companionRasterCache.delete(key);
      if (sprite.dataset.rasterKey === key) delete sprite.dataset.rasterKey;
      console.warn("Companion resampling failed; keeping the source image", error);
    });
  }
  window.addEventListener("resize", function () { renderCompanion(); });
  function renderCompanion() {
    clearTimeout(companionTimer);
    const bubble = document.getElementById("companion-reaction");
    if (!state.companionAvailable || !companionSnapshot || !state.botsEnabled || !state.botVisible || document.hidden) {
      if (bubble) bubble.hidden = true;
      return;
    }
    const now = Date.now();
    const talking = !!botTalkPending || botSpeechVisible;
    const reacting = companionSnapshot.reactionUntil > now && !(talking && companionSnapshot.emotion === "sleepy");
    const asleep = !talking && now - companionSnapshot.lastInteractionAt >= 60000;
    const replyEmotion = botSpeechVisible && !botTalkPending ? botReplyEmotion : undefined;
    const emotion = replyEmotion ? replyEmotion
      : reacting ? companionSnapshot.emotion : asleep && !companionWorking ? "sleepy" : "calm";
    const positions = { happy: [0, 0], shy: [0, 1], love: [1, 1], surprised: [3, 0], playful: [2, 1], sleepy: [3, 2] };
    const sprite = factoryBot.querySelector(".companion-sprite");
    const outcome = !reacting && !companionWorking && companionOutcomeUntil > now ? companionOutcome : undefined;
    const activity = !replyEmotion ? (!reacting || emotion === "calm") && outcome !== "failed" : emotion === "calm";
    const idle = emotion === "calm" && activity && !reacting && !asleep && !companionWorking && !state.running && !outcome;
    const animateIdle = idle && state.botAnimations && !botReducedMotion.matches;
    const beats = [[0, 2800], [1, 150], [0, 1800], [2, 240], [0, 200], [3, 240], [0, 1400]];
    let phase = (now - companionSnapshot.lastInteractionAt) % 6830;
    let idleFrame = 0;
    let frameDelay = 0;
    if (animateIdle) {
      for (const [frame, duration] of beats) {
        if (phase < duration) { idleFrame = frame; frameDelay = duration - phase; break; }
        phase -= duration;
      }
    }
    const motion = replyEmotion ? "" : reacting && companionSnapshot.action === "feed" ? "eating"
      : !reacting && (companionWorking > 0 || state.running) ? "working" : "";
    let motionFrame = 0;
    if (motion && state.botAnimations && !botReducedMotion.matches) {
      const duration = motion === "working" ? 320 : 650;
      const elapsed = Math.max(0, now - companionSnapshot.lastInteractionAt);
      motionFrame = Math.floor(elapsed / duration) % 2;
      frameDelay = duration - elapsed % duration;
    }
    sprite.dataset.motion = motion;
    sprite.dataset.sheet = motion ? "work-food" : idle ? "idle" : activity ? "activities" : "emotions";
    sprite.dataset.frame = motion ? String(motionFrame) : idle ? String(idleFrame) : "";
    let position = positions[emotion] || [0, 0];
    if (activity) position = companionWorking ? [1, 0] : outcome === "completed" ? [0, 1] : asleep ? [1, 1] : [0, 0];
    else if (outcome === "failed") position = [2, 2];
    if (idle) position = [idleFrame % 2, Math.floor(idleFrame / 2)];
    if (motion) position = [motionFrame, motion === "eating" ? 1 : 0];
    // These are illustration sheets, not evenly spaced sprite atlases.
    // Exclude the next row's ear tips and preserve each source rectangle's aspect ratio.
    const rows = (activity || motion) ? [[0, 627], [627, 1254]] : [[0, 410], [414, 810], [812, 1220]];
    const sourceWidth = (activity || motion) ? 627 : 313.5;
    const sourceX = position[0] * sourceWidth;
    const sourceY = rows[position[1]][0];
    const sourceHeight = rows[position[1]][1] - sourceY;
    // Largest opaque character component, excluding floating decorative marks.
    const bodies = activity
      ? [[[98,5,525,617],[711,5,1158,627]],[[82,632,532,1223],[627,733,1217,1197]]]
      : [[[10,8,295,408],[325,13,619,405],[628,77,940,406],[952,9,1240,407]],
        [[12,437,311,797],[328,417,618,804],[646,423,933,810],[952,420,1240,803]],
        [[8,815,314,1202],[326,819,617,1206],[629,882,939,1206],[949,817,1249,1206]]];
    const idleBodies = [[[120,16,563,620],[693,16,1137,620]],[[118,633,563,1234],[692,635,1136,1234]]];
    const motionBodies = [[[88,14,559,624],[695,12,1165,625]],[[86,635,570,1235],[687,635,1168,1235]]];
    const body = (motion ? motionBodies : idle ? idleBodies : bodies)[position[1]][position[0]];
    const scale = Math.min((factoryBot.clientWidth - 4) / (body[2] - body[0]), 64 / (motion ? (motion === "working" ? 613 : 600) : idle ? 604 : body[3] - body[1]));
    sprite.style.left = ((factoryBot.clientWidth - (body[2] - body[0]) * scale) / 2 - (body[0] - sourceX) * scale) + "px";
    sprite.style.top = (factoryBot.clientHeight - (body[3] - sourceY) * scale) + "px";
    sprite.style.width = (sourceWidth * scale) + "px";
    sprite.style.height = (sourceHeight * scale) + "px";
    sprite.style.backgroundSize = (1254 * scale) + "px " + (1254 * scale) + "px";
    sprite.style.backgroundPosition = (-sourceX * scale) + "px " + (-sourceY * scale) + "px";
    smoothCompanionSheet(sprite, scale);
    factoryBot.dataset.emotion = emotion;
    factoryBot.dataset.interaction = reacting ? companionSnapshot.action : "";
    const ko = uiLocale().startsWith("ko");
    const phrases = ko ? { pet: "기분 좋아요!", praise: "칭찬해 주셔서 기뻐요!", feed: "잘 먹겠습니다!", play: "같이 놀아요!", sleep: "잠깐 쉬고 있을게요.", call: emotion === "surprised" ? "앗, 부르셨나요?" : "네, 여기 있어요!" }
      : { pet: "That feels nice!", praise: "Thank you!", feed: "Yum, thank you!", play: "Let's play!", sleep: "Time for a nap.", call: emotion === "surprised" ? "Oh! You called?" : "I'm here!" };
    bubble.textContent = reacting ? (companionWorking && motion !== "eating" ? (ko ? "조금만 기다려 주세요. 작업 중이에요!" : "One moment, I'm working!") : phrases[companionSnapshot.action]) : "";
    syncBotSpeechVisibility();
    factoryBot.title = botDisplayName() + " · " + (companionWorking ? (ko ? "작업 중 " : "Working: ") + companionWorking : emotion);
    factoryBot.setAttribute("aria-label", factoryBot.title);
    const next = reacting ? companionSnapshot.reactionUntil - now : outcome ? companionOutcomeUntil - now : 60000 - (now - companionSnapshot.lastInteractionAt);
    const delay = frameDelay > 0 ? Math.min(frameDelay, next > 0 ? next : Infinity) : next;
    if (delay > 0) companionTimer = setTimeout(function () { renderCompanion(); }, delay + 5);
  }
  botMenu.addEventListener("click", function (event) {
    const button = event.target.closest("[data-companion-action]");
    if (!button || button.disabled) return;
    if (!state.companionAvailable) {
      const action = button.dataset.companionAction;
      botIdleSince = Date.now();
      renderFactoryBot();
      state.botCare = { ...state.botCare, happiness: Math.min(100, state.botCare.happiness + (action === "call" ? 0 : 10)), careCount: state.botCare.careCount + (action === "call" ? 0 : 1) };
      clearTimeout(botGestureTimer);
      factoryBot.dataset.gesture = { pet: "shy", praise: "bow", call: "wave" }[action];
      botGestureTimer = setTimeout(function () { botGestureTimer = undefined; renderFactoryBot(); }, 5000);
      renderBotCare();
      persist();
    } else interactCompanion(button.dataset.companionAction);
    closeBotMenu(true);
  });
  function clampBotPosition(position) {
    return { x: Math.max(0, Math.min(window.innerWidth - factoryBot.offsetWidth, position.x)),
      y: Math.max(0, Math.min(window.innerHeight - factoryBot.offsetHeight, position.y)) };
  }
  function positionCompanion() {
    if (companionDock.hidden) return;
    if (!state.botPosition) {
      const composer = document.querySelector(".composer").getBoundingClientRect();
      // Keep the existing first perch, then store viewport pixels just like a drag.
      state.botPosition = clampBotPosition({ x: composer.right - factoryBot.offsetWidth,
        y: composer.top - factoryBot.offsetHeight });
      persist(false);
    }
    // The companion floats at its stored point; the status row and panel reserve no space for it.
    companionDock.dataset.moved = "true";
    // A smaller viewport changes only the display; widening restores the stored point.
    const next = clampBotPosition(state.botPosition);
    companionDock.style.left = next.x + "px";
    companionDock.style.top = next.y + "px";
    positionBotMenu();
    positionBotSpeech();
    positionAboveCompanion(document.getElementById("companion-reaction"));
  }
  factoryBot.addEventListener("pointerdown", function (event) {
    if (event.button !== 0 || !event.isPrimary || botDrag) return;
    suppressDragClick = false;
    const box = factoryBot.getBoundingClientRect();
    botDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: box.left, top: box.top, moved: false };
    factoryBot.setPointerCapture(event.pointerId);
  });
  factoryBot.addEventListener("pointermove", function (event) {
    if (!botDrag || botDrag.pointerId !== event.pointerId) return;
    const dx = event.clientX - botDrag.x, dy = event.clientY - botDrag.y;
    if (!botDrag.moved && Math.hypot(dx, dy) < 5) return;
    botDrag.moved = true;
    suppressDragClick = true;
    factoryBot.dataset.dragging = "true";
    document.documentElement.dataset.companionDragging = "true";
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    // A new drag chooses a new origin inside the current viewport, even after clamping.
    state.botPosition = clampBotPosition({ x: botDrag.left + dx, y: botDrag.top + dy });
    positionCompanion();
  });
  function endBotDrag(event) {
    if (!botDrag || (event?.pointerId !== undefined && botDrag.pointerId !== event.pointerId)) return;
    const drag = botDrag;
    botDrag = undefined;
    delete factoryBot.dataset.dragging;
    delete document.documentElement.dataset.companionDragging;
    if (factoryBot.hasPointerCapture(drag.pointerId)) factoryBot.releasePointerCapture(drag.pointerId);
    if (drag.moved) persist();
  }
  factoryBot.addEventListener("pointerup", endBotDrag);
  factoryBot.addEventListener("pointercancel", endBotDrag);
  factoryBot.addEventListener("lostpointercapture", endBotDrag);
  factoryBot.addEventListener("dragstart", event => event.preventDefault());
  window.addEventListener("blur", () => endBotDrag());
  window.addEventListener("resize", positionCompanion);
  // ResizeObserver also handles character switches, expanded tasks and draft height changes.
  new ResizeObserver(positionCompanion).observe(document.querySelector(".composer-region"));
  new ResizeObserver(positionCompanion).observe(factoryBot);
  function consumeDragClick(event) {
    const suppressed = suppressDragClick && event.detail !== 0;
    suppressDragClick = false;
    return suppressed;
  }

  let botRestingSince;
  let botGestureTimer;
  const botTalkButton = document.getElementById("bot-talk");
  const botSpeech = document.getElementById("bot-speech");
  // Escape the composer's stacking context so long replies stay interactive over the timeline.
  document.body.append(botSpeech, document.getElementById("companion-reaction"));
  const botSpeechText = document.getElementById("bot-speech-text");
  let botTalkPending;
  let botTalkSequence = 0;
  let botDraftRevision = 0;
  let botSpeechVisible = false;
  const botCharacterSelect = document.getElementById("bot-character");
  let botCharacter = "factory";
  let localBotAvailable = false;
  const botPromptDrafts = new Map();
  function receiveBotCharacter(message) {
    if (typeof message.localCompanionAvailable === "boolean") localBotAvailable = message.localCompanionAvailable;
    else if (message.type === "host.initialize") localBotAvailable = message.companionAvailable !== false;
    const next = message.botCharacter || (message.type === "host.initialize" ? (message.companionAvailable === false ? "factory" : "lumi") : botCharacter);
    if (next !== botCharacter) {
      botPromptDrafts.set(botCharacter, { draft: botPromptEditor.value, saved: botPromptSaved });
      botCharacter = next;
      const cached = botPromptDrafts.get(next);
      botPromptSaved = cached?.saved || "";
      botPromptEditor.value = cached?.draft || "";
      botPromptStatus.textContent = "";
      botSpeechVisible = false;
      companionSnapshot = undefined;
      botReplyEmotion = undefined;
    }
    state.companionAvailable = next === "lumi" && localBotAvailable;
    factoryBot.classList.toggle("sd-companion", state.companionAvailable);
    botMenu.querySelectorAll("[data-companion-action]").forEach(button => { button.hidden = false; });
    botCharacterSelect.value = next;
    botCharacterSelect.disabled = !!botPromptPending || !!botTalkPending;
  }
  botCharacterSelect.addEventListener("change", () => {
    botCharacterSelect.disabled = true;
    vscode.postMessage({ type: "bot.character.save", character: botCharacterSelect.value });
  });
  const botModelSelect = document.getElementById("bot-model");
  const botModelStatus = document.getElementById("bot-model-status");
  let botModelSaved = "";
  let botModelOptions = ["gpt-5.6-luna", "claude-haiku-4-5-20251001"];
  function renderBotModels() {
    const models = ["", ...new Set([...botModelOptions, botModelSaved].filter(Boolean))];
    botModelSelect.replaceChildren(...models.map(model => {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model || t("bot.model.auto");
      return option;
    }));
    botModelSelect.value = botModelSaved;
  }
  botModelSelect.addEventListener("focus", () => vscode.postMessage({ type: "models.request" }));
  botModelSelect.addEventListener("change", function () {
    botModelSelect.disabled = true;
    botModelStatus.textContent = t("bot.prompt.saving");
    vscode.postMessage({ type: "bot.model.save", model: botModelSelect.value });
  });
  const botPromptEditor = document.getElementById("bot-prompt");
  const botPromptSave = document.getElementById("bot-prompt-save");
  const botPromptReset = document.getElementById("bot-prompt-reset");
  const botPromptStatus = document.getElementById("bot-prompt-status");
  let botPromptSaved = "";
  let botDefaultPrompt = "";
  let botPromptPending;
  let botPromptSequence = 0;

  function updateBotPromptControls() {
    botCharacterSelect.disabled = !!botPromptPending || !!botTalkPending;
    botPromptSave.disabled = !!botPromptPending || botPromptEditor.value === botPromptSaved;
    botPromptReset.disabled = !!botPromptPending || botPromptEditor.value === botDefaultPrompt;
  }
  function receiveBotPrompt(value) {
    if (typeof value !== "string") return;
    if (!botPromptPending && botPromptEditor.value === botPromptSaved) botPromptEditor.value = value;
    botPromptSaved = value;
    updateBotPromptControls();
  }
  botPromptEditor.addEventListener("input", function () {
    botPromptStatus.textContent = "";
    updateBotPromptControls();
  });
  botPromptReset.addEventListener("click", function () {
    botPromptEditor.value = botDefaultPrompt;
    botPromptEditor.dispatchEvent(new Event("input"));
    botPromptEditor.focus();
  });
  botPromptSave.addEventListener("click", function () {
    if (botPromptSave.disabled || botPromptPending) return;
    botPromptPending = { requestId: "bot-prompt-" + Date.now() + "-" + (++botPromptSequence), prompt: botPromptEditor.value, character: botCharacter };
    botPromptStatus.textContent = t("bot.prompt.saving");
    updateBotPromptControls();
    vscode.postMessage({ type: "bot.prompt.save", ...botPromptPending });
  });
  let botReactionTimer;
  let botGestureKey;
  const botPlayActivities = ["dance", "balance", "stretch", "wave", "read"];
  let botLastPlayActivity;
  let botGlanceTimer;
  let botNextGlanceAt = 0;
  const botReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let botRenderKey;
  function closeBotMenu(restoreFocus = false) {
    clearTimeout(botCareTimer); botCareTimer = undefined;
    botMenu.hidden = true;
    factoryBot.setAttribute("aria-expanded", "false");
    if (restoreFocus) factoryBot.focus();
  }
  function positionBotMenu() {
    if (botMenu.hidden) return;
    const box = factoryBot.getBoundingClientRect();
    botMenu.style.left = Math.max(8, Math.min(window.innerWidth - botMenu.offsetWidth - 8, box.right - botMenu.offsetWidth)) + "px";
    const top = box.top - botMenu.offsetHeight - 8;
    botMenu.style.top = Math.max(8, Math.min(window.innerHeight - botMenu.offsetHeight - 8, top >= 8 ? top : box.bottom + 8)) + "px";
  }
  function talkToBot() {
    if (botTalkButton.disabled || botTalkPending || !state.botsEnabled || !prompt.value.trim()) return;
    startBotConversation(prompt.value, true);
  }
  function startBotConversation(text, fromComposer) {
    if (botTalkPending || !state.botsEnabled || !text.trim()) return;
    botReplyEmotion = undefined;
    botTalkPending = { requestId: "bot-" + Date.now() + "-" + (++botTalkSequence),
      text, fromComposer, revision: botDraftRevision };
    if (fromComposer) {
      prompt.value = "";
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    }
    botTalkPending.revision = botDraftRevision;
    persist();
    closeBotMenu();
    prompt.focus({ preventScroll: true });
    showBotSpeech(t("bot.thinking"));
    renderBotTalk();
    vscode.postMessage({ type: "bot.talk", requestId: botTalkPending.requestId, text: botTalkPending.text });
  }
  function showBotSpeech(text) {
    botSpeechText.textContent = text;
    botSpeechVisible = true;
    renderBotTalk();
  }
  function positionBotSpeech() {
    if (botSpeech.hidden) return;
    botSpeech.style.width = Math.min(300, window.innerWidth - 16) + "px";
    positionAboveCompanion(botSpeech);
  }
  function positionAboveCompanion(bubble) {
    if (!bubble || bubble.hidden) return;
    const box = factoryBot.getBoundingClientRect();
    const above = box.top - 16, below = window.innerHeight - box.bottom - 16;
    const useAbove = above >= Math.min(160, bubble.scrollHeight) || above >= below;
    const available = Math.max(1, useAbove ? above : below);
    bubble.style.maxHeight = available + "px";
    if (bubble === botSpeech) botSpeechText.style.maxHeight = Math.max(1, available - 32) + "px";
    bubble.style.left = Math.max(8, Math.min(window.innerWidth - bubble.offsetWidth - 8, box.right - bubble.offsetWidth)) + "px";
    bubble.style.top = Math.max(8, Math.min(window.innerHeight - bubble.offsetHeight - 8,
      useAbove ? box.top - bubble.offsetHeight - 8 : box.bottom + 8)) + "px";
    bubble.dataset.placement = useAbove ? "above" : "below";
  }
  // Conversation owns the speech surface while thinking or showing an answer.
  // Consume suppressed greetings so closing the answer cannot bring them back.
  function syncBotSpeechVisibility() {
    const reaction = document.getElementById("companion-reaction");
    const until = companionSnapshot?.reactionUntil || 0;
    if (botTalkPending || botSpeechVisible) {
      companionReactionDismissedUntil = Math.max(companionReactionDismissedUntil, until);
    }
    reaction.hidden = !botVisualsActive() || !!botTalkPending || botSpeechVisible ||
      until <= Math.max(Date.now(), companionReactionDismissedUntil);
    positionAboveCompanion(reaction);
  }
  function renderBotIdentity() {
    renderBotModels();
    const name = botDisplayName();
    botMenu.querySelector("strong").textContent = t("bot.named.care", name);
    botMenu.setAttribute("aria-label", t("bot.named.care", name));
    document.getElementById("settings-tab-bot").textContent = t("ui.bot");
    document.getElementById("bot-current-character").textContent = t("bot.current.character", name);
    botPromptEditor.setAttribute("aria-label", t("bot.named.prompt", name));
    chatShortcuts.renderShortcuts();
  }
  function renderBotTalk() {
    const label = t("bot.named.talk", botDisplayName());
    botTalkButton.querySelector('[data-i18n="bot.talk"]').textContent = label;
    botTalkButton.setAttribute("aria-label", label);
    botTalkButton.title = label;
    botCharacterSelect.disabled = !!botPromptPending || !!botTalkPending;
    botTalkButton.disabled = !state.botsEnabled || !prompt.value.trim() || !!botTalkPending;
    botSpeech.hidden = !botSpeechVisible || !botVisualsActive();
    syncBotSpeechVisibility();
    positionBotSpeech();
    renderCompanion();
  }
  function clearBotGlance() {
    clearTimeout(botGlanceTimer);
    botGlanceTimer = undefined;
    delete factoryBot.dataset.glance;
  }
  function maybeGlanceAtPointer(event) {
    if (!state.botsEnabled || event.pointerType !== "mouse" || document.hidden || !state.botVisible ||
        !state.botAnimations || botReducedMotion.matches || factoryBot.dataset.state !== "idle") return;
    const now = Date.now();
    if (now < botNextGlanceAt) return;
    // Sample once per interval, including misses, so frequent events cannot force a glance.
    botNextGlanceAt = now + 12000;
    if (Math.random() >= 0.2) return;
    const box = factoryBot.getBoundingClientRect();
    const dx = Math.max(-1, Math.min(1, (event.clientX - box.x - box.width / 2) / 160));
    const dy = Math.max(-1, Math.min(1, (event.clientY - box.y - box.height / 2) / 160));
    factoryBot.style.setProperty("--bot-glance-x", (dx * 2.5) + "px");
    factoryBot.style.setProperty("--bot-glance-y", (dy * 2) + "px");
    factoryBot.style.setProperty("--bot-glance-tilt", (dx * 6) + "deg");
    factoryBot.dataset.glance = "true";
    botGlanceTimer = window.setTimeout(clearBotGlance, 1500);
  }
  function wakeFactoryBot() {
    if (!state.botsEnabled) return;
    if (!companionSnapshot) botIdleSince = Date.now();
    if (["drowsy", "sleeping"].includes(factoryBot.dataset.state)) renderFactoryBot();
  }
  function botVisualsActive() {
    return state.botsEnabled && state.botVisible && !document.hidden;
  }
  function updateBotCare() {
    if (companionSnapshot) return;
    const care = state.botCare;
    const now = Date.now();
    const minutes = Math.max(0, (now - care.updatedAt) / 60000);
    if (minutes < 1) return;
    // Hidden/disabled time is rest, not neglect. Evaluate elapsed time lazily.
    const resting = !botVisualsActive() || ["sleeping", "offline"].includes(factoryBot.dataset.state) || minutes > 5;
    state.botCare = { ...care,
      fullness: Math.max(0, care.fullness - (resting ? 0 : minutes * .5)),
      happiness: Math.max(0, care.happiness - (resting ? 0 : minutes * .25)),
      energy: Math.max(0, Math.min(100, care.energy + minutes * (resting ? 2 : -.5))),
      updatedAt: now };
  }
  function renderBotCare() {
    clearTimeout(botCareTimer); botCareTimer = undefined;
    updateBotCare();
    if (botMenu.hidden || !botVisualsActive()) return;
    for (const key of ["fullness", "happiness", "energy"]) {
      const value = Math.round(state.botCare[key]);
      document.getElementById("bot-" + key).value = value;
      document.getElementById("bot-" + key + "-value").textContent = String(value);
    }
    document.getElementById("bot-care-growth").textContent = t("bot.growth", 1 + Math.floor(state.botCare.careCount / 5), state.botCare.careCount);
    // One minute timer only while the care panel is visible. Reuse gesture ticks otherwise.
    botCareTimer = window.setTimeout(renderBotCare, 60000);
  }
  function factoryBotKey() {
    return [state.botsEnabled, state.botVisible, state.botAnimations, state.pendingDecisionRunId,
      state.runtimeAvailable, state.running, botOutcome, uiLocale()].join(":");
  }
  function updateBotGesture(mode) {
    const mood = factoryBot.dataset.mood || "calm";
    const key = mode + ":" + mood;
    if (key !== botGestureKey || mode !== "idle") {
      clearTimeout(botGestureTimer);
      botGestureTimer = undefined;
      botGestureKey = key;
    }
    if (mode !== "idle" || !botVisualsActive() || !state.botAnimations || botReducedMotion.matches) {
      clearTimeout(botGestureTimer);
      botGestureTimer = undefined;
      delete factoryBot.dataset.gesture;
      return;
    }
    if (botGestureTimer !== undefined) return;
    const pools = {
      calm: ["breathe", "stretch", "coffee", "read", "bow", "look"],
      curious: ["look", "read", "balance", "wave", "stretch", "shy"],
      cheerful: ["dance", "wave", "bow", "balance", "stretch", "shy"],
      focused: ["read", "coffee", "look", "breathe", "stretch", "bow"]
    };
    const care = state.botCare;
    if (care.careCount >= 5) pools.calm = pools.calm.concat(["dance", "balance"]);
    const preferred = care.energy < 30 ? ["breathe", "read"]
      : care.fullness < 30 ? ["look", "breathe"]
      : care.happiness < 35 ? ["shy", "look", "read"] : pools[mood] || pools.calm;
    const choices = preferred.filter(function (gesture) {
      return gesture !== factoryBot.dataset.gesture;
    });
    factoryBot.dataset.gesture = choices[Math.floor(Math.random() * choices.length)];
    botGestureTimer = window.setTimeout(function () {
      botGestureTimer = undefined;
      renderFactoryBot();
    }, 8000);
  }
  function renderFactoryBot() {
    renderBotIdentity();
    if (!state.botsEnabled) { botTalkPending = undefined; botSpeechVisible = false; botSpeechText.textContent = ""; }
    renderBotTalk();
    renderBotCare();
    botRenderKey = factoryBotKey();
    document.getElementById("bots-disabled").checked = !state.botsEnabled;
    factoryBot.hidden = !state.botsEnabled || !state.botVisible;
    const dock = document.getElementById("companion-dock");
    dock.hidden = factoryBot.hidden;
    if (dock.hidden) endBotDrag();
    positionCompanion();
    document.getElementById("bot-visible").disabled = !state.botsEnabled;
    document.getElementById("bot-animations").disabled = !state.botsEnabled;
    if (!state.botsEnabled) {
      clearTimeout(botIdleTimer); botIdleTimer = undefined;
      clearTimeout(botGestureTimer); botGestureTimer = undefined;
      clearTimeout(botWaveTimer); botWaveTimer = undefined;
      clearTimeout(botReactionTimer); botReactionTimer = undefined;
      botIdleSince = undefined;
      botGestureKey = undefined;
      delete factoryBot.dataset.gesture;
      delete factoryBot.dataset.reacting;
      delete factoryBot.dataset.mood;
      delete factoryBot.dataset.brain;
      clearBotGlance();
      closeBotMenu();
      renderCompanion();
      return;
    }
    factoryBot.dataset.animations = String(state.botAnimations);
    let mode = companionWorking > 0 ? "working" : state.pendingDecisionRunId ? "waiting"
      : !state.runtimeAvailable ? "offline"
      : state.running ? "working"
      : botOutcome === "completed" ? "complete"
      : botOutcome === "failed" ? "error" : "idle";
    clearTimeout(botIdleTimer);
    botIdleTimer = undefined;
    if (mode === "idle") {
      if (state.botCare.energy < 15 && botIdleSince === undefined) botIdleSince = Date.now() - 60000;
      if (botIdleSince === undefined) botIdleSince = Date.now();
      const elapsed = Date.now() - botIdleSince;
      if (botTalkPending || botSpeechVisible) mode = "idle";
      else if (elapsed >= 60000) mode = "sleeping";
      else {
        if (elapsed >= 45000) mode = "drowsy";
        if (botVisualsActive()) botIdleTimer = window.setTimeout(renderFactoryBot, (elapsed < 45000 ? 45000 : 60000) - elapsed);
      }
    } else {
      botIdleSince = companionSnapshot ? companionSnapshot.lastInteractionAt : undefined;
    }
    const labels = { drowsy: t("ui.getting.sleepy"), sleeping: t("ui.sleeping"), idle: t("ui.ready"), working: t("ui.working"), waiting: t("ui.waiting.for.your.reply"), complete: t("ui.completed"), error: t("ui.needs.attention"), offline: t("ui.resting.runtime.offline") };
    factoryBot.dataset.state = mode;
    if (botMenu) {
      const available = mode === "idle" || mode === "drowsy" || mode === "sleeping";
      botMenu.querySelectorAll("[data-bot-action], [data-companion-action]").forEach(button => { button.disabled = !available && (!state.companionAvailable || button.hasAttribute("data-bot-action")); });
      document.getElementById("bot-menu-note").hidden = available;
      if (!state.botVisible) closeBotMenu();
    }
    if (mode !== "idle" || !state.botVisible || !state.botAnimations || botReducedMotion.matches) clearBotGlance();
    updateBotGesture(mode);
    factoryBot.title = botDisplayName() + " · " + labels[mode] + (factoryBot.dataset.brain === "luna" ? t("ui.luna.none") : factoryBot.dataset.brain === "unavailable" ? t("ui.local.animation.luna.unavailable") : "");
    factoryBot.setAttribute("aria-label", factoryBot.title);
    renderCompanion();
    if (mode === "complete" && !botWaveTimer) {
      botWaveTimer = window.setTimeout(function () {
        botWaveTimer = undefined;
        if (botOutcome === "completed") botOutcome = undefined;
        renderFactoryBot();
      }, 2400);
    }
  }

  return {
    botTalkButton, botMenu, maybeGlanceAtPointer, clearBotGlance,
    get botRestingSince() { return botRestingSince; },
    set botRestingSince(value) { botRestingSince = value; },
    get companionSnapshot() { return companionSnapshot; },
    set companionSnapshot(value) { companionSnapshot = value; },
    renderFactoryBot, botReducedMotion, wakeFactoryBot, positionBotMenu, positionBotSpeech, positionCompanion, consumeDragClick,
    positionAboveCompanion, talkToBot,
    get botSpeechVisible() { return botSpeechVisible; },
    set botSpeechVisible(value) { botSpeechVisible = value; },
    renderBotTalk, closeBotMenu, botSpeech,
    get botTalkPending() { return botTalkPending; },
    set botTalkPending(value) { botTalkPending = value; },
    interactCompanion, startBotConversation, updateBotCare,
    get botGestureTimer() { return botGestureTimer; },
    set botGestureTimer(value) { botGestureTimer = value; },
    get botIdleSince() { return botIdleSince; },
    set botIdleSince(value) { botIdleSince = value; },
    botPlayActivities,
    get botLastPlayActivity() { return botLastPlayActivity; },
    set botLastPlayActivity(value) { botLastPlayActivity = value; },
    renderBotCare,
    get botReactionTimer() { return botReactionTimer; },
    get botDraftRevision() { return botDraftRevision; },
    set botDraftRevision(value) { botDraftRevision = value; },
    receiveBotCharacter,
    get botDefaultPrompt() { return botDefaultPrompt; },
    set botDefaultPrompt(value) { botDefaultPrompt = value; },
    receiveBotPrompt,
    get botModelSaved() { return botModelSaved; },
    set botModelSaved(value) { botModelSaved = value; },
    renderBotModels,
    get botModelOptions() { return botModelOptions; },
    set botModelOptions(value) { botModelOptions = value; },
    get botOutcome() { return botOutcome; },
    set botOutcome(value) { botOutcome = value; },
    botSpeechText,
    get botReplyEmotion() { return botReplyEmotion; },
    set botReplyEmotion(value) { botReplyEmotion = value; },
    showBotSpeech, botModelSelect, botModelStatus,
    get botPromptPending() { return botPromptPending; },
    set botPromptPending(value) { botPromptPending = value; },
    get botCharacter() { return botCharacter; },
    botPromptDrafts, updateBotPromptControls,
    get botPromptSaved() { return botPromptSaved; },
    set botPromptSaved(value) { botPromptSaved = value; },
    botPromptEditor, botPromptStatus,
    get companionWorking() { return companionWorking; },
    set companionWorking(value) { companionWorking = value; },
    get companionOutcome() { return companionOutcome; },
    set companionOutcome(value) { companionOutcome = value; },
    get companionOutcomeUntil() { return companionOutcomeUntil; },
    set companionOutcomeUntil(value) { companionOutcomeUntil = value; },
    get botWaveTimer() { return botWaveTimer; },
    set botWaveTimer(value) { botWaveTimer = value; },
    get botRenderKey() { return botRenderKey; },
    factoryBotKey
  };
};
