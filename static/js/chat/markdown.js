globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.markdown = function (host) {
  "use strict";

  const {
    t, vscode, applySyntaxHighlighting
  } = host;

  const markdown = typeof globalThis.markdownit === "function"
    ? globalThis.markdownit({ html: false, linkify: true, typographer: false }).use(markdownMath).use(markdownSafeMarkup)
    : undefined;
  // Heavy renderers load beside markdown-it only when a message needs them.
  const vendorBase = document.querySelector('script[src*="markdown-it.min.js"]')?.src;
  const scriptNonce = document.currentScript?.nonce;
  const vendorLoads = new Map();
  const mermaidImages = new Map();
  let mermaidQueue = Promise.resolve();
  let mermaidSequence = 0;
  function renderExecutionReferences(container, references) {
    const list = document.createElement("ul");
    list.className = "execution-references agents-list";
    list.setAttribute("aria-label", t("ui.execution.identifiers"));
    for (const reference of references) {
      const row = document.createElement("li");
      row.className = "execution-reference";
      const expectedRole = reference.label === "Work Agent" ? "work" : reference.label === "예약된 Verification Agent" ? "verification" : undefined;
      const canOpen = expectedRole && host.state.role === "main" && host.state.childAgents.some(function (agent) {
        return agent.agentId === reference.id && agent.role === expectedRole;
      });
      const main = document.createElement(canOpen ? "button" : "div");
      main.className = "agent-item execution-reference-main";
      if (canOpen) {
        main.type = "button";
        main.title = reference.id + t("ui.chat.with.session");
        main.addEventListener("click", function () {
          if (host.state.childAgents.some(function (agent) { return agent.agentId === reference.id && agent.role === expectedRole; })) {
            vscode.postMessage({ type: "agent.open", agentId: reference.id });
          }
        });
      }
      const label = document.createElement("span");
      label.className = "agent-role";
      label.textContent = ({ "Work Agent": t("reference.work.agent"), "Work Run": t("reference.work.run"), "Work Session": t("reference.work.session"), "Loop": t("reference.loop"), "예약된 Verification Agent": t("ui.reserved.verification.agent") })[reference.label] || reference.label;
      const id = document.createElement("span");
      id.className = "execution-reference-id";
      id.textContent = reference.id;
      main.append(label, id);
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "execution-reference-copy setting-button";
      copy.textContent = t("ui.copy");
      copy.setAttribute("aria-label", label.textContent + " " + reference.id + t("ui.copy.fafe60"));
      copy.addEventListener("click", function () { vscode.postMessage({ type: "reference.copy", id: reference.id }); });
      row.append(main, copy);
      list.append(row);
    }
    container.append(list);
  }
  // Keep unchanged top-level DOM (including resolved images and highlighted code),
  // but compare output from a full parse so later reference definitions can update it.
  const markdownParts = new WeakMap();
  function renderAssistantMarkdown(container, text, environment) {
    if (!markdown) {
      container.textContent = text;
      return;
    }
    container.classList.add("markdown-body");
    const fragment = document.createElement("template");
    fragment.innerHTML = markdown.render(text, environment);
    const previous = markdownParts.get(container) || [];
    const existing = Array.from(container.childNodes);
    const sources = [];
    const children = Array.from(fragment.content.childNodes).map(function (node, index) {
      const source = node.outerHTML ?? node.textContent;
      sources.push(source);
      return previous[index] === source && existing[index] ? existing[index] : node;
    });
    container.replaceChildren(...children);
    markdownParts.set(container, sources);
    finishAssistantMarkdown(container);
  }
  function appendAssistantMarkdown(container, text, environment) {
    if (!text) return;
    if (!markdown) {
      container.append(document.createTextNode(text));
      return;
    }
    const fragment = document.createElement("div");
    renderAssistantMarkdown(fragment, text, environment);
    container.append(...fragment.childNodes);
  }
  // Math is tokenized before Markdown escapes so TeX backslashes survive; KaTeX renders MathML, which needs no inline styles under the CSP.
  function markdownMath(md) {
    const escape = md.utils.escapeHtml;
    md.block.ruler.before("fence", "math_block", function (state, startLine, endLine, silent) {
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
      const close = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\]" : "";
      if (!close) return false;
      let content = first.slice(2).trimEnd();
      let line = startLine;
      let closed = content.endsWith(close);
      if (closed) content = content.slice(0, -2);
      while (!closed) {
        if (++line >= endLine) return false;
        const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trimEnd();
        closed = text.endsWith(close);
        content += "\n" + (closed ? text.slice(0, -2) : text);
      }
      if (!content.trim()) return false;
      if (silent) return true;
      const token = state.push("math_block", "div", 0);
      token.block = true;
      token.content = content.trim();
      token.map = [startLine, line + 1];
      state.line = line + 1;
      return true;
    }, { alt: ["paragraph", "reference", "blockquote", "list"] });
    md.inline.ruler.before("escape", "math_inline", function (state, silent) {
      const src = state.src;
      const start = state.pos;
      const open = src.startsWith("\\(", start) ? "\\(" : src.startsWith("$$", start) ? "$$" : src[start] === "$" ? "$" : "";
      if (!open) return false;
      const close = open === "\\(" ? "\\)" : open;
      const from = start + open.length;
      // Currency and shell variables stay text: `$` must hug its content and not close before a digit.
      if (open === "$" && (!src[from] || /\s/.test(src[from]))) return false;
      let end = from;
      while ((end = src.indexOf(close, end)) !== -1) {
        if (open !== "\\(" && src[end - 1] === "\\") { end += 1; continue; }
        if (open === "$" && (/\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || ""))) { end += 1; continue; }
        break;
      }
      // Never reach across a code span.
      if (end === -1 || end === from || src.slice(from, end).includes("`")) return false;
      if (!silent) {
        const token = state.push("math_inline", "span", 0);
        token.content = src.slice(from, end);
        token.info = open === "$$" ? "display" : "";
      }
      state.pos = end + close.length;
      return true;
    });
    md.renderer.rules.math_inline = function (tokens, index) {
      const token = tokens[index];
      return '<span class="math-inline"' + (token.info ? ' data-display="true"' : "") + ' data-tex="' + escape(token.content) + '">' + escape(token.content) + "</span>";
    };
    md.renderer.rules.math_block = function (tokens, index) {
      return '<div class="math-block" data-tex="' + escape(tokens[index].content) + '">' + escape(tokens[index].content) + "</div>\n";
    };
  }
  // Model HTML stays escaped except attribute-free inline formatting tags, and table alignment
  // becomes a class because the webview CSP drops inline style attributes.
  function markdownSafeMarkup(md) {
    const safeTags = new Set(["u", "mark", "sub", "sup", "kbd", "ins", "del", "s", "small", "br"]);
    md.inline.ruler.after("escape", "safe_inline_tag", function (state, silent) {
      if (state.src.charCodeAt(state.pos) !== 0x3C) return false;
      const match = /^<(\/?)([a-z]+)\s*(\/?)>/i.exec(state.src.slice(state.pos));
      if (!match) return false;
      const tag = match[2].toLowerCase();
      if (!safeTags.has(tag) || (match[1] && tag === "br")) return false;
      if (!silent) {
        const token = state.push("safe_inline_tag", tag, 0);
        token.meta = { closing: Boolean(match[1]) };
        token.markup = match[0];
      }
      state.pos += match[0].length;
      return true;
    });
    md.renderer.rules.safe_inline_tag = function (tokens, index) {
      const token = tokens[index];
      return token.tag === "br" ? "<br>" : "<" + (token.meta.closing ? "/" : "") + token.tag + ">";
    };
    // Unmatched opening or closing tags fall back to their literal text.
    md.core.ruler.push("safe_inline_tag_balance", function (state) {
      for (const block of state.tokens) {
        if (block.type !== "inline" || !block.children) continue;
        const open = [];
        const unmatched = new Set();
        for (const token of block.children) {
          if (token.type !== "safe_inline_tag" || token.tag === "br") continue;
          if (!token.meta.closing) open.push(token);
          else if (open.length && open[open.length - 1].tag === token.tag) open.pop();
          else unmatched.add(token);
        }
        for (const token of open) unmatched.add(token);
        for (const token of unmatched) { token.type = "text"; token.content = token.markup; }
      }
    });
    md.core.ruler.push("table_align_class", function (state) {
      for (const token of state.tokens) {
        const style = token.attrGet && token.attrGet("style");
        const align = style && /text-align:(left|center|right)/.exec(style);
        if (!align) continue;
        token.attrs = token.attrs.filter(function (attr) { return attr[0] !== "style"; });
        token.attrJoin("class", "align-" + align[1]);
      }
    });
  }
  function loadVendorScript(file, name) {
    if (globalThis[name]) return Promise.resolve(globalThis[name]);
    if (!vendorBase) return Promise.reject(new Error(file));
    if (!vendorLoads.has(file)) {
      vendorLoads.set(file, new Promise(function (resolve, reject) {
        const script = document.createElement("script");
        script.nonce = scriptNonce;
        script.src = new URL(file, vendorBase).href;
        script.onload = function () { globalThis[name] ? resolve(globalThis[name]) : reject(new Error(file)); };
        script.onerror = function () { vendorLoads.delete(file); reject(new Error(file)); };
        document.head.append(script);
      }));
    }
    return vendorLoads.get(file);
  }
  // Unrendered TeX stays visible as source until KaTeX is available; previews render only once it has loaded.
  function renderMath(root) {
    const nodes = Array.from(root.querySelectorAll(".math-inline[data-tex], .math-block[data-tex]"));
    if (!nodes.length) return;
    const apply = function (katex) {
      for (const node of nodes) {
        const tex = node.dataset.tex;
        if (tex === undefined) continue;
        try {
          katex.render(tex, node, { displayMode: node.classList.contains("math-block") || node.dataset.display === "true", output: "mathml", throwOnError: false, strict: "ignore", trust: false });
          delete node.dataset.tex;
        } catch {
          node.classList.add("math-error");
        }
      }
    };
    if (globalThis.katex) apply(globalThis.katex);
    else void loadVendorScript("katex.min.js", "katex").then(apply, function () {});
  }
  // Diagrams become data: SVG images: the document CSP blocks Mermaid's inline <style>, an image document does not.
  function renderMermaid(root) {
    for (const code of root.querySelectorAll("pre > code.language-mermaid:not([data-mermaid])")) {
      const source = code.textContent;
      code.dataset.mermaid = "pending";
      const place = function (src) {
        const pre = code.parentElement;
        if (!pre || pre.tagName !== "PRE") return;
        const figure = document.createElement("figure");
        figure.className = "mermaid-diagram";
        const image = document.createElement("img");
        image.alt = source;
        image.src = src;
        figure.append(image);
        pre.replaceWith(figure);
      };
      if (mermaidImages.has(source)) { place(mermaidImages.get(source)); continue; }
      mermaidQueue = mermaidQueue.then(function () {
        return loadVendorScript("mermaid.min.js", "mermaid");
      }).then(async function (mermaid) {
        if (!mermaidImages.has(source)) {
          const light = document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light");
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: light ? "default" : "dark", htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: getComputedStyle(document.body).fontFamily });
          const { svg } = await mermaid.render("af-mermaid-" + ++mermaidSequence, source);
          mermaidImages.set(source, svgImageSource(svg));
        }
        place(mermaidImages.get(source));
      }).catch(function () {
        code.dataset.mermaid = "failed";
      });
    }
  }
  function svgImageSource(markup) {
    const svg = new DOMParser().parseFromString(markup, "text/html").querySelector("svg");
    const box = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    if (box.length === 4 && box[2] > 0 && box[3] > 0) {
      svg.setAttribute("width", String(Math.ceil(box[2])));
      svg.setAttribute("height", String(Math.ceil(box[3])));
      svg.removeAttribute("style");
    }
    const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(svg));
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    return "data:image/svg+xml;base64," + btoa(binary);
  }
  function finishAssistantMarkdown(container) {
    renderMath(container);
    renderMermaid(container);
    for (const img of container.querySelectorAll("img[src]")) {
      const href = img.getAttribute("src");
      if (img.dataset.localImage || !/^(?:file:\/\/|\/|\.\.?\/)/i.test(href)) continue;
      img.dataset.localImage = href;
      img.removeAttribute("src");
      vscode.postMessage({ type: "image.resolve", href });
    }
    for (const code of container.querySelectorAll("pre > code")) {
      if (code.dataset.highlighted === "true" || code.dataset.mermaid) continue;
      code.dataset.highlighted = "true";
      const languageClass = Array.from(code.classList).find(function (name) { return name.startsWith("language-"); });
      void applySyntaxHighlighting(code, code.textContent, languageClass ? languageClass.slice(9) : "");
    }
    for (const link of container.querySelectorAll("a")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }

  return {
    renderAssistantMarkdown, markdown, renderMath, renderExecutionReferences,
    appendAssistantMarkdown
  };
};
