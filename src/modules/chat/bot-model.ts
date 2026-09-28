export function isBotModel(value: unknown): value is string {
  return typeof value === "string" && (value === "" || /^(?:gpt-|codex-|claude-)[A-Za-z0-9._-]{1,90}$/.test(value));
}
