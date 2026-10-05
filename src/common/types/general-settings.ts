export interface GeneralSettings {
  readonly startup: "restore" | "new";
  readonly notifyCompleted: boolean;
  readonly notifyFailed: boolean;
  readonly notifyDecision: boolean;
  readonly notifyBackgroundOnly: boolean;
  readonly notifySound: boolean;
}

export const GENERAL_SETTINGS_DEFAULTS: GeneralSettings = {
  startup: "restore", notifyCompleted: true, notifyFailed: true,
  notifyDecision: true, notifyBackgroundOnly: true, notifySound: false
};

export function validGeneralSetting(key: unknown, value: unknown): key is keyof GeneralSettings {
  if (key === "startup") return value === "restore" || value === "new";
  return typeof key === "string" && ["notifyCompleted", "notifyFailed", "notifyDecision", "notifyBackgroundOnly", "notifySound"].includes(key)
    && typeof value === "boolean";
}

export function normalizeGeneralSettings(value: unknown): GeneralSettings {
  const settings = { ...GENERAL_SETTINGS_DEFAULTS };
  if (value && typeof value === "object") {
    for (const [key, field] of Object.entries(value)) {
      if (validGeneralSetting(key, field)) Object.assign(settings, { [key]: field });
    }
  }
  return settings;
}

export type NotificationKind = "completed" | "failed" | "decision";

export function shouldNotify(settings: GeneralSettings, kind: NotificationKind, chatFocused: boolean): boolean {
  return (!settings.notifyBackgroundOnly || !chatFocused)
    && settings[kind === "completed" ? "notifyCompleted" : kind === "failed" ? "notifyFailed" : "notifyDecision"];
}
