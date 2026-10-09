(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const status = document.getElementById("status"), diagram = document.getElementById("diagram"), image = document.getElementById("image");
  let current;
  document.getElementById("source").addEventListener("click", () => vscode.postMessage({ type: "source" }));
  document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  function render(message) {
    const source = /^<svg\b[^>]*\bxmlns=/.test(message.svg) ? message.svg : message.svg.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
    const svg = new DOMParser().parseFromString(source, "image/svg+xml").documentElement;
    if (svg.localName !== "svg" || svg.querySelector("parsererror, script, foreignObject")) throw new Error("SVG 형식을 읽을 수 없습니다.");
    for (const element of [svg, ...svg.querySelectorAll("*")]) {
      for (const attribute of [...element.attributes]) {
        if (/^on/i.test(attribute.name) || ((attribute.localName === "href" || attribute.localName === "src") && !attribute.value.startsWith("#") && !attribute.value.startsWith("data:image/"))) element.removeAttributeNode(attribute);
      }
    }
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const highContrast = document.body.classList.contains("vscode-high-contrast") || document.body.classList.contains("vscode-high-contrast-light");
    svg.setAttribute("data-theme", document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light") ? "light" : "dark");
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = message.styles + (highContrast ? "\ntext[class]{fill:" + getComputedStyle(document.body).color + "!important}" : "");
    svg.prepend(style);
    const viewBox = svg.getAttribute("viewBox")?.split(/\s+/).map(Number);
    if (viewBox?.length === 4) {
      svg.setAttribute("width", String(viewBox[2])); svg.setAttribute("height", String(viewBox[3]));
      const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      for (const [attribute, value] of Object.entries({ x: viewBox[0], y: viewBox[1], width: viewBox[2], height: viewBox[3] })) background.setAttribute(attribute, String(value));
      background.setAttribute("fill", "var(--bg)");
      style.after(background);
    }
    image.src = "data:image/svg+xml;base64," + btoa(Array.from(new TextEncoder().encode(new XMLSerializer().serializeToString(svg)), byte => String.fromCharCode(byte)).join(""));
    image.alt = message.title;
    document.getElementById("title").textContent = message.title;
    diagram.hidden = false;
    status.hidden = true;
  }
  window.addEventListener("message", event => {
    const message = event.data;
    if (message?.type === "theme" && current) { render(current); return; }
    if (message?.type === "diagram") {
      try { render(message); current = message; } catch (error) { current = undefined; status.textContent = String(error); status.className = "error"; status.hidden = false; diagram.hidden = true; }
      return;
    }
    if (message?.type === "loading" || message?.type === "error") {
      current = undefined;
      status.hidden = false;
      status.className = message.type === "error" ? "error" : "";
      status.textContent = message.type === "error" ? message.message : "도표를 준비하고 있습니다.";
      diagram.hidden = true;
    }
  });
  vscode.postMessage({ type: "ready" });
})();
