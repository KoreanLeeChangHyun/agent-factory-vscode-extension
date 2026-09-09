import { createHighlighterCore } from "shiki/core";
import type { ThemeRegistration } from "shiki";
import cliThemes from "./cli-themes.json";
import { normalizeCliTheme } from "./cli-theme-colors.js";
import githubDarkHighContrast from "@shikijs/themes/github-dark-high-contrast";
import githubLightHighContrast from "@shikijs/themes/github-light-high-contrast";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import catppuccinMocha from "@shikijs/themes/catppuccin-mocha";
import catppuccinLatte from "@shikijs/themes/catppuccin-latte";
import bash from "@shikijs/langs/bash";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import csharp from "@shikijs/langs/csharp";
import css from "@shikijs/langs/css";
import dockerfile from "@shikijs/langs/dockerfile";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import ini from "@shikijs/langs/ini";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import jsx from "@shikijs/langs/jsx";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import kotlin from "@shikijs/langs/kotlin";
import markdown from "@shikijs/langs/markdown";
import php from "@shikijs/langs/php";
import python from "@shikijs/langs/python";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import scss from "@shikijs/langs/scss";
import sql from "@shikijs/langs/sql";
import swift from "@shikijs/langs/swift";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";

interface HighlightToken {
  readonly content: string;
  readonly color?: string;
  readonly fontStyle?: number;
}

interface SyntaxHighlighterApi {
  languageForPath(path: string): string | undefined;
  configureTheme(selection: { name?: string; theme?: ThemeRegistration; error?: string }): Promise<void>;
  highlight(code: string, language: string, dark: boolean, highContrast?: boolean): Promise<readonly (readonly HighlightToken[])[]>;
}

declare global {
  var agentFactorySyntaxHighlighter: SyntaxHighlighterApi | undefined;
}

const languages = [
  bash, c, cpp, csharp, css, dockerfile, go, html, ini, java, javascript, jsx, json, jsonc,
  kotlin, markdown, php, python, ruby, rust, scss, sql, swift, toml, tsx, typescript, xml, yaml
];

const cliMocha = {
  ...catppuccinMocha,
  tokenColors: [
    ...(catppuccinMocha.tokenColors ?? []),
    { scope: ["source.shell entity.name.command.shell", "source.shell support.function.builtin.shell"], settings: { foreground: "#89b4fa", fontStyle: "" } },
    { scope: "source.shell string.unquoted.argument.shell", settings: { foreground: "#cdd6f4", fontStyle: "" } }
  ]
};
const cliLatte = {
  ...catppuccinLatte,
  tokenColors: [
    ...(catppuccinLatte.tokenColors ?? []).map((rule) => ({
      ...rule,
      settings: {
        ...rule.settings,
        ...(rule.settings.foreground?.toLowerCase() === "#40a02b" ? { foreground: "#287b1b" } : {})
      }
    })),
    { scope: ["source.shell entity.name.command.shell", "source.shell support.function.builtin.shell"], settings: { foreground: "#1e66f5", fontStyle: "" } },
    { scope: "source.shell string.unquoted.argument.shell", settings: { foreground: "#4c4f69", fontStyle: "" } }
  ]
};

const highlighter = createHighlighterCore({
  themes: [cliMocha, cliLatte, githubDarkHighContrast, githubLightHighContrast],
  langs: languages,
  engine: createOnigurumaEngine(import("shiki/wasm"))
});

const languageByExtension: Readonly<Record<string, string>> = {
  ".bash": "bash",
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".go": "go",
  ".htm": "html",
  ".html": "html",
  ".ini": "ini",
  ".java": "java",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".jsonc": "jsonc",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".md": "markdown",
  ".mdx": "markdown",
  ".php": "php",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".scss": "scss",
  ".sh": "bash",
  ".sql": "sql",
  ".swift": "swift",
  ".toml": "toml",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml"
};
function languageForPath(path: string): string | undefined {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  const extensionIndex = name.lastIndexOf(".");
  return extensionIndex >= 0 ? languageByExtension[name.slice(extensionIndex)] : undefined;
}

const aliases: Record<string, string> = {
  js: "javascript", ts: "typescript", py: "python", sh: "bash", shell: "bash",
  shellscript: "bash", zsh: "bash", yml: "yaml", md: "markdown", cs: "csharp",
  "c#": "csharp", "c++": "cpp", rs: "rust", rb: "ruby", docker: "dockerfile"
};
let selectedTheme: string | undefined;
let themeRevision = 0;
const themeColors = new Map<string, Map<string, string>>();

function normalizeLanguage(language: string, code: string): string {
  const label = language.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (label) return aliases[label] ?? label;
  // Infer only an explicit interpreter; ordinary prose/unknown code stays plain.
  const shebang = code.split("\n", 1)[0] ?? "";
  if (/^#!.*\b(?:python[\d.]*)\b/.test(shebang)) return "python";
  if (/^#!.*\b(?:bash|sh|zsh)\b/.test(shebang)) return "bash";
  if (/^#!.*\bnode\b/.test(shebang)) return "javascript";
  return "text";
}

globalThis.agentFactorySyntaxHighlighter = {
  languageForPath,
  async configureTheme(selection) {
    const revision = ++themeRevision;
    const instance = await highlighter;
    if (revision !== themeRevision) return;
    if (selection.error) throw new Error(selection.error);
    let name: string | undefined;
    let source: ThemeRegistration | undefined;
    if (selection.theme) {
      name = "codex-custom";
      source = selection.theme;
    } else if (selection.name) {
      if (!Object.hasOwn(cliThemes, selection.name)) throw new Error("Unsupported CLI theme: " + selection.name);
      name = "cli-" + selection.name;
      source = cliThemes[selection.name as keyof typeof cliThemes];
    }
    if (source && name) {
      const normalized = normalizeCliTheme(source);
      instance.loadThemeSync({ ...normalized.theme, name });
      themeColors.set(name, normalized.colors);
    }
    selectedTheme = name;
  },
  async highlight(code, language, dark, highContrast = false) {
    const instance = await highlighter;
    language = normalizeLanguage(language, code);
    if (!instance.getLoadedLanguages().includes(language)) return [];
    if (code.length > 512_000 || code.split("\n").length > 10_000) return [];
    const theme = highContrast
      ? (dark ? "github-dark-high-contrast" : "github-light-high-contrast")
      : selectedTheme ?? (dark ? "catppuccin-mocha" : "catppuccin-latte");
    const colors = themeColors.get(theme);
    const result = instance.codeToTokens(code, {
      lang: language,
      theme,
      tokenizeMaxLineLength: 20_000,
      tokenizeTimeLimit: 100
    });
    return result.tokens.map((line) => line.map(({ content, color, fontStyle }) => ({
      content,
      ...(color ? { color: colors?.get(color.toLowerCase()) ?? color } : {}),
      ...(fontStyle ? { fontStyle } : {})
    })));
  }
};
