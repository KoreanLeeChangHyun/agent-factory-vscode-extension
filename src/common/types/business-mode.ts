export const BUSINESS_MODES = ["normal", "interview", "planning", "design"] as const;
export type BusinessMode = typeof BUSINESS_MODES[number];

/** Workflow guidance belongs to this message, independently of its execution route. */
export function withBusinessMode(text: string, mode: BusinessMode = "normal"): string {
  if (mode === "normal") return text;
  const guidance = {
    interview: "Elicit requirements and unresolved decisions from the Human. Separate evidence, assumptions, and accepted answers.",
    planning: "Develop planning intent, scope, dependencies, and acceptance criteria with the Human.",
    design: "Develop technical design and tradeoffs, keeping planning intent and technical design together."
  }[mode];
  return `${text}\n\n[Workflow guidance for this message only: ${mode}]\n${guidance}
Apply the Document skill's document contract. Keep durable drafts non-authoritative Processed documents, normally Markdown under <project-root>/docs/processed/<category>-<name>/. Do not create a separate document backend.
The Human has requested completion-based Specification promotion for this workflow. Promote on the established workflow completion signal once the Specification identity and meaning are resolved; Human confirmation of completion can supply that signal. Do not add a generic approval gate or ask again for promotion already authorized. Until then, keep drafts Processed; mode selection or Agent completion alone does not accept content. Ask the Human about unresolved naming, classification, completion, or semantic ambiguity. Do not overwrite existing conflicting documents or delete drafts.
For Client Specifications, use the Human-resolved info-*, rule-*, or design-* identity (planning and technical design share design-*, never plan-*). Write the canonical SKILL.md and any assets under docs/skills/<category>-<name>/ in the Human's language or their explicitly selected language. Use docs/original/, docs/processed/, and docs/skills/ for original, processed, and skill documents. Run the Document skill's sync_documents.py after document changes: docs is authoritative and overwrites the corresponding .codex/original/, .codex/processed/, and .codex/skills/ trees, including removing destination-only files. Keep unrelated .codex settings intact and report synchronization failures. Provider Specifications remain in their owning skills/ packages.
Preserve actual provenance. This workflow does not change the task execution route or expand permissions, scope, or approval authority. Apply it only to this message, including when messages are batched.\n[End workflow guidance]`;
}
