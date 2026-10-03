globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.attachments = function (host) {
  "use strict";

  const {
    vscode, attachmentList, state, t, updateSendButton, persist, appendNotice, createId
  } = host;

  function bindAttachmentConversion(element, attachment) {
    if (attachment.kind !== "image" || attachment.pending || !attachment.uri) return;
    element.tabIndex = 0;
    const open = function (event) {
      event.preventDefault();
      event.stopPropagation();
      host.chatImageConverter.openImageConverter(attachment);
    };
    element.addEventListener("contextmenu", open);
    element.addEventListener("keydown", function (event) {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) open(event);
    });
  }

  async function encodeAttachmentImage(message) {
    let canvas;
    try {
      const image = new Image();
      image.src = message.source;
      await image.decode();
      canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context || !canvas.width || !canvas.height) throw new Error("Invalid image");
      if (message.mediaType === "image/jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(image, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, message.mediaType, 0.92));
      if (!blob || blob.type !== message.mediaType) throw new Error("Unsupported encoder");
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      vscode.postMessage({ type: "attachment.converted", id: message.id, name: message.name,
        mediaType: blob.type, size: blob.size, data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
    } catch {
      vscode.postMessage({ type: "attachment.conversionFailed", id: message.id });
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  }

  function renderAttachments() {
    attachmentList.replaceChildren();
    for (const attachment of state.attachments) {
      const chip = document.createElement("div");
      chip.className = "attachment-chip" + (attachment.kind === "image" ? " attachment-image" : "");
      chip.title = attachment.uri || attachment.name;
      bindAttachmentConversion(chip, attachment);
      const name = document.createElement("span");
      name.className = "attachment-chip-name";
      name.textContent = attachment.name;
      if (attachment.kind === "image" && attachment.previewUri) {
        chip.classList.add("is-loading");
        const preview = document.createElement("img");
        preview.className = "attachment-preview";
        preview.src = attachment.previewUri;
        preview.alt = attachment.name;
        if (attachment.uri && !attachment.pending) {
          preview.tabIndex = 0;
          preview.setAttribute("role", "button");
          preview.setAttribute("aria-label", t("attachment.open", attachment.name));
          preview.addEventListener("click", function () { vscode.postMessage({ type: "attachment.open", id: attachment.id }); });
          preview.addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); vscode.postMessage({ type: "attachment.open", id: attachment.id }); }
          });
        }
        preview.addEventListener("load", function () {
          chip.classList.remove("is-loading");
        });
        preview.addEventListener("error", function () {
          chip.classList.remove("is-loading");
          chip.classList.add("preview-failed");
        });
        chip.append(preview);
      }
      const remove = document.createElement("button");
      remove.className = "attachment-remove";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", t("attachment.remove", attachment.name));
      remove.addEventListener("click", function () {
        if (attachment.previewUri?.startsWith("blob:")) {
          URL.revokeObjectURL(attachment.previewUri);
        }
        state.attachments = state.attachments.filter(function (item) {
          return item.id !== attachment.id;
        });
        if (attachment.uri) vscode.postMessage({ type: "attachment.remove", id: attachment.id });
        renderAttachments();
        updateSendButton();
        persist();
      });
      chip.append(name, remove);
      attachmentList.append(chip);
    }
  }

  function renderHistoryAttachments(container, attachments) {
    const gallery = document.createElement("div");
    gallery.className = "history-attachments";
    for (const attachment of attachments) {
      if (attachment.kind !== "image") {
        const reference = document.createElement("div");
        reference.className = "attachment-chip history-reference";
        reference.title = attachment.uri || attachment.name;
        const name = document.createElement("span");
        name.className = "attachment-chip-name";
        name.textContent = attachment.name;
        reference.append(name);
        gallery.append(reference);
        continue;
      }
      const item = document.createElement(attachment.previewUri ? "button" : "div");
      item.className = "history-attachment";
      item.title = attachment.name;
      bindAttachmentConversion(item, attachment);
      if (attachment.previewUri) {
        item.type = "button";
        item.setAttribute("aria-label", t("attachment.open", attachment.name));
        item.addEventListener("click", function () { vscode.postMessage({ type: "attachment.open", id: attachment.id }); });
        const preview = document.createElement("img");
        preview.src = attachment.previewUri;
        preview.alt = attachment.name;
        item.append(preview);
      }
      const name = document.createElement("span");
      name.textContent = attachment.name;
      item.append(name);
      gallery.append(item);
    }
    if (gallery.childElementCount) container.append(gallery);
  }
  function addAttachments(attachments) {
    const existing = new Set(state.attachments.map(function (item) {
      return item.uri || item.name + ":" + item.size;
    }));
    for (const attachment of attachments) {
      const key = attachment.uri || attachment.name + ":" + attachment.size;
      const sameId = state.attachments.findIndex(function (item) { return item.id === attachment.id; });
      if (sameId >= 0) {
        const previous = state.attachments[sameId];
        if (previous.previewUri?.startsWith("blob:") && previous.previewUri !== attachment.previewUri) URL.revokeObjectURL(previous.previewUri);
        state.attachments[sameId] = attachment;
        existing.add(key);
      } else if (!existing.has(key) && state.attachments.length < 100) {
        state.attachments.push(attachment);
        existing.add(key);
      } else if (attachment.previewUri?.startsWith("blob:")) {
        URL.revokeObjectURL(attachment.previewUri);
      }
    }
    renderAttachments();
    updateSendButton();
    persist();
  }
  async function addDroppedData(dataTransfer) {
    if (!dataTransfer) {
      return;
    }
    const files = Array.from(dataTransfer.files || []);
    const uris = dataTransfer.getData("text/uri-list").split(/\r?\n/).filter(function (uri) {
      return uri && !uri.startsWith("#");
    });
    // URI drops (including VS Code Explorer and Finder) must be opened by the Extension Host.
    // A Webview-only reference cannot stage image bytes or provide a usable local runtime path.
    if (uris.length) {
      vscode.postMessage({ type: "attachments.addUris", uris });
      return;
    }
    await addBrowserFiles(files);
  }
  function hasAttachmentData(dataTransfer) {
    if (!dataTransfer) {
      return false;
    }
    const types = Array.from(dataTransfer.types || []);
    return types.includes("Files") || types.includes("text/uri-list");
  }
  async function addBrowserFiles(files) {
    for (const file of files) {
      if (!file.name || file.name.length > 255 || /[\\/\x00-\x1f]/.test(file.name) || [".", ".."].includes(file.name)) {
        appendNotice("error", t("ui.local.file.read.failed"));
        continue;
      }
      if (browserImageMediaType(file)) {
        await addBrowserImages([file]);
        continue;
      }
      const id = createId();
      addAttachments([{ id, name: file.name, kind: "file", size: file.size, pending: true }]);
      try {
        const data = await readDataUrl(file);
        vscode.postMessage({ type: "attachments.createFile", id, name: file.name, size: file.size, data: data.slice(data.indexOf(",") + 1) });
      } catch {
        state.attachments = state.attachments.filter(item => item.id !== id);
        appendNotice("error", t("ui.local.file.read.failed"));
        renderAttachments();
        persist();
      }
    }
  }
  function browserImageMediaType(file) {
    const accepted = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    if (accepted.includes(file.type)) return file.type;
    if (file.type) return undefined;
    return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" })
      [String(file.name || "").split(".").pop().toLowerCase()];
  }
  async function addBrowserImages(files) {
    for (const file of files) {
      const mediaType = browserImageMediaType(file);
      const imageCount = state.attachments.filter(function (item) { return item.kind === "image"; }).length;
      const imageBytes = state.attachments.filter(function (item) { return item.kind === "image"; })
        .reduce(function (total, item) { return total + (item.size || 0); }, 0);
      if (!mediaType || file.size < 1) {
        appendNotice("error", t("ui.attach.up.to.8.png.jpeg.gif.or.webp.images.with.a.maximum.of.10.mib.each.and.20.mib.total"));
        continue;
      }
      const id = createId();
      addAttachments([{ id, name: file.name || "image", kind: "image", previewUri: URL.createObjectURL(file), mediaType, size: file.size, pending: true }]);
      try {
        const dataUrl = await readDataUrl(file);
        vscode.postMessage({ type: "attachments.createImage", id, name: file.name || "image", mediaType, size: file.size, data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
      } catch (error) {
        state.attachments = state.attachments.filter(function (item) { return item.id !== id; });
        appendNotice("error", t("ui.unable.to.read.the.image"));
        renderAttachments();
        persist();
      }
    }
  }
  function readDataUrl(file) {
    return new Promise(function (resolvePromise, rejectPromise) {
      const reader = new FileReader();
      reader.addEventListener("load", function () { typeof reader.result === "string" ? resolvePromise(reader.result) : rejectPromise(new Error(t("ui.invalid.image"))); });
      reader.addEventListener("error", function () { rejectPromise(reader.error || new Error(t("ui.image.read.failed"))); });
      reader.readAsDataURL(file);
    });
  }

  return {
    addBrowserFiles, browserImageMediaType, addBrowserImages, hasAttachmentData, addDroppedData,
    encodeAttachmentImage, addAttachments, renderAttachments, renderHistoryAttachments
  };
};
