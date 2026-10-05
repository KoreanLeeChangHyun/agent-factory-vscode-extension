/** The Human's periodic documents check interval; a check is report-only (Explorer). */
export const DOCS_AUDIT_INTERVALS = { off: 0, daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 } as const;
export type DocsAuditInterval = keyof typeof DOCS_AUDIT_INTERVALS;

/** Due when an enabled interval has passed since the last check, or since the check was enabled. */
export function docsAuditDue(setting: { readonly interval?: string; readonly lastRunAt?: number } | undefined, now: number): boolean {
  const interval = setting?.interval ?? "off";
  const period = Object.hasOwn(DOCS_AUDIT_INTERVALS, interval) ? DOCS_AUDIT_INTERVALS[interval as DocsAuditInterval] : 0;
  return period > 0 && typeof setting?.lastRunAt === "number" && now - setting.lastRunAt >= period;
}
