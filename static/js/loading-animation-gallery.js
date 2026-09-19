(() => {
  const root = document.documentElement;
  const language = globalThis.AgentFactoryI18n.locale("auto", root.dataset.hostLanguage);
  const t = key => globalThis.AgentFactoryI18n.format(key, language);
  root.lang = language;
  globalThis.AgentFactoryI18n.apply(document, language);
  document.title = t("ui.loading.animation.samples");
  const toggle = document.getElementById("motion-toggle");
  const replay = document.getElementById("motion-replay");

  toggle.addEventListener("click", () => {
    const paused = root.classList.toggle("is-paused");
    toggle.setAttribute("aria-pressed", String(paused));
    toggle.textContent = paused ? t("ui.resume") : t("ui.pause");
  });

  replay.addEventListener("click", () => {
    root.classList.remove("is-replaying");
    void root.offsetWidth;
    root.classList.add("is-replaying");
    root.classList.remove("is-paused");
    toggle.setAttribute("aria-pressed", "false");
    toggle.textContent = t("ui.pause");
  });
})();
