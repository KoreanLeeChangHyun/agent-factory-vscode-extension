export interface LocalizedMessage { readonly key: string; readonly values: readonly (string | number | boolean | LocalizedMessage)[] }

/** Shared, environment-neutral localization. The VS Code entry point sets the host locale. */
const messages = require("../../static/js/localization.js") as {
  describe(value: string): LocalizedMessage | undefined;
  locale(selection: string, host?: string): "ko" | "en";
  format(key: string, language: string, ...values: (string | number | boolean | LocalizedMessage)[]): string;
};
let hostLanguage = "en";
export function setHostLanguage(language: string): void {
  hostLanguage = messages.locale("auto", language);
}
export function localize(key: string, ...values: (string | number | boolean | LocalizedMessage)[]): string {
  return messages.format(key, hostLanguage, ...values);
}

/** Only strings produced by localize carry UI metadata; arbitrary source data stays opaque. */
export function describeLocalizedMessage(value: string): LocalizedMessage | undefined {
  return messages.describe(value);
}

export function joinLocalizedMessages(parts: readonly string[]): string {
  const present = parts.filter(Boolean);
  if (present.length < 2 || present.length > 4) return present.join("\n");
  return localize("message.lines." + present.length, ...present.map(value => describeLocalizedMessage(value) ?? value));
}
