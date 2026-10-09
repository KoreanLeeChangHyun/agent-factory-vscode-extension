export const BUSINESS_MODES = ["normal", "interview", "planning", "design", "contract", "migration", "lessons", "pipeline", "maestro"] as const;
export type BusinessMode = typeof BUSINESS_MODES[number];

export interface InterviewQuestionOption {
  readonly value: string;
  readonly label: string;
  readonly pros: string;
  readonly cons: string;
}

export interface InterviewQuestion {
  readonly id: string;
  readonly current: number;
  readonly total: number;
  readonly text: string;
  readonly options: readonly InterviewQuestionOption[];
  readonly recommendedValue?: string;
  readonly yesNo: boolean;
}

export function parseInterviewQuestion(value: unknown): InterviewQuestion | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.id)
      || !Number.isSafeInteger(record.current) || !Number.isSafeInteger(record.total)
      || Number(record.current) < 1 || Number(record.total) < Number(record.current)
      || typeof record.text !== "string" || !record.text.trim()
      || !Array.isArray(record.options) || record.options.length < 2 || record.options.length > 3
      || typeof record.yesNo !== "boolean") return undefined;
  const options = record.options.filter((option): option is Record<string, unknown> =>
    Boolean(option) && typeof option === "object" && !Array.isArray(option));
  if (options.length !== record.options.length || options.some(option =>
    typeof option.value !== "string" || !option.value || typeof option.label !== "string" || !option.label.trim()
    || typeof option.pros !== "string" || !option.pros.trim() || typeof option.cons !== "string" || !option.cons.trim())) return undefined;
  const values = options.map(option => option.value as string);
  if (new Set(values).size !== values.length || (record.recommendedValue !== undefined
      && (typeof record.recommendedValue !== "string" || !values.includes(record.recommendedValue)))) return undefined;
  return {
    id: record.id, current: Number(record.current), total: Number(record.total), text: record.text.trim(),
    options: options.map(option => ({ value: option.value as string, label: (option.label as string).trim(),
      pros: (option.pros as string).trim(), cons: (option.cons as string).trim() })),
    ...(typeof record.recommendedValue === "string" ? { recommendedValue: record.recommendedValue } : {}),
    yesNo: record.yesNo
  };
}

