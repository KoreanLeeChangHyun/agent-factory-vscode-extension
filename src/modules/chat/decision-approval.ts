import { localizeIn } from "../../common/localization";

/**
 * Describes what the one-click approval button approves, using only text from the
 * pending response. Proposals that show irreversible operations are not approvable by
 * one click: the Human must name the operation in a direct reply.
 */
export interface DecisionApproval {
  /** The response's last decision-request sentence, quoted verbatim (whitespace collapsed). */
  readonly request?: string;
  /** Irreversible operations shown in the response, quoted verbatim. */
  readonly irreversible: readonly string[];
}

const MAX_REQUEST_LENGTH = 300;
const MAX_OPERATION_LENGTH = 160;
const MAX_OPERATIONS = 5;

const DECISION_REQUEST = /[?？]\s*$|할까요|될까요|하시겠습니까|주시겠습니까|해도 될지|승인|허락|동의|확인해\s*주|알려\s*주|말씀해\s*주|결정해\s*주|선택해\s*주|정해\s*주|하실지|원하십니까|여쭙|\b(?:shall|should|may|can) (?:i|we)\b|\b(?:do|would) you (?:want|like)\b|\bapprov|\bconfirm\b|\blet me know\b|\bwant me to\b|\bwould you prefer\b|\bplease (?:decide|choose|advise)\b|\b(?:ok|okay) to (?:proceed|continue|go ahead)\b/i;

// Command shapes, not bare command names: `git checkout <branch>` or a staged-only
// restore are recoverable and stay approvable.
const COMMANDS: readonly { readonly pattern: RegExp; readonly accept?: (match: string) => boolean }[] = [
  { pattern: /\bgit\s+checkout\b[^\n`;|&]*?\s(?:--|\.)(?=[\s`;|&]|$)[^\n`]*/g },
  { pattern: /\bgit\s+restore\b[^\n`]*/g, accept: match => !/\s--staged\b/.test(match) || /\s(?:--worktree|-W)\b/.test(match) },
  { pattern: /\bgit\s+reset\b[^\n`]*?\s--hard\b[^\n`]*/g },
  { pattern: /\bgit\s+clean\b[^\n`]*/g, accept: match => /\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=[\s`]|$)/.test(match) },
  { pattern: /\bgit\s+push\b[^\n`]*?(?:\s--force(?:-with-lease)?\b|\s-[a-zA-Z]*f(?=[\s`]|$)|\s\+\S)[^\n`]*/g },
  { pattern: /\bgit\s+stash\s+(?:drop|clear)\b[^\n`]*/g },
  { pattern: /\bgit\s+branch\b[^\n`]*?\s(?:-D|--delete\s+--force|--force\s+--delete)\b[^\n`]*/g },
  { pattern: /\brm\s+[^\n`]*/g, accept: match => /\s(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)(?=[\s`]|$)/.test(match) }
];

// Prose that discards uncommitted work without naming a command.
const UNCOMMITTED = /커밋(?:되지|하지)\s*않은|미커밋|uncommitted|unstaged|작업\s*트리|working[- ]tree|로컬\s*변경|local changes/gi;
const DISCARD = /삭제|폐기|버리|버림|되돌|원복|덮어|초기화|지우|지움|제거|리셋|날리|날림|discard|delete|revert|overwrite|throw away|wipe|roll ?back|\bremov|\berase|\breset\b|\bdrop\b|\bscrap\b|\bnuke\b/i;
const NEGATION = /지\s*않|지\s*말|하지\s*마|금지|보존|유지|그대로\s*두|남겨\s*두|\bnot\b|\bnever\b|n't\b|\bwithout\b|\bpreserv|\bkeep\b|\buntouched\b|\bintact\b|\bretain/i;

export function describeDecisionApproval(text: string): DecisionApproval {
  return { request: decisionRequest(text), irreversible: irreversibleOperations(text) };
}

export function decisionRequest(text: string): string | undefined {
  const lines = text.replace(/```[\s\S]*?(?:```|$)/g, "\n").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)?/, "").trim();
    if (!line || line.startsWith("|")) continue;
    const sentences = line.split(/(?<=[.?!。？])\s+/);
    for (let sentence = sentences.length - 1; sentence >= 0; sentence -= 1) {
      const candidate = sentences[sentence]!.replace(/\s+/g, " ").trim();
      if (candidate && DECISION_REQUEST.test(candidate)) return truncate(candidate, MAX_REQUEST_LENGTH);
    }
  }
  return undefined;
}

export function irreversibleOperations(text: string): string[] {
  const found: string[] = [];
  const add = (value: string) => {
    const operation = truncate(value.replace(/\s+/g, " ").trim(), MAX_OPERATION_LENGTH);
    if (operation && !found.includes(operation) && found.length < MAX_OPERATIONS) found.push(operation);
  };
  for (const { pattern, accept } of COMMANDS) {
    for (const match of text.matchAll(pattern)) if (!accept || accept(match[0])) add(match[0]);
  }
  for (const sentence of text.replace(/```[\s\S]*?(?:```|$)/g, "\n").split(/(?<=[.?!。？])\s+|\r?\n/)) {
    if (!UNCOMMITTED.test(sentence)) continue;
    UNCOMMITTED.lastIndex = 0;
    const remainder = sentence.replace(UNCOMMITTED, " ");
    if (DISCARD.test(remainder) && !NEGATION.test(remainder)) add(sentence.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)?/, ""));
  }
  return found;
}

/**
 * The text sent for a one-click approval names the approved request and response run in
 * the UI language. The quoted request stays verbatim; command names are not translated.
 */
export function approvalMessage(runId: string, request: string | undefined, language?: string): string {
  const scope = localizeIn(language, "decision.approval.message.scope");
  return request
    ? localizeIn(language, "decision.approval.message.scoped", runId, request, scope)
    : localizeIn(language, "decision.approval.message.unscoped", runId, scope);
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}
