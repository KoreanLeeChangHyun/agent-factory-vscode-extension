(() => {
  const root = document.documentElement;
  const toggle = document.getElementById("motion-toggle");
  const replay = document.getElementById("motion-replay");

  toggle.addEventListener("click", () => {
    const paused = root.classList.toggle("is-paused");
    toggle.setAttribute("aria-pressed", String(paused));
    toggle.textContent = paused ? "Resume" : "Pause";
  });

  replay.addEventListener("click", () => {
    root.classList.remove("is-replaying");
    void root.offsetWidth;
    root.classList.add("is-replaying");
    root.classList.remove("is-paused");
    toggle.setAttribute("aria-pressed", "false");
    toggle.textContent = "Pause";
  });
})();
