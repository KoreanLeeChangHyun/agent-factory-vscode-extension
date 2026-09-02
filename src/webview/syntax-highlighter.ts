import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";
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
  highlight(code: string, language: string, dark: boolean): Promise<readonly (readonly HighlightToken[])[]>;
}

declare global {
  var agentFactorySyntaxHighlighter: SyntaxHighlighterApi | undefined;
}

const languages = [
  bash, c, cpp, csharp, css, dockerfile, go, html, ini, java, javascript, jsx, json, jsonc,
  kotlin, markdown, php, python, ruby, rust, scss, sql, swift, toml, tsx, typescript, xml, yaml
];

const highlighter = createHighlighterCore({
  themes: [darkPlus, lightPlus],
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

globalThis.agentFactorySyntaxHighlighter = {
  languageForPath,
  async highlight(code, language, dark) {
    const instance = await highlighter;
    if (!instance.getLoadedLanguages().includes(language)) return [];
    const result = instance.codeToTokens(code, {
      lang: language,
      theme: dark ? "dark-plus" : "light-plus",
      tokenizeMaxLineLength: 20_000,
      tokenizeTimeLimit: 100
    });
    return result.tokens.map((line) => line.map(({ content, color, fontStyle }) => ({
      content,
      ...(color ? { color } : {}),
      ...(fontStyle ? { fontStyle } : {})
    })));
  }
};
