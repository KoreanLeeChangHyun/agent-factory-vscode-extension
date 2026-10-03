globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.sudo = function (host) {
  "use strict";

  const {
    t, inputFeedback, vscode
  } = host;

  const sudoPanel = document.createElement("form");
  sudoPanel.className = "sudo-panel";
  sudoPanel.hidden = true;
  sudoPanel.setAttribute("aria-label", t("sudo.title"));
  const sudoTitle = document.createElement("strong");
  const sudoCommand = document.createElement("code");
  const sudoContext = document.createElement("span");
  sudoContext.className = "sudo-context";
  const sudoPassword = document.createElement("input");
  sudoPassword.type = "password";
  sudoPassword.autocomplete = "off";
  sudoPassword.setAttribute("aria-label", t("sudo.password"));
  const sudoSubmit = document.createElement("button");
  sudoSubmit.type = "submit";
  const sudoCancel = document.createElement("button");
  sudoCancel.type = "button";
  const sudoStatus = document.createElement("span");
  sudoStatus.setAttribute("role", "status");
  sudoPanel.append(sudoTitle, sudoCommand, sudoContext, sudoPassword, sudoSubmit, sudoCancel, sudoStatus);
  inputFeedback.after(sudoPanel);
  let sudoChallenge = null;
  sudoCancel.onclick = function () {
    if (sudoChallenge) vscode.postMessage({ type: "sudo.reply", id: sudoChallenge.id, cancelled: true });
    closeSudoPanel();
  };
  sudoPanel.onsubmit = async function (event) {
    event.preventDefault();
    const challenge = sudoChallenge;
    if (!challenge || !sudoPassword.value) return;
    const secret = sudoPassword.value;
    sudoPassword.value = "";
    sudoSubmit.disabled = true;
    sudoCancel.disabled = true;
    sudoStatus.textContent = t("sudo.encrypting");
    try {
      const pem = challenge.publicKey.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
      const keyBytes = Uint8Array.from(atob(pem), ch => ch.charCodeAt(0));
      const publicKey = await crypto.subtle.importKey("spki", keyBytes, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
      const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
      const rawKey = await crypto.subtle.exportKey("raw", aes);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(secret));
      const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawKey);
      new Uint8Array(rawKey).fill(0);
      const b64 = bytes => {
        const value = new Uint8Array(bytes);
        let binary = "";
        for (let index = 0; index < value.length; index += 8192) binary += String.fromCharCode(...value.subarray(index, index + 8192));
        return btoa(binary);
      };
      vscode.postMessage({ type: "sudo.reply", id: challenge.id, key: b64(wrappedKey), iv: b64(iv), data: b64(encrypted) });
      sudoStatus.textContent = t("sudo.running");
    } catch {
      sudoStatus.textContent = t("sudo.encryption.failed");
      sudoSubmit.disabled = false;
      sudoCancel.disabled = false;
    }
  };
  function openSudoPanel(message) {
    sudoChallenge = message;
    sudoPanel.setAttribute("aria-label", t("sudo.title"));
    sudoPassword.setAttribute("aria-label", t("sudo.password"));
    sudoTitle.textContent = t("sudo.title");
    sudoCommand.textContent = message.command.map(arg => JSON.stringify(arg)).join(" ");
    sudoContext.textContent = t("sudo.context", message.cwd || "", message.agentId || "", message.runId || "");
    sudoSubmit.textContent = t("sudo.run");
    sudoCancel.textContent = t("sudo.cancel");
    sudoSubmit.disabled = false;
    sudoPanel.hidden = false;
    sudoPanel.scrollIntoView({ block: "nearest" });
  }
  function closeSudoPanel() {
    sudoChallenge = null;
    sudoPassword.value = "";
    sudoStatus.textContent = "";
    sudoPanel.hidden = true;
    sudoCancel.disabled = false;
  }

  return {
    openSudoPanel, closeSudoPanel
  };
};
