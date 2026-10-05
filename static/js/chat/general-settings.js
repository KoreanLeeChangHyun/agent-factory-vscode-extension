globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.generalSettings = function (host) {
    "use strict";
    const { vscode } = host;
    const controls = [...document.querySelectorAll("[data-general-setting]")];
    const status = document.getElementById("general-settings-status");
    let settings = {};
    let audio;
    function prepareAudio() {
      if (!settings.notifySound) return;
      try {
        audio ||= new AudioContext();
        if (audio.state === "suspended") void audio.resume().catch(() => {});
      } catch { /* Audio is optional; desktop notifications remain available. */ }
    }
    function sound() {
      prepareAudio();
      if (!settings.notifySound || audio?.state !== "running") return;
      const tone = audio.createOscillator(), volume = audio.createGain();
      tone.frequency.value = 660;
      volume.gain.setValueAtTime(0.08, audio.currentTime);
      volume.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.18);
      tone.connect(volume); volume.connect(audio.destination);
      tone.start(); tone.stop(audio.currentTime + 0.2);
      tone.onended = () => { tone.disconnect(); volume.disconnect(); };
    }
    for (const control of controls) {
      control.addEventListener("change", () => {
        const key = control.dataset.generalSetting;
        const value = control.type === "checkbox" ? control.checked : control.value;
        settings = { ...settings, [key]: value };
        if (key === "notifySound") prepareAudio();
        vscode.postMessage({ type: "general.set", key, value });
      });
    }
    document.addEventListener("pointerdown", prepareAudio);
    document.addEventListener("keydown", prepareAudio);
    window.addEventListener("message", event => {
      const message = event.data;
      if (message.type === "notification.sound") { sound(); return; }
      const value = message.type === "host.initialize" ? message.generalSettings
        : message.type === "general.updated" ? message.settings : undefined;
      if (!value) return;
      settings = value;
      for (const control of controls) {
        const field = settings[control.dataset.generalSetting];
        if (control.type === "checkbox") control.checked = field === true;
        else control.value = field;
        control.disabled = false;
      }
      status.textContent = message.error || "";
      status.hidden = !message.error;
    });
    window.addEventListener("pagehide", () => { if (audio) void audio.close().catch(() => {}); });
};
