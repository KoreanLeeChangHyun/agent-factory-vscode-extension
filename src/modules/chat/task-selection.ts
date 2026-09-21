import { TASK_MODES, type TaskMode } from "../../infrastructure/agent-factory/agent-client";

// Composer selections are distinct from the runtime's supported route enum.
export const TASK_SELECTIONS = [...TASK_MODES] as const;
export type TaskSelection = typeof TASK_SELECTIONS[number];

export function taskExecution(selection: TaskSelection = "direct"): { taskMode: TaskMode; inspectionOnly: boolean } {
  return { taskMode: selection, inspectionOnly: false };
}

export function withInspectionGuidance(text: string): string {
  return `${text}\n\n[Verification selection: standalone inspection by Main, for this request only]
Inspect the requested existing artifacts or changes, run appropriate checks, and report findings with evidence and limitations. Resolve the target from the actual Human request and conversation context; ask only if the target is genuinely missing or ambiguous.
Do not implement repairs, promote or rewrite documents, commit, or start Work. Workflow selections do not authorize drafting or promotion during this inspection. This is Main's inspection through the direct runtime route, not independent managed Verification. Do not fabricate a formal Verification pass or receipt. Preserve existing Human authority and execution permissions.\n[End inspection guidance]`;
}

export function withContractExecutionGuidance(mode: TaskMode = "direct"): string {
  if (mode !== "work" && mode !== "work-verification") return "";
  return `\n\n[Work contract execution for this message only]
Execute the work contract established in the current conversation. Apply Convention's work-contract rules and bind the exact contract ID, version, selected task IDs and file operations. Do not silently substitute a newly inferred task or expand the contract. If no usable contract exists or multiple contracts make the target ambiguous, ask the Human to establish or identify it before dispatching work.
${mode === "work" ? "Submit the contract tasks to Work and report its own checks without separate Verification." : "Submit the contract tasks through the Work–Verification loop; bind separate Verification to completed Work and return failures to the same Work and Verification sessions."}
Preserve the captured execution route, approval policy and scope of authority.\n[End work contract execution]`;
}
