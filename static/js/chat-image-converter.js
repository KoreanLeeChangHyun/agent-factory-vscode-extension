globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.imageConverter = function (host) {
  "use strict";

  const {
    createId, t, vscode, state, renderAttachments, updateSendButton, persist
  } = host;

  let conversionDraft;
  const converter = document.getElementById("image-converter");
  const conversionFormat = document.getElementById("image-converter-format");
  const conversionSubmit = document.getElementById("image-converter-submit");
  const conversionReveal = document.getElementById("image-converter-reveal");
  const conversionStatus = document.getElementById("image-converter-status");
  document.getElementById("image-converter-close").addEventListener("click", () => converter.close());
  converter.addEventListener("cancel", event => { if (conversionDraft?.busy) event.preventDefault(); });
  conversionSubmit.addEventListener("click", function () {
    if (!conversionDraft || conversionDraft.busy) return;
    conversionDraft.requestId = createId();
    conversionDraft.busy = true;
    conversionSubmit.disabled = conversionFormat.disabled = true;
    document.getElementById("image-converter-close").disabled = true;
    conversionReveal.hidden = true;
    conversionStatus.dataset.error = "false";
    conversionStatus.textContent = t("attachment.convert.busy");
    vscode.postMessage({ type: "attachment.convert", id: conversionDraft.attachment.id,
      name: conversionDraft.attachment.name, requestId: conversionDraft.requestId, mediaType: conversionFormat.value });
  });
  conversionReveal.addEventListener("click", function () {
    if (conversionDraft?.saved) vscode.postMessage({ type: "attachment.revealConverted", id: conversionDraft.requestId });
  });
  function openImageConverter(attachment) {
    conversionDraft = { attachment, busy: false };
    document.getElementById("image-converter-name").textContent = attachment.name;
    document.getElementById("image-converter-name").title = attachment.name;
    const preview = document.getElementById("image-converter-preview");
    const icon = document.getElementById("image-converter-icon");
    preview.hidden = !attachment.previewUri;
    icon.hidden = Boolean(attachment.previewUri);
    preview.onerror = function () { preview.hidden = true; icon.hidden = false; };
    if (attachment.previewUri) preview.src = attachment.previewUri;
    else preview.removeAttribute("src");
    const sourceType = attachment.mediaType || ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" })[attachment.name.split(".").pop().toLowerCase()];
    conversionFormat.replaceChildren();
    for (const [label, mediaType] of [["PNG", "image/png"], ["JPG", "image/jpeg"], ["WebP", "image/webp"]]) {
      if (mediaType === sourceType) continue;
      const option = document.createElement("option"); option.value = mediaType; option.textContent = label;
      conversionFormat.append(option);
    }
    conversionStatus.textContent = "";
    conversionStatus.dataset.error = "false";
    conversionReveal.hidden = true;
    conversionSubmit.disabled = conversionFormat.disabled = false;
    document.getElementById("image-converter-close").disabled = false;
    converter.showModal();
    conversionFormat.focus();
  }
  function showConversionResult(message) {
    if (!conversionDraft || conversionDraft.requestId !== message.id) return;
    conversionDraft.busy = false;
    conversionDraft.saved = Boolean(message.path && !message.error);
    if (conversionDraft.saved) {
      // Detach only from the draft; the original file and sent history remain intact.
      state.attachments = state.attachments.filter(attachment => attachment.id !== conversionDraft.attachment.id);
      renderAttachments();
      updateSendButton();
      persist();
    }
    conversionSubmit.disabled = conversionFormat.disabled = false;
    document.getElementById("image-converter-close").disabled = false;
    conversionReveal.hidden = !conversionDraft.saved;
    conversionStatus.dataset.error = String(Boolean(message.error));
    conversionStatus.textContent = message.error || t("attachment.convert.saved", message.path);
  }

  return {
    showConversionResult, openImageConverter
  };
};
