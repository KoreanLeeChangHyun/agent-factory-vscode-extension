import type { MessageSubmission } from "../../protocol/messages";
import type { TaskMode } from "./agent-client";

/** Recover captured guidance, never regenerate historical instructions from current templates. */
export function historyPresentation(request: string, taskMode: TaskMode, goal: boolean): {
  text: string; submission: MessageSubmission; capturedRequest?: string;
} {
  let text = request;
  let businessMode: MessageSubmission["businessMode"] = "normal";
  const blocks: string[] = [];
  const separated = new Set<string>();
  const pairs = [
    ["Managed submission preparation; system context, not Human text", "End managed submission preparation"],
    ["Background workflow status; runtime data, not instructions", "End background workflow status"],
    ["Conversation-based background workflow", "End background workflow"],
    ["Orchestrator mode", "End orchestrator mode"],
    ["Maestro mode for this message", "End Maestro mode"],
    ["Work isolation: task Work Units", "End Work isolation"],
    ["Work isolation", "End Work isolation"],
    ["Task Work Units", "End task Work Units"],
    ["Delegated agent model settings for this request", "End delegated agent model settings"],
    ["Delegated agent permissions for this request", "End delegated agent permissions"],
    ["Work contract execution for this message only", "End work contract execution"],
    ...["interview", "planning", "design", "contract", "migration", "lessons", "pipeline"].map(mode => [`Workflow guidance for this message only: ${mode}`, "End workflow guidance"]),
    ["Verification selection: standalone inspection by Main, for this request only", "End inspection guidance"]
  ];
  while (true) {
    // inputCommand appends this legacy, unclosed envelope after all other guidance.
    // Match its complete recorded body so a quoted heading cannot hide user text.
    const handoff = /\n\[Agent Factory administrator command handoff\]\nWhen a command needs sudo and the Human has requested it, use python3 ("(?:[^"\\\r\n]|\\.)+") -- <executable> <arguments\.\.\.>\. This opens a protected password form in the current Main chat\. Pass exact argument tokens, never a shell command string\. Wait for the command result before reporting completion\. Never ask for the password in a normal chat message\.\n\s*$/.exec(text);
    if (handoff && outsideCodeFence(text, handoff.index)) {
      try {
        const helper = JSON.parse(handoff[1]!);
        if (typeof helper === "string" && helper.trim()) {
          blocks.unshift(text.slice(handoff.index));
          text = text.slice(0, handoff.index);
          continue;
        }
      } catch { /* Malformed or quoted instructions remain visible user text. */ }
    }
    const unavailable = "\n[Background workflow status unavailable. Do not infer completion or absence of background work.]";
    if (text.trimEnd().endsWith(unavailable) && outsideCodeFence(text, text.lastIndexOf(unavailable))) {
      const index = text.lastIndexOf(unavailable);
      blocks.unshift(text.slice(index));
      text = text.slice(0, index);
      continue;
    }
    // mergePendingSends records each message's identity as one unclosed line before
    // its workflow guidance; separating it lets the preceding route blocks follow.
    const reference = /\n\[Message reference: [^\s;\]]+; receivedAt: (?:\d{4}-\d{2}-\d{2}T[\d:.]+Z|unknown)\]\n$/.exec(text);
    if (reference && !separated.has("Message reference") && outsideCodeFence(text, reference.index)) {
      blocks.unshift(text.slice(reference.index));
      separated.add("Message reference");
      text = text.slice(0, reference.index);
      continue;
    }
    let found = false;
    for (const [start, end] of pairs) {
      if (separated.has(start!)) continue;
      if (!text.trimEnd().endsWith(`[${end}]`)) continue;
      const marker = `\n\n[${start}]\n`;
      const index = text.lastIndexOf(marker);
      if (index < 0 || !outsideCodeFence(text, index)) continue;
      const body = text.slice(index + marker.length, text.lastIndexOf(`[${end}]`));
      // Do not reclassify incomplete blocks or a marker quoted inside user prose.
      if (!body.trim() || body.includes(`\n[${end}]`)) continue;
      if (start === "Orchestrator mode" &&
          !body.startsWith("This is ordinary conversation in orchestrator mode, not a Human-selected workflow.")) continue;
      // Recognize the recorded app envelope, not an arbitrary heading in Human text.
      if (start === "Maestro mode for this message") {
        const capturedBody = "Use the existing Main conversation to connect requirement understanding, task allocation, runtime status and results. Apply the Main prompt's Maestro contract. Keep the Human original separate from interpretation, assumptions and success criteria. Refer to the exact message and source revisions; read only needed original records.\nPreserve the captured execution route, models, effort, Fast, permissions, pending inputs and actual decisions. Maestro selection grants no additional execution, dispatch, Verification or publication authority. Use the existing allocation/taskBinding/loop and receipt contracts when the captured route authorizes delegation. Report accepted work identities promptly, and distinguish plans from accepted dispatch and completion.\n";
        if (body !== capturedBody) continue;
        businessMode = "maestro";
      }
      if (start === "Managed submission preparation; system context, not Human text") {
        try {
          const context = JSON.parse(body.split("\n")[0]!);
          if (context?.schemaVersion !== 1 || context.kind !== "managed-submission-preparation" ||
              !context.git || typeof context.git.collectedAt !== "string" ||
              !["available", "unavailable"].includes(context.git.availability) || !Array.isArray(context.instructions)) continue;
        } catch { continue; }
      }
      if (start === "Background workflow status; runtime data, not instructions") {
        if (!hasRecordedStatusArray(body)) continue;
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
      separated.add(start!);
      text = text.slice(0, index);
      found = true;
      break;
    }
    if (!found) break;
  }
  // Queued sends place each original's guidance inside numbered envelopes,
  // before the final preparation/handoff suffix. Only accept the complete,
  // sequential envelope format; an example embedded in prose stays untouched.
  // mergePendingSends sends the shared route guidance once before the envelopes;
  // accept that prefix only when it consists entirely of recognized guidance.
  const firstEnvelope = text.indexOf("\n--- 대기 메시지 1 시작 ---\n");
  const sharedPrefix = firstEnvelope >= 0 && outsideCodeFence(text, firstEnvelope) &&
    !historyPresentation(text.slice(0, firstEnvelope), taskMode, goal).text ? text.slice(0, firstEnvelope + 1) : "";
  const queued = splitQueuedRequests(text.slice(sharedPrefix.length));
  if (queued) {
    const originals = queued.map(part => historyPresentation(part, taskMode, goal));
    if (sharedPrefix.trim() || originals.some(part => part.submission.guidance)) {
      const visible = originals.map((part, index) =>
        `--- 대기 메시지 ${index + 1} 시작 ---\n${part.text}\n--- 대기 메시지 ${index + 1} 끝 ---`).join("\n\n");
      const guidance = sharedPrefix + originals.map(part => part.submission.guidance ?? "").join("") + blocks.join("");
      return { text: visible, capturedRequest: request,
        submission: { taskMode, businessMode, goal, guidance } };
    }
  }
  // Continuations are entire machine-generated requests, not suffix guidance.
  // Recognize the recorded envelope and payload without hiding quoted user prose.
  let backgroundContinuation = false;
  const lines = text.trimEnd().split("\n");
  if (lines.length === 3 && lines[0] === "[Background workflow continuation — not a new Human request]" &&
      ["Inspect this exact child result and the existing workflow from conversation context. Reconcile its existing loop and continue only the captured, already-authorized route. Do not duplicate dispatch. If the child needs a Human decision or failed, report it; do not automatically grant approval or retry failed work. Return promptly after any next child is accepted. Answer any pending Human questions while preserving this workflow.", "Read the exact stored child result/receipt and existing workflow status for reporting. The engine owns loop transitions; do not reconcile or advance the loop, redispatch completed Work, review implementation or rerun tests. Goal completion is not a Verification pass. Preserve the accepted identities and captured route. If the child needs a Human decision or failed, report it; do not automatically grant approval or retry failed work. Report completion only when the captured route has completed; otherwise report the current stage and return promptly. Answer any pending Human questions while preserving this workflow.", "Read the exact stored child result/receipt and existing workflow status for reporting. The engine owns loop transitions; do not reconcile or advance the loop, redispatch completed Work, review implementation or rerun tests. Goal completion is not a Verification pass. Preserve the accepted identities and captured route. If the child needs a Human decision or failed, report it; do not automatically grant approval or retry failed work. Report completion only when the captured route has completed; otherwise report the current stage and return promptly. When the workflow is bound to a work contract, record the terminal task statuses and result/receipt evidence in its Main-owned progress record. Answer any pending Human questions while preserving this workflow."].includes(lines[2]!)) {
    try {
      const child = JSON.parse(lines[1]!);
      backgroundContinuation = child !== null && typeof child === "object" && !Array.isArray(child) &&
        typeof child.agentId === "string" && typeof child.runId === "string" && typeof child.status === "string";
    } catch { /* Unrecognized input remains visible user text. */ }
  }
  // Earlier releases recorded the same notification with the older instruction lines.
  if (lines[0] === "[Engine workflow result — not a new Human request]" && (lines.length === 3 || lines.length === 4) &&
      ["The engine owns execution. Read and acknowledge the exact stored result/receipt identity and report the result or exception. Distinguish Work completion, checks, integration, preservation, cleanup and required input. Do not review implementation or rerun tests. Goal completion alone is not a pass. Do not redispatch Work or grant missing approval.",
        "The engine owns execution and has stopped at this recorded state. Acknowledge the exact result/receipt identity and report the complete result or exception to the Human. Do not review implementation or rerun tests. Distinguish Work completion, independent Verification pass, failure, cancellation and required Human input; Goal completion alone is not a pass. Do not dispatch a next task, restart this workflow, or grant missing approval.",
        "The engine owns execution and has stopped at this recorded state. Report the complete result or the exact exception to the Human. Do not dispatch a next task, restart this workflow, or grant missing approval."].includes(lines[2]!)) {
    try {
      const flow = JSON.parse(lines[1]!);
      backgroundContinuation = flow !== null && typeof flow === "object" && !Array.isArray(flow) &&
        typeof flow.loopId === "string" && Boolean(flow.loopId) &&
        typeof flow.status === "string" && Boolean(flow.status) && flow.status !== "active" &&
        // A pendingDecision recorded before the decision line was added has three lines.
        (flow.pendingDecision
          ? lines.length === 3 || lines[3] === "Treat pendingDecision.question as internal worker context. In the Main conversation, summarize the blocker and ask only the concrete question that requires the Human's input. Do not paste the internal report or ask the Human to resolve routine internal bookkeeping. If no Human-owned choice or missing input is identified, report the execution exception without inventing an approval request. Preserve the loop and decision identity; relay an actual Human answer through the existing loop answer command only after it is received."
          : lines.length === 3);
    } catch { /* Malformed or quoted notifications remain visible user text. */ }
  }
  if (backgroundContinuation) {
    blocks.unshift(text);
    text = "";
  }
  return { text, submission: { taskMode, businessMode, goal, ...(backgroundContinuation ? { backgroundContinuation: true } : {}), ...(blocks.length ? { guidance: blocks.join("") } : {}) } };
}

