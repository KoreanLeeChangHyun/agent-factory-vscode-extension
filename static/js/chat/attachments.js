globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.attachments = function (host) {
  "use strict";

  const {
    vscode, attachmentList, state, t, updateSendButton, persist, appendNotice, createId
  } = host;
  // Keep cancellation through the Host acknowledgement, including remote/WSL latency.
  const imageUploads = new Map();
  function finishImageUpload(id) { imageUploads.delete(id); }

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
        reader.onabort = reject;
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
        const upload = imageUploads.get(attachment.id);
        if (upload) upload.cancelled = true;
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
      return item.uri || item.id;
    }));
    for (const attachment of attachments) {
      const upload = imageUploads.get(attachment.id);
      if (!attachment.pending && upload) {
        imageUploads.delete(attachment.id);
        if (upload.cancelled || !state.attachments.some(item => item.id === attachment.id)) {
          vscode.postMessage({ type: "attachment.remove", id: attachment.id });
          continue;
        }
      }
      const key = attachment.uri || attachment.id;
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
    const uris = droppedResourceUris(dataTransfer);
    // URI drops (including VS Code Explorer and Finder) must be opened by the Extension Host.
    // A Webview-only reference cannot stage image bytes or provide a usable local runtime path.
    if (uris.length) {
      vscode.postMessage({ type: "attachments.addUris", uris });
      return;
    }
    await addBrowserFiles(files);
  }
  function droppedResourceUris(dataTransfer) {
    // Chromium normalizes MIME names to lowercase. During dragover only types
    // are readable; read the payload synchronously at drop time.
    const types = Array.from(dataTransfer.types || []);
    const read = function (type) {
      const actual = types.find(value => value.toLowerCase() === type);
      return dataTransfer.getData(actual || type);
    };
    const uriList = function (value) {
      return value.split(/\r?\n/).map(uri => uri.trim()).filter(uri => uri && !uri.startsWith("#"));
    };
    // VS Code exposes only the first resource through text/uri-list. Its internal
    // list preserves all files AND directories, including vscode-remote URIs.
    const internal = uriList(read("application/vnd.code.uri-list"));
    if (internal.length) return [...new Set(internal)];
    const uris = uriList(read("text/uri-list"));
    try {
      const resources = JSON.parse(read("resourceurls") || "[]");
      if (Array.isArray(resources)) uris.push(...resources.filter(uri => typeof uri === "string" && uri));
    } catch {
      // A malformed optional transfer must not suppress a standard URI/file drop.
    }
    return [...new Set(uris)];
  }
  function hasAttachmentData(dataTransfer) {
    if (!dataTransfer) {
      return false;
    }
    const types = Array.from(dataTransfer.types || [], type => type.toLowerCase());
    return ["files", "text/uri-list", "application/vnd.code.uri-list", "resourceurls"]
      .some(type => types.includes(type));
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
        updateSendButton();
        persist();
      }
    }
  }
  function browserImageMediaType(file) {
    const accepted = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    if (accepted.includes(file.type)) return file.type;
    if (file.type) return undefined;
    return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" })[
      String(file.name || "").split(".").pop().toLowerCase()];
  }

  function clipboardImages(transfer) {
    const entries = [];
    const seen = new Map();
    const key = file => JSON.stringify([file.name, file.size, file.type]);
    for (const item of Array.from(transfer.items || [])) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      entries.push({ file, hint: item.type });
      seen.set(key(file), (seen.get(key(file)) || 0) + 1);
    }
    for (const file of Array.from(transfer.files || [])) {
      const count = seen.get(key(file)) || 0;
      if (count) seen.set(key(file), count - 1);
      else entries.push({ file });
    }
    return entries.filter(({ file, hint }) => {
      const type = (hint || file.type || "").toLowerCase();
      return type.startsWith("image/") || browserImageMediaType(file) ||
        ((!type || type === "application/octet-stream") &&
          (!String(file.name || "").includes(".") || /\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i.test(file.name)));
    }).map(({ file }) => file);
  }

  async function prepareBrowserImage(file) {
    // Clipboard MIME/filename metadata differs between screenshot tools. Inspect
    // the actual bytes; the Host independently validates them again before saving.
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const starts = signature => signature.every((byte, index) => bytes[index] === byte);
    let mediaType = starts([137, 80, 78, 71, 13, 10, 26, 10]) ? "image/png"
      : starts([255, 216, 255]) ? "image/jpeg"
      : starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]) ? "image/gif"
      : starts([82, 73, 70, 70]) && [87, 69, 66, 80].every((byte, index) => bytes[index + 8] === byte) ? "image/webp" : undefined;
    let blob = file;
    if (!mediaType) {
      // BMP screenshots (and other browser-decodable raster formats) become PNG.
      // Never fetch HTML clipboard URLs or local UI-machine paths on a remote Host.
      const type = String(file.type || "").toLowerCase();
      if (!starts([66, 77]) && !["image/bmp", "image/x-ms-bmp", "image/tiff", "image/avif"].includes(type)) {
        throw new Error(t("ui.clipboard.image.format.unsupported"));
      }
      const source = URL.createObjectURL(file);
      const canvas = document.createElement("canvas");
      try {
        const image = new Image(); image.src = source; await image.decode();
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context || !canvas.width || !canvas.height) throw new Error("Invalid image");
        context.drawImage(image, 0, 0);
        blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        if (!blob || blob.type !== "image/png") throw new Error("Unsupported encoder");
        mediaType = "image/png";
      } finally {
        URL.revokeObjectURL(source); canvas.width = 0; canvas.height = 0;
      }
    }
    const suffix = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[mediaType];
    const originalName = file.name || "image";
    const name = browserImageMediaType({ type: "", name: originalName }) === mediaType ? originalName
      : originalName.replace(/\.[^.]+$/, "") + "." + suffix;
    return { blob, mediaType, name };
  }
  async function addBrowserImages(files) {
    // Stage the entire batch before starting asynchronous reads so Send cannot
    // race ahead of the second clipboard image.
    const uploads = files.map(file => {
      const id = createId();
      const upload = { id, file, cancelled: false, sent: false };
      imageUploads.set(id, upload);
      addAttachments([{ id, name: file.name || "image", kind: "image", previewUri: URL.createObjectURL(file), size: file.size, pending: true }]);
      if (!state.attachments.some(item => item.id === id)) {
        upload.cancelled = true;
        appendNotice("error", t("ui.image.attachment.limit.exceeded"));
      }
      return upload;
    });
    for (const upload of uploads) {
      const { id, file } = upload;
      const cancelled = () => upload.cancelled || !state.attachments.some(item => item.id === id);
      try {
        if (cancelled()) continue;
        const { blob, mediaType, name } = await prepareBrowserImage(file);
        if (cancelled()) continue;
        const dataUrl = await readDataUrl(blob);
        if (cancelled()) continue;
        upload.sent = true;
        vscode.postMessage({ type: "attachments.createImage", id, name, mediaType, size: blob.size, data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
      } catch {
        const attachment = state.attachments.find(item => item.id === id);
        if (attachment?.previewUri?.startsWith("blob:")) URL.revokeObjectURL(attachment.previewUri);
        state.attachments = state.attachments.filter(function (item) { return item.id !== id; });
        if (!upload.cancelled) appendNotice("error", t("ui.clipboard.image.format.unsupported"));
        renderAttachments();
        updateSendButton();
        persist();
      } finally {
        if (!upload.sent) imageUploads.delete(id);
      }
    }
  }
  function readDataUrl(file) {
    return new Promise(function (resolvePromise, rejectPromise) {
      const reader = new FileReader();
      reader.addEventListener("load", function () { typeof reader.result === "string" ? resolvePromise(reader.result) : rejectPromise(new Error(t("ui.invalid.image"))); });
      reader.addEventListener("error", function () { rejectPromise(reader.error || new Error(t("ui.image.read.failed"))); });
      reader.addEventListener("abort", function () { rejectPromise(new Error(t("ui.image.read.failed"))); });
      reader.readAsDataURL(file);
    });
  }

  return {
    addBrowserFiles, browserImageMediaType, clipboardImages, addBrowserImages, finishImageUpload, hasAttachmentData, addDroppedData,
    encodeAttachmentImage, addAttachments, renderAttachments, renderHistoryAttachments
  };
};
