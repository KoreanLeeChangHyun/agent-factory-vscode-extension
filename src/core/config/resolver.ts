import { DEFAULT_STATUS_ITEMS } from "./defaults";
import { STATUS_ITEM_IDS, type StatusItemId } from "./types";

const knownStatusItems = new Set<string>(STATUS_ITEM_IDS);

export function resolveStatusItems(
  configured: readonly unknown[] | undefined
): readonly StatusItemId[] {
  if (!configured) {
    return DEFAULT_STATUS_ITEMS;
  }

  const resolved: StatusItemId[] = [];
  for (const value of configured) {
    if (
      typeof value === "string" &&
      knownStatusItems.has(value) &&
      !resolved.includes(value as StatusItemId)
    ) {
      resolved.push(value as StatusItemId);
    }
  }

  return resolved.length > 0 ? resolved : DEFAULT_STATUS_ITEMS;
}
