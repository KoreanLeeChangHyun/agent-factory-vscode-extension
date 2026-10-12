import type { RequestView } from "../../protocol/messages";

/** Extract explicit brief sections; preserve unknown text in the original, never invent a summary. */
export function requestFields(text: string, completion?: string): RequestView["fields"] {
  const aliases: Record<string, "goal" | "scope" | "completion" | "constraints"> = {
    goal: "goal", objective: "goal", "목표": "goal", "목적": "goal",
    scope: "scope", "범위": "scope", "작업 범위": "scope",
    done: "completion", "completion criteria": "completion", "완료 기준": "completion", "완료 조건": "completion",
    constraints: "constraints", "제약": "constraints", "제약 조건": "constraints", "권한": "constraints"
  };
  const fields: Partial<Record<keyof RequestView["fields"], string>> = {};
  let active: keyof RequestView["fields"] | undefined, fence: string | undefined;
  let activeLevel = 0;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = undefined;
    }
    const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const known = aliases[heading[2]!.replace(/^\d+(?:\.\d+)*\.\s*/, "").toLowerCase()];
      if (known) { active = known; activeLevel = heading[1]!.length; continue; }
      if (!active || heading[1]!.length <= activeLevel) { active = undefined; continue; }
    }
    if (active) fields[active] = (fields[active] ? fields[active] + "\n" : "") + line;
  }
  return { goal: fields.goal?.trim() || text.trim(), scope: fields.scope?.trim() || "",
    completion: fields.completion?.trim() || completion || "", constraints: fields.constraints?.trim() || "" };
}
