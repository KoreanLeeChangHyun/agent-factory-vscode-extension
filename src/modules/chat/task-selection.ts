import { TASK_MODES, type TaskMode } from "../../infrastructure/agent-factory/agent-client";

// Composer selections are distinct from the runtime's supported route enum.
export const TASK_SELECTIONS = [...TASK_MODES, "verification"] as const;
export type TaskSelection = typeof TASK_SELECTIONS[number];

export function taskExecution(selection: TaskSelection = "work"): { taskMode: TaskMode; inspectionOnly: boolean } {
  return { taskMode: selection === "verification" ? "direct" : selection, inspectionOnly: selection === "verification" };
}

export function withInspectionGuidance(text: string): string {
  return `${text}\n\n[Verification selection: standalone inspection by Main, for this request only]
Inspect the requested existing artifacts or changes, run appropriate checks, and report findings with evidence and limitations. Resolve the target from the actual Human request and conversation context; ask only if the target is genuinely missing or ambiguous.
Do not implement repairs, promote or rewrite documents, commit, or start Work. Workflow selections do not authorize drafting or promotion during this inspection. This is Main's inspection through the direct runtime route, not independent managed Verification. Do not fabricate a formal Verification pass or receipt. Preserve existing Human authority and execution permissions.\n[End inspection guidance]`;
}
