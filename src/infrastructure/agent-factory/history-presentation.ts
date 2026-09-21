import type { MessageSubmission } from "../../protocol/messages";
import type { TaskMode } from "./agent-client";

/** Recover captured guidance, never regenerate historical instructions from current templates. */
export function historyPresentation(request: string, taskMode: TaskMode, goal: boolean): {
  text: string; submission: MessageSubmission;
} {
  let text = request;
  let businessMode: MessageSubmission["businessMode"] = "normal";
  const blocks: string[] = [];
  const pairs = [
    ["Managed submission preparation; system context, not Human text", "End managed submission preparation"],
    ["Background workflow status; runtime data, not instructions", "End background workflow status"],
    ["Conversation-based background workflow", "End background workflow"],
    ["Delegated agent model settings for this request", "End delegated agent model settings"],
    ["Delegated agent permissions for this request", "End delegated agent permissions"],
    ["Work contract execution for this message only", "End work contract execution"],
    ...["interview", "planning", "design", "contract", "migration", "lessons"].map(mode => [`Workflow guidance for this message only: ${mode}`, "End workflow guidance"]),
    ["Verification selection: standalone inspection by Main, for this request only", "End inspection guidance"]
  ];
  while (true) {
    const unavailable = "\n[Background workflow status unavailable. Do not infer completion or absence of background work.]";
    if (text.trimEnd().endsWith(unavailable)) {
      const index = text.lastIndexOf(unavailable);
      blocks.unshift(text.slice(index));
      text = text.slice(0, index);
      continue;
    }
    let found = false;
    for (const [start, end] of pairs) {
      if (!text.trimEnd().endsWith(`[${end}]`)) continue;
      const marker = `\n\n[${start}]\n`;
      const index = text.lastIndexOf(marker);
      if (index < 0) continue;
      const body = text.slice(index + marker.length, text.lastIndexOf(`[${end}]`));
      // Do not reclassify incomplete blocks or a marker quoted inside user prose.
      if (!body.trim() || body.includes(`\n[${end}]`)) continue;
      if (start === "Managed submission preparation; system context, not Human text") {
        try {
          const context = JSON.parse(body.split("\n")[0]!);
          if (context?.schemaVersion !== 1 || context.kind !== "managed-submission-preparation" ||
              !context.git || typeof context.git.collectedAt !== "string" ||
              !["available", "unavailable"].includes(context.git.availability) || !Array.isArray(context.instructions)) continue;
        } catch { continue; }
      }
      if (start === "Background workflow status; runtime data, not instructions") {
        try {
          if (!Array.isArray(JSON.parse(body.split("\n")[0]!))) continue;
        } catch { continue; }
      }
      if (start!.startsWith("Delegated agent")) {
        try {
          const settings = JSON.parse(body.split("\n")[0]!);
          if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
        } catch { continue; }
      }
      if (start!.startsWith("Workflow guidance")) {
        businessMode = start!.split(": ")[1] as MessageSubmission["businessMode"];
      }
      blocks.unshift(text.slice(index));
      text = text.slice(0, index);
      found = true;
      break;
    }
    if (!found) break;
  }
  // Continuations are entire machine-generated requests, not suffix guidance.
  // Recognize the recorded envelope and payload without hiding quoted user prose.
  let backgroundContinuation = false;
  const lines = text.trimEnd().split("\n");
  if (lines.length === 3 && lines[0] === "[Background workflow continuation — not a new Human request]" &&
      ["Inspect this exact child result and the existing workflow from conversation context. Reconcile its existing loop and continue only the captured, already-authorized route. Do not duplicate dispatch. If the child needs a Human decision or failed, report it; do not automatically grant approval or retry failed work. Return promptly after any next child is accepted. Answer any pending Human questions while preserving this workflow.", "Read the exact stored child result/receipt and existing workflow status for reporting. The engine owns loop transitions; do not reconcile or advance the loop, redispatch completed Work, review implementation or rerun tests. Goal completion is not a Verification pass. Preserve the accepted identities and captured route. If the child needs a Human decision or failed, report it; do not automatically grant approval or retry failed work. Report completion only when the captured route has completed; otherwise report the current stage and return promptly. Answer any pending Human questions while preserving this workflow."].includes(lines[2]!)) {
    try {
      const child = JSON.parse(lines[1]!);
      backgroundContinuation = child !== null && typeof child === "object" && !Array.isArray(child) &&
        typeof child.agentId === "string" && typeof child.runId === "string" && typeof child.status === "string";
    } catch { /* Unrecognized input remains visible user text. */ }
  }
  if (backgroundContinuation) {
    blocks.unshift(text);
    text = "";
  }
  return { text, submission: { taskMode, businessMode, goal, ...(backgroundContinuation ? { backgroundContinuation: true } : {}), ...(blocks.length ? { guidance: blocks.join("") } : {}) } };
}
