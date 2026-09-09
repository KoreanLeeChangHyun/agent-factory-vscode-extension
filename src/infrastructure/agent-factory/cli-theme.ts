import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { parse as parseToml } from "@iarna/toml";

export interface CliTheme {
  name?: string;
  theme?: {
    name: string;
    settings: Array<{ scope?: string | string[]; settings: Record<string, string> }>;
  };
  error?: string;
}

const MAX_BYTES = 2 * 1024 * 1024;
const BUILTIN_NAMES = new Set([
  "ansi", "base16", "base16-eighties-dark", "base16-mocha-dark", "base16-ocean-dark", "base16-ocean-light", "base16-256",
  "catppuccin-frappe", "catppuccin-latte", "catppuccin-macchiato", "catppuccin-mocha", "coldark-cold", "coldark-dark",
  "dark-neon", "dracula", "github", "gruvbox-dark", "gruvbox-light", "inspired-github", "1337", "monokai-extended",
  "monokai-extended-bright", "monokai-extended-light", "monokai-extended-origin", "nord", "one-half-dark", "one-half-light",
  "solarized-dark", "solarized-light", "sublime-snazzy", "two-dark", "zenburn"
]);

async function readBounded(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Theme/config file must be a regular file of at most 2 MiB");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error("Theme/config file exceeds 2 MiB");
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read the CLI's selected theme without changing its configuration. */
export async function readCliTheme(codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")): Promise<CliTheme> {
  let name: string | undefined;
  try {
    let config: string;
    try { config = await readBounded(join(codexHome, "config.toml")); }
    catch (error) { if (missing(error)) return {}; throw error; }
    const tui = parseToml(config).tui;
    if (!record(tui) || tui.theme === undefined) return {};
    if (typeof tui.theme !== "string") throw new Error("tui.theme must be a string");
    name = tui.theme.trim();
    if (!name) return {};
    if (/[\\/\0]/u.test(name) || name === "." || name === "..") throw new Error("Invalid theme name");
    if (BUILTIN_NAMES.has(name)) return { name };
    let xml: string;
    try {
      const root = await realpath(join(codexHome, "themes"));
      const path = await realpath(join(root, `${name}.tmTheme`));
      const within = relative(root, path);
      if (within.startsWith("..") || isAbsolute(within)) throw new Error("Theme file escapes the themes directory");
      xml = await readBounded(path);
    } catch (error) { if (missing(error)) return { name }; throw error; }
    // TextMate's normal external DOCTYPE is harmless: xmldom does not fetch it.
    // Reject entity declarations rather than accepting user-defined expansion.
    if (/<!ENTITY\s/i.test(xml)) throw new Error("Theme entity declarations are unsupported");
    const { parse } = await import("plist");
    const parsed: unknown = parse(xml);
    if (!record(parsed) || !Array.isArray(parsed.settings) || parsed.settings.length === 0) {
      throw new Error("Theme must contain TextMate settings");
    }
    const settings = parsed.settings.map((entry) => {
      if (!record(entry) || !record(entry.settings)) throw new Error("Invalid TextMate settings entry");
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(entry.settings)) {
        if (typeof value !== "string") throw new Error("TextMate setting values must be strings");
        Object.defineProperty(values, key, { value, enumerable: true, configurable: true, writable: true });
      }
      if (entry.scope === undefined) return { settings: values };
      if (typeof entry.scope !== "string" && !(Array.isArray(entry.scope) && entry.scope.every((scope) => typeof scope === "string"))) {
        throw new Error("Invalid TextMate scope");
      }
      return { scope: entry.scope as string | string[], settings: values };
    });
    return { name, theme: { name, settings } };
  } catch (error) {
    return { ...(name ? { name } : {}), error: error instanceof Error ? error.message : String(error) };
  }
}
