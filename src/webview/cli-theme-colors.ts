import type { ThemeRegistration } from "shiki";

const ansiNames = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];
const ansiFallbacks = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"
];

function ansiColor(index: number): string {
  if (index < 16) {
    return `var(--vscode-terminal-ansi${index >= 8 ? "Bright" : ""}${ansiNames[index % 8]}, ${ansiFallbacks[index]})`;
  }
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  const value = index - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  return `rgb(${levels[Math.floor(value / 36)]}, ${levels[Math.floor(value / 6) % 6]}, ${levels[value % 6]})`;
}

/** Keep terminal palette semantics through Shiki's RGB-only token color map. */
export function normalizeCliTheme(theme: ThemeRegistration): {
  theme: ThemeRegistration;
  colors: Map<string, string>;
} {
  const colors = new Map<string, string>();
  const used = new Set<string>();
  const sentinels = new Map<string, string>();

  // Reserve every literal RGB, including short hex and replacement values, so
  // a real token color can never be mistaken for a terminal palette marker.
  function reserve(value: unknown): void {
    if (typeof value === "string") {
      if (/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)) used.add(value.slice(0, 7).toLowerCase());
      else if (/^#[\da-f]{3,4}$/i.test(value)) {
        used.add("#" + [...value.slice(1, 4)].map(channel => channel + channel).join("").toLowerCase());
      }
    } else if (Array.isArray(value)) value.forEach(reserve);
    else if (value && typeof value === "object") Object.values(value).forEach(reserve);
  }
  reserve(theme);
  let next = 0;
  function sentinel(css: string): string {
    const existing = sentinels.get(css);
    if (existing) return existing;
    let color: string;
    do {
      if (next > 0xffffff) throw new Error("No available RGB color for terminal theme marker");
      color = "#" + (next++).toString(16).padStart(6, "0");
    } while (used.has(color));
    used.add(color);
    sentinels.set(css, color);
    colors.set(color, css);
    return color;
  }
  function foreground(value: string | undefined): string | undefined {
    if (!value || !/^#[\da-f]{8}$/i.test(value)) return value;
    const alpha = value.slice(7).toLowerCase();
    if (alpha === "00") return sentinel(ansiColor(Number.parseInt(value.slice(1, 3), 16)));
    if (alpha === "01") return sentinel("var(--vscode-editor-foreground)");
    return value.slice(0, 7);
  }
  function rules(values: NonNullable<ThemeRegistration["settings"]>): NonNullable<ThemeRegistration["settings"]> {
    return values.map(rule => {
      const settings = { ...rule.settings };
      delete settings.background;
      if (settings.foreground !== undefined) settings.foreground = foreground(settings.foreground);
      return { ...rule, settings };
    });
  }

  const normalized: ThemeRegistration = { ...theme };
  delete normalized.bg;
  if (theme.fg !== undefined) normalized.fg = foreground(theme.fg);
  if (theme.settings) normalized.settings = rules(theme.settings);
  if (theme.tokenColors) normalized.tokenColors = rules(theme.tokenColors);
  if (theme.colors) {
    normalized.colors = { ...theme.colors };
    delete normalized.colors["editor.background"];
    const value = normalized.colors["editor.foreground"];
    if (value !== undefined) normalized.colors["editor.foreground"] = foreground(value)!;
  }
  return { theme: normalized, colors };
}