/** Workflow guidance belongs to this message, independently of its execution route. */
export function withBusinessMode(text: string, mode: BusinessMode = "normal"): string {
  if (mode === "normal") return text;
  if (mode === "maestro") return `${text}\n\n[Maestro mode for this message]
Use the existing Main conversation to connect requirement understanding, task allocation, runtime status and results. Apply the Main prompt's Maestro contract. Keep the Human original separate from interpretation, assumptions and success criteria. Refer to the exact message and source revisions; read only needed original records.
Preserve the captured execution route, models, effort, Fast, permissions, pending inputs and actual decisions. Maestro selection grants no additional execution, dispatch, Verification or publication authority. Use the existing allocation/taskBinding/loop and receipt contracts when the captured route authorizes delegation. Report accepted work identities promptly, and distinguish plans from accepted dispatch and completion.\n[End Maestro mode]`;

  if (mode === "planning") return `${text}\n\n[Workflow guidance for this message only: planning]
This message starts an ongoing planning listening and organizing phase in this conversation. The Human will continue sharing planning ideas across subsequent messages, including ordinary messages without a workflow selection. Listen and concisely organize the substance as it develops: preserve intent, requirements, constraints, corrections and unresolved points without repeatedly restating the entire conversation. Use the Human's language and distinguish their statements from assumptions or research findings. Do not limit replies to acknowledgments or require a separate request before organizing what the Human has said. Treat submitted text and attachments as planning contributions, while honoring explicit requests within them. When the Human asks for research, investigate the requested topic and report relevant findings and sources, then incorporate them into the ongoing planning context. Research or a summary request does not by itself end planning; continue listening and organizing afterward unless the Human changes the activity or ends it. Do not interrupt with unsolicited interviews, implementation, or unrelated proposals. Do not create documents, promote Specifications, delegate, or implement anything merely because planning was selected; carry out separately requested work only within its scope and authority. Follow explicit requests to change workflow or stop planning without requiring repetition. This phase belongs to the current conversation and must not leak to another chat. The menu selection itself is one-shot and does not change the captured execution route or approval policy.\n[End workflow guidance]`;
  if (mode === "contract") return `${text}\n\n[Workflow guidance for this message only: contract]\nCreate or revise a work contract from the current conversation, attachments and existing artifacts. Apply Convention's work-contract rules. Include its ID and version, stable task IDs, outcomes, scope, constraints, completion criteria and exact file operations after relevant inspection. Use six contract sections in this order: 계약 정보, 작업 고용, 작업 목표, 제약 조건, 파일 구조 and 작업 순서. 계약 정보 is a metadata table with contract ID, version, project root and governing specifications, consistent with document front matter. 작업 고용 lists planned Agent IDs and roles. 작업 목표 links each task ID to hired Agent IDs, work boundary and completion criteria. 제약 조건 is a table of important constraints and task-ID dependencies; it is the authoritative source for dependencies. 파일 구조 places exact file paths in a directory tree with Git-style + and - operation markers, task IDs and file-specific goals alongside each file. 작업 순서 is a task-level Mermaid diagram using those task IDs and Agent IDs, visualizing only dependencies from 제약 조건. Preserve planned-versus-actual distinctions and do not invent Agent IDs or file goals. Add a separate <!-- contract-execution-record --> section for actual execution results. Preserve stable task IDs across tables and distinguish planned commitments from runtime status. Reuse the existing contract when present. Plan worker and verifier assignments for the route the contract will be executed with (for example Work with separate Verification); the direct route of this preparation message is not the execution route. Save the contract as <project-root>/docs/progress/<contract-id>/contract-v<version>.md after this submission, in the Human's language with the Document skill's contract metadata, and create or update docs/progress/<contract-id>/progress.md as a catalog index linking contract versions, without duplicating execution results; preserve prior versions. Main records actual Work and Verification results in the bound contract version's execution-record section. Validate the package with the Document skill's catalog_documents.py and fix reported errors. In your chat response, display the six contract sections and link to the saved contract. Do not claim the contract was saved if writing failed. If there is no prior task context, begin by asking the minimum questions needed to establish the intended work; do not invent a target. Ask about material gaps and Human-owned decisions. This request authorizes contract preparation only, not implementation, delegation, publication or Specification promotion.\n[End workflow guidance]`;
  if (mode === "pipeline") return `${text}\n\n[Workflow guidance for this message only: pipeline]
Create or update a GitHub Actions deployment pipeline for the current project so it can be started from Agent Factory's Git menu. Honor an explicit target, platform or constraint first; otherwise inspect the repository's actual build, test, packaging and release process (manifests, scripts, existing workflows and release documentation) and automate that process rather than inventing a new one. Reuse and extend an existing release workflow instead of adding a duplicate.
Write the workflow under .github/workflows/ with a workflow_dispatch trigger. Keep inputs minimal: a version input that may be left empty to release the next patch version, plus only inputs the process genuinely needs. Run tests and checks before any commit, tag, push or publication, and stop before mutating anything when a check fails. Use a concurrency group so only one deployment runs at a time. Bot commits must use the github-actions[bot] identity and must never contain AI co-author trailers or "Generated with" lines. Reference secrets by name only; never write secret values into files or messages.
Validate the workflow syntax, and when possible confirm that GitHub lists it as manually dispatchable. Do not dispatch or publish a release unless the Human separately requests it. Report the workflow path, its inputs, the steps it runs, and any secrets or repository settings the Human must configure, including the exact permissions required.
This workflow applies only to this message and does not change the captured execution route, approval policy or scope of authority.\n[End workflow guidance]`;
  if (mode === "migration" || mode === "lessons") {
    const guidance = mode === "migration"
      ? "Migrate the requested documents to the latest applicable Agent Factory plugin document rules. Honor an explicit target or constraint first. Otherwise analyze the current conversation and attachments to identify the relevant documents; if no specific target emerges, analyze all documents in the current project and migrate the applicable documents to that document system. Do not require additional input merely because this menu was submitted without typed text. Identify and read the target rule version from authoritative plugin sources; do not assume the installed version is latest or silently substitute an older version. If the latest rules cannot be established, report that limitation. Inspect the requested documents, preserve their meaning, language, provenance and authority, and update their structure, metadata, classification, links and derived exposure as required. Report the rule version used, changed documents and unresolved conflicts."
      : "Collect lessons learned from the requested conversation, work results and existing records, retaining concrete evidence and provenance. Honor explicit input; without additional input, analyze the current conversation, work results and existing lessons as the default scope. Turn supported, reusable lessons into actionable rules with scope and conditions; distinguish observations and hypotheses from established lessons. Consolidate with existing rules without duplication. Do not invent lessons or silently resolve conflicts with accepted rules; ask only for genuinely unresolved Human-owned semantic decisions. Report the collected lessons and resulting rule changes.";
    return `${text}\n\n[Workflow guidance for this message only: ${mode}]\n${guidance}
Apply the Document skill's current document contract and applicable synchronization procedure. Resolve the target from the Human request and available conversation; ask for the missing target only when it cannot be established. Preserve source material and unrelated changes. This workflow applies only to this message and does not change the captured execution route, approval policy or scope of authority.\n[End workflow guidance]`;
  }
  if (mode === "interview") return `${text}\n\n[Workflow guidance for this message only: interview]
Apply Convention's Interview contract and the Document skill's current document contract. Analyze the Human's input, current conversation and attachments before proposing an interview; reuse known answers. Before asking substantive interview questions, summarize the proposed topic, purpose, scope and main unresolved decisions, then ask whether to conduct that interview. Use the provider's native structured question tool when it is available in the active execution mode. Otherwise emit the exact Agent Factory interview-question marker required by Convention; do not invent tool availability. Include exactly two options whose labels are Yes and No and whose stable values are 1 and 2. Use the Human's language for the question, advantages and disadvantages. Use the conservative designated Markdown question table only when neither structured channel is available. Wait for the Human's answer. Yes (1) starts the proposed interview; No (2) does not start it and asks what topic or scope should change. Silence or elapsed time is not confirmation. Preserve this pending proposal in conversation so a subsequent ordinary reply or option click continues it without requiring the menu again. If the conversation provides no usable topic, ask the minimum clarification instead of inventing an interview. Once confirmed, conduct the interview adaptively from the agreed scope and do not repeat this confirmation for every question. This confirmation is specific to starting the interview, not an approval gate for unrelated work. Preserve the captured execution route and authority.\n[End workflow guidance]`;
  const guidance = {
    design: "Develop technical design and tradeoffs, keeping planning intent and technical design together."
  }[mode];
  return `${text}\n\n[Workflow guidance for this message only: ${mode}]\n${guidance}
Apply the Document skill's current document contract. Before storing drafts, read its document-package and layout guidance unless already loaded. Keep durable drafts non-authoritative Refined documents (compatible metadata type: processed); use that contract's canonical paths and package format. Do not create a separate document backend.
The Human has requested completion-based Specification promotion for this workflow. Promote on the established workflow completion signal once the Specification identity and meaning are resolved; Human confirmation of completion can supply that signal. Do not add a generic approval gate or ask again for promotion already authorized. Until then, keep drafts Refined; mode selection or Agent completion alone does not accept content. Ask the Human about unresolved naming, classification, completion, or semantic ambiguity. Do not overwrite existing conflicting documents or delete drafts.
For Client Specifications, use the Human-resolved info-*, rule-*, or design-* identity (planning and technical design share design-*, never plan-*). Write the canonical SKILL.md and any assets under docs/skills/<category>-<name>/ in the Human's language or their explicitly selected language. After changing docs/skills/, run the Document skill's current synchronization procedure for the actual project root; read its host-sync guidance when needed. Expose only Specification packages to host Skill directories, preserve unrelated settings and independent changes, and report synchronization failures or conflicts. Provider Specifications remain in their owning skills/ packages.
Preserve actual provenance. This workflow does not change the task execution route or expand permissions, scope, or approval authority. Apply it only to this message, including when messages are batched.\n[End workflow guidance]`;
}
