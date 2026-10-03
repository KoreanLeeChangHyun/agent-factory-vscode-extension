globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.notes = function (host) {
  "use strict";

  const {
    saved, persist, vscode, prompt, t
  } = host;

  const notesPanel = document.getElementById("notes-panel");
  const notesToggle = document.getElementById("notes-toggle");
  const notesScopeTabs = Array.from(document.querySelectorAll("[data-notes-scope]"));
  let selectedNotesScope = saved?.notesScope === "global" ? "global" : "workspace";
  try { const cached = localStorage.getItem("agentFactory.notes.scope"); if (cached === "global" || cached === "workspace") selectedNotesScope = cached; } catch { /* Persisted Webview state is the fallback. */ }
  let selectedNoteFolder = "", noteRecords = [], noteFolders = [], noteMoving = null;

  const notesTitle = document.getElementById("notes-title");
  const notesBody = document.getElementById("notes-body");
  const notesStatus = document.getElementById("notes-status");
  const notesResize = document.getElementById("notes-resize");
  let notesResizeStart;
  function resizeNotes(width) {
    const available = notesPanel.parentElement.clientWidth;
    notesPanel.style.width = Math.max(Math.min(200, available - 42), Math.min(width, available - 42)) + "px";
  }
  notesResize.addEventListener("pointerdown", function (event) {
    notesResizeStart = { x: event.clientX, width: notesPanel.getBoundingClientRect().width };
    notesResize.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  notesResize.addEventListener("pointermove", function (event) {
    if (notesResizeStart) resizeNotes(notesResizeStart.width + notesResizeStart.x - event.clientX);
  });
  notesResize.addEventListener("lostpointercapture", function () { notesResizeStart = null; });
  notesResize.addEventListener("keydown", function (event) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    resizeNotes(notesPanel.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 16 : -16));
    event.preventDefault();
  });
  let noteDraft = saved?.noteDraft || null;
  let noteSending = null;
  let noteDirty = Boolean(noteDraft);
  let noteSaveTimer;
  let noteFailed = false;
  if (noteDraft) selectedNotesScope = noteDraft.scope;
  renderNotesScope();
  notesToggle.addEventListener("click", () => setNotesOpen(notesPanel.hidden));
  document.getElementById("notes-close").addEventListener("click", () => setNotesOpen(false));
  notesPanel.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); setNotesOpen(false); }
  });
  function renderNotesScope() {
    for (const tab of notesScopeTabs) {
      const selected = tab.dataset.notesScope === selectedNotesScope;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    document.getElementById("notes-content").setAttribute("aria-labelledby", "notes-tab-" + selectedNotesScope);
  }
  function selectNotesScope(tab) {
    if (noteSending || noteMoving || noteDirty || tab.disabled || tab.dataset.notesScope === selectedNotesScope) return;
    selectedNotesScope = tab.dataset.notesScope;
    selectedNoteFolder = "";
    try { localStorage.setItem("agentFactory.notes.scope", selectedNotesScope); } catch { /* Webview state is also saved. */ }
    persist();
    renderNotesScope();
    loadNotes();
  }
  for (const [index, tab] of notesScopeTabs.entries()) {
    tab.addEventListener("click", () => selectNotesScope(tab));
    tab.addEventListener("keydown", function (event) {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? notesScopeTabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + notesScopeTabs.length) % notesScopeTabs.length;
      if (notesScopeTabs[next].disabled) return;
      selectNotesScope(notesScopeTabs[next]);
      notesScopeTabs[next].focus();
    });
  }
  document.getElementById("notes-new").addEventListener("click", function () {
    if (noteMoving) return;
    if (noteSending || noteDirty) return;
    noteDraft = { folder: selectedNoteFolder, scope: selectedNotesScope, id: crypto.randomUUID(), title: "", body: "", revision: 0 };
    noteDirty = true;
    noteFailed = false;
    renderNoteEditor();
    saveNote();
    notesTitle.focus();
  });
  document.getElementById("notes-back").addEventListener("click", function () {
    noteDraft = null;
    persist();
    loadNotes();
  });
  for (const field of [notesTitle, notesBody]) field.addEventListener("input", function () {
    if (!noteDraft) return;
    noteDraft.title = notesTitle.value;
    noteDraft.body = notesBody.value;
    noteDirty = true;
    persist();
    refreshNoteControls();
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(saveNote, 200);
  });
  document.getElementById("notes-copy").addEventListener("click", function () {
    vscode.postMessage({ type: "message.copy", text: notesBody.value });
  });
  document.getElementById("notes-insert").addEventListener("click", function () {
    prompt.value += (prompt.value && notesBody.value ? "\n\n" : "") + notesBody.value;
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    setNotesOpen(false);
    prompt.focus();
  });
  document.getElementById("notes-save-copy").addEventListener("click", function () {
    if (!noteDraft) return;
    noteDraft.id = crypto.randomUUID();
    noteDraft.revision = 0;
    noteDirty = true;
    noteFailed = false;
    saveNote();
  });
  function setNotesOpen(open) {
    notesPanel.hidden = !open;
    notesToggle.hidden = open;
    notesToggle.setAttribute("aria-expanded", String(open));
    if (open) {
      if (noteDraft) { renderNoteEditor(); if (noteDirty && !noteFailed) saveNote(); }
      else loadNotes();
    } else { saveNote(); notesToggle.focus(); }
  }
  function refreshNoteControls() {
    const pending = Boolean(noteSending || noteDirty);
    document.getElementById("notes-new").disabled = pending;
    for (const tab of notesScopeTabs) tab.disabled = pending;
    document.getElementById("notes-back").disabled = pending;
    document.getElementById("notes-save-copy").hidden = !noteFailed;
    if (!noteFailed) notesStatus.textContent = t(pending ? "notes.saving" : "notes.saved");
  }
  function renderNoteEditor() {
    document.getElementById("notes-list-view").hidden = false;
    document.getElementById("notes-editor").hidden = !noteDraft;
    if (noteDraft) {
      document.getElementById("notes-list-view").hidden = true;
      selectedNotesScope = noteDraft.scope;
      renderNotesScope();
      notesTitle.value = noteDraft.title;
      notesBody.value = noteDraft.body;
    }
    refreshNoteControls();
  }
  function loadNotes() {
    noteDraft = null;
    noteDirty = false;
    noteFailed = false;
    renderNoteEditor();
    persist();
    document.getElementById("notes-list").replaceChildren();
    notesStatus.textContent = t("notes.loading");
    vscode.postMessage({ type: "notes.list", scope: selectedNotesScope });
  }
  function saveNote() {
    clearTimeout(noteSaveTimer);
    if (!noteDraft || !noteDirty || noteSending || noteFailed) return;
    noteSending = { ...noteDraft };
    noteDirty = false;
    const { scope, ...note } = noteSending;
    vscode.postMessage({ type: "notes.save", scope, note });
    refreshNoteControls();
  }
  document.getElementById("notes-folder-form").addEventListener("submit", event => {
    event.preventDefault();
    const input = document.getElementById("notes-folder-name");
    if (!input.value.trim() || noteMoving) return;
    vscode.postMessage({type: "notes.folder", scope: selectedNotesScope, folder: [selectedNoteFolder, input.value.trim()].filter(Boolean).join("/")});
    input.value = "";
  });
  function moveNote(id, folder) {
    const note = noteRecords.find(n => n.id === id);
    if (!note || noteMoving || noteDraft || (note.folder || "") === folder) return;
    noteMoving = {id, scope: selectedNotesScope};
    notesStatus.textContent = t("notes.saving");
    vscode.postMessage({type: "notes.save", scope: selectedNotesScope, note: {...note, folder}});
  }
  function folderDropTarget(element, folder) {
    element.addEventListener("dragover", event => {
      if (!event.dataTransfer.types.includes("application/x-agent-factory-note")) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; element.classList.add("notes-drop-target");
    });
    element.addEventListener("dragleave", () => element.classList.remove("notes-drop-target"));
    element.addEventListener("drop", event => {
      event.preventDefault(); event.stopPropagation(); element.classList.remove("notes-drop-target");
      moveNote(event.dataTransfer.getData("application/x-agent-factory-note"), folder);
    });
  }
  const expandedNoteFolders = { global: new Set(), workspace: new Set() };
  function renderNoteFolders() {
    const list = document.getElementById("notes-list"), crumbs = document.getElementById("notes-breadcrumb");
    list.replaceChildren(); crumbs.replaceChildren();
    const root = document.createElement("button"); root.type = "button"; root.textContent = t("notes.folder.root");
    root.addEventListener("click", () => {selectedNoteFolder = ""; renderNoteFolders();}); folderDropTarget(root, ""); crumbs.append(root);
    const containers = new Map([["", list]]);
    const folders = new Set(noteFolders);
    for (const path of [...noteFolders, ...noteRecords.map(note => note.folder || "")]) {
      const parts = path.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
    }
    function selectFolder(folder) {
      selectedNoteFolder = folder;
      root.setAttribute("aria-current", String(!folder));
      for (const summary of list.querySelectorAll("summary[data-folder]")) {
        summary.setAttribute("aria-current", String(summary.dataset.folder === folder));
      }
    }
    for (const folder of [...folders].sort()) {
      const branch = document.createElement("details"); branch.className = "notes-branch";
      branch.open = expandedNoteFolders[selectedNotesScope].has(folder);
      const summary = document.createElement("summary"); summary.className = "notes-folder";
      summary.textContent = folder.split("/").at(-1); summary.dataset.folder = folder;
      summary.addEventListener("click", () => selectFolder(folder));
      const scope = selectedNotesScope;
      branch.addEventListener("toggle", () => {
        if (!branch.isConnected) return;
        if (branch.open) expandedNoteFolders[scope].add(folder);
        else expandedNoteFolders[scope].delete(folder);
      });
      folderDropTarget(summary, folder);
      const children = document.createElement("div"); children.className = "notes-children";
      branch.append(summary, children);
      containers.get(folder.split("/").slice(0, -1).join("/")).append(branch);
      containers.set(folder, children);
    }
    selectFolder(selectedNoteFolder);
    for (const note of noteRecords) {
      const row = document.createElement("div"); row.className = "notes-entry";
      const button = document.createElement("button"); button.type = "button"; button.textContent = note.title || t("notes.untitled"); button.draggable = true; button.dataset.noteId = note.id;
      button.addEventListener("dragstart", event => {event.dataTransfer.setData("application/x-agent-factory-note", note.id); event.dataTransfer.effectAllowed = "move";});
      button.addEventListener("click", () => {if(noteMoving) return; noteDraft = {...note, scope:selectedNotesScope}; noteDirty = false; renderNoteEditor(); notesBody.focus();});
      row.append(button);
      containers.get(note.folder || "").append(row);
    }
    if (!list.childElementCount) list.textContent = t("notes.empty");
  }
  function receiveNotes(message) {
    if (message.type === "notes.list.result") {
      if (message.scope !== selectedNotesScope || noteDraft) return;
      const list = document.getElementById("notes-list");
      list.replaceChildren();
      notesStatus.textContent = message.error ? t("notes.failed", message.error) : "";
      if (message.error) return;
      noteRecords = message.notes; noteFolders = message.folders || [];
      renderNoteFolders();
      return;
    }
    if (noteMoving && message.scope === noteMoving.scope && message.id === noteMoving.id) {
      noteMoving = null;
      if (message.error) { notesStatus.textContent = t("notes.failed", message.error); renderNoteFolders(); }
      else loadNotes();
      return;
    }
    if (!noteSending || message.scope !== noteSending.scope || message.id !== noteSending.id) return;
    noteSending = null;
    if (message.error) {
      noteDirty = true;
      noteFailed = true;
      notesStatus.textContent = t("notes.failed", message.error);
    } else {
      noteDraft.revision = message.note.revision;
      if (noteDirty) saveNote();
    }
    persist();
    refreshNoteControls();
  }

  return {
    notesPanel, setNotesOpen, receiveNotes,
    get selectedNotesScope() { return selectedNotesScope; },
    get noteDraft() { return noteDraft; },
    get noteDirty() { return noteDirty; },
    get noteSending() { return noteSending; }
  };
};
