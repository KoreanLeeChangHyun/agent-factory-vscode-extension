(function () {
  "use strict";

  const colorNames = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];
  const fallback = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
  const maxRuns = 4096;

  function palette(index) {
    if (index < 16) {
      return `var(--vscode-terminal-ansi${index >= 8 ? "Bright" : ""}${colorNames[index % 8]}, ${fallback[index]})`;
    }
    if (index >= 232) {
      const gray = 8 + (index - 232) * 10;
      return `rgb(${gray}, ${gray}, ${gray})`;
    }
    const value = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    return `rgb(${levels[Math.floor(value / 36)]}, ${levels[Math.floor(value / 6) % 6]}, ${levels[value % 6]})`;
  }

  function sgr(parameters, state) {
    // Colon syntax includes an optional color-space slot (38:2::r:g:b).
    const parts = parameters.split(";");
    for (let i = 0; i < parts.length; i += 1) {
      const sub = parts[i].split(":");
      const code = Number(sub[0]);
      if (code === 0) {
        for (const key of Object.keys(state)) delete state[key];
      } else if (code === 1) state.fontWeight = "bold";
      else if (code === 3) state.fontStyle = "italic";
      else if (code === 4) state.textDecoration = "underline";
      else if (code === 22) delete state.fontWeight;
      else if (code === 23) delete state.fontStyle;
      else if (code === 24) delete state.textDecoration;
      else if (code === 39) delete state.color;
      else if (code === 49) delete state.backgroundColor;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        state.color = palette(code >= 90 ? code - 90 + 8 : code - 30);
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        state.backgroundColor = palette(code >= 100 ? code - 100 + 8 : code - 40);
      } else if (code === 38 || code === 48) {
        const values = sub.length > 1 ? sub.slice(1) : parts.slice(i + 1);
        const mode = Number(values[0]);
        const count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
        const offset = mode === 2 && sub.length > 1 && values.length === 5 ? 2 : 1;
        const channels = values.slice(offset, offset + count);
        if (sub.length === 1) i += count ? count + 1 : 1;
        if (!count || channels.length !== count || channels.some(v => !/^\d+$/.test(v) || Number(v) > 255)) continue;
        state[code === 38 ? "color" : "backgroundColor"] = mode === 5
          ? palette(Number(channels[0])) : `rgb(${channels.map(Number).join(", ")})`;
      }
    }
  }

  /** Render each complete output snapshot; never insert terminal text as HTML. */
  function render(text, document) {
    text = String(text ?? "");
    const fragment = document.createDocumentFragment();
    const state = {};
    let buffer = [];
    let runs = 0;
    function flush() {
      if (!buffer.length) return;
      const value = buffer.join("");
      buffer = [];
      if (Object.keys(state).length && runs < maxRuns) {
        const span = document.createElement("span");
        Object.assign(span.style, state);
        span.textContent = value;
        fragment.appendChild(span);
      } else fragment.appendChild(document.createTextNode(value));
      runs += 1;
    }
    for (let i = 0; i < text.length;) {
      const code = text.charCodeAt(i);
      if (code === 27 || (code >= 0x80 && code <= 0x9f)) {
        const escape = code === 27;
        const kind = escape ? text.charCodeAt(i + 1) : code;
        i += escape ? 2 : 1;
        if (kind === 0x5b || (!escape && kind === 0x9b)) {
          const start = i;
          while (i < text.length && !(text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e)) i += 1;
          if (text[i] === "m" && i - start <= 256 && /^[\d;:]*$/.test(text.slice(start, i))) {
            if (runs < maxRuns) {
              flush();
              sgr(text.slice(start, i), state);
            }
          }
          if (i < text.length) i += 1;
        } else if ([0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(kind) && escape ||
          !escape && [0x9d, 0x90, 0x98, 0x9e, 0x9f].includes(kind)) {
          // OSC (including links/clipboard) and other terminal control strings
          // have no authority in the webview. Discard even incomplete strings.
          const osc = kind === 0x5d || kind === 0x9d;
          while (i < text.length) {
            const current = text.charCodeAt(i++);
            if (current === 0x9c || osc && current === 7) break;
            if (current === 27 && text[i] === "\\") { i += 1; break; }
          }
        } else if (escape && kind >= 0x20 && kind <= 0x2f) {
          while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i += 1;
          if (i < text.length) i += 1;
        }
      } else if (code < 32 && code !== 9 && code !== 10 && code !== 13 || code === 127) i += 1;
      else {
        const start = i++;
        while (i < text.length) {
          const next = text.charCodeAt(i);
          if (next < 32 || next >= 0x7f && next <= 0x9f) break;
          i += 1;
        }
        buffer.push(text.slice(start, i));
      }
    }
    flush();
    return fragment;
  }

  globalThis.agentFactoryAnsi = Object.freeze({ render });
})();