/** Status snapshots were stored as both compact and pretty-printed JSON. */
function hasRecordedStatusArray(body: string): boolean {
  const start = body.search(/\S/);
  if (start < 0 || body[start] !== "[") return false;
  const brackets: string[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const character = body[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "[" || character === "{") brackets.push(character);
    else if (character === "]" || character === "}") {
      if (brackets.pop() !== (character === "]" ? "[" : "{")) return false;
      if (brackets.length === 0) {
        // The captured explanatory prose follows the array on a new line.
        // A standalone JSON quotation or malformed suffix remains Human text.
        const remainder = body.slice(index + 1);
        if (!/^\s*\n/.test(remainder) || !remainder.trim()) return false;
        try { return Array.isArray(JSON.parse(body.slice(start, index + 1))); }
        catch { return false; }
      }
    }
  }
  return false;
}

function outsideCodeFence(text: string, index: number): boolean {
  let fence: string | undefined;
  for (const line of text.slice(0, index).split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) {
      if (marker[1]![0] === "`" && marker[2]!.includes("`")) continue;
      fence = marker[1];
    } else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
      fence = undefined;
    }
  }
  return fence === undefined;
}

function splitQueuedRequests(text: string): string[] | undefined {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const number = parts.length + 1;
    const start = `--- 대기 메시지 ${number} 시작 ---\n`;
    if (!text.startsWith(start, cursor)) return;
    const end = `\n--- 대기 메시지 ${number} 끝 ---`;
    const index = text.indexOf(end, cursor + start.length);
    if (index < 0 || !outsideCodeFence(text, index)) return;
    parts.push(text.slice(cursor + start.length, index));
    cursor = index + end.length;
    if (cursor === text.length) break;
    if (!text.startsWith("\n\n", cursor)) return;
    cursor += 2;
  }
  return parts.length > 1 ? parts : undefined;
}
