globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.settingsTabOrder = function (host) {
  "use strict";

  const { tabs, state, persist, t } = host;
  const tablist = tabs[0].parentElement;
  const transferType = "application/x-agent-factory-settings-tab";
  const byId = new Map(tabs.map(tab => [tab.dataset.settingsTab, tab]));
  const savedOrder = Array.isArray(state.settingsTabOrder) ? state.settingsTabOrder : [];
  state.settingsTabOrder = [...new Set([...savedOrder, ...byId.keys()])].filter(id => byId.has(id));
  for (const id of state.settingsTabOrder) tablist.append(byId.get(id));
  let dragged;

  function visibleTabs() {
    return [...tablist.children].filter(tab => byId.get(tab.dataset.settingsTab) === tab && !tab.hidden && tab.getClientRects().length);
  }
  function clearTargets() {
    for (const tab of tabs) tab.classList.remove("settings-tab-drop-before", "settings-tab-drop-after");
  }
  function finishDrag() {
    dragged?.classList.remove("settings-tab-dragging");
    dragged = undefined;
    clearTargets();
  }
  function move(source, target, after) {
    if (source === target || !visibleTabs().includes(target)) return;
    const focused = document.activeElement;
    tablist.insertBefore(source, after ? target.nextSibling : target);
    const order = [...tablist.children].map(tab => tab.dataset.settingsTab).filter(id => byId.has(id));
    if (order.some((id, index) => state.settingsTabOrder[index] !== id)) {
      state.settingsTabOrder = order;
      persist();
    }
    if (focused === source) source.focus({ preventScroll: true });
  }
  function isAfter(event, tab) {
    const rect = tab.getBoundingClientRect();
    return event.clientX > rect.left + rect.width / 2;
  }

  for (const tab of tabs) {
    tab.draggable = true;
    tab.dataset.i18nTitle = "ui.settings.tabs.reorder";
    tab.title = t("ui.settings.tabs.reorder");
    tab.setAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight");
    tab.addEventListener("keydown", function (event) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const visible = visibleTabs();
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const target = visible[visible.indexOf(tab) + offset];
      if (target) move(tab, target, offset > 0);
    });
    tab.addEventListener("dragstart", function (event) {
      if (!event.dataTransfer || !visibleTabs().includes(tab)) { event.preventDefault(); return; }
      finishDrag();
      dragged = tab;
      event.stopPropagation();
      event.dataTransfer.setData(transferType, tab.dataset.settingsTab);
      event.dataTransfer.effectAllowed = "move";
      tab.classList.add("settings-tab-dragging");
    });
    tab.addEventListener("dragover", function (event) {
      if (!dragged || dragged === tab) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      clearTargets();
      tab.classList.add(isAfter(event, tab) ? "settings-tab-drop-after" : "settings-tab-drop-before");
    });
    tab.addEventListener("dragleave", function (event) {
      if (!tab.contains(event.relatedTarget)) clearTargets();
    });
    tab.addEventListener("drop", function (event) {
      if (!dragged || event.dataTransfer?.getData(transferType) !== dragged.dataset.settingsTab) return;
      event.preventDefault();
      event.stopPropagation();
      move(dragged, tab, isAfter(event, tab));
      finishDrag();
    });
    tab.addEventListener("dragend", finishDrag);
  }
  return { visibleTabs };
};
