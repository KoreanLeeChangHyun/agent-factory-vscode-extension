import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeEnvironment } from "../agent-factory/process-environment";

/** A `workflow_dispatch` input as declared in the workflow file. */
export interface DeployInput {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly type: "string" | "boolean" | "choice" | "number" | "environment";
  readonly default?: string;
  readonly options?: readonly string[];
  /** Next patch version derived from the repository, offered for version-like inputs. */
  readonly suggestion?: string;
}

export interface DeployWorkflow {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly inputs: readonly DeployInput[];
}

/** GitHub deployment pipelines the current project can start manually. */
export interface DeployTarget {
  readonly repository: string;
  readonly ref: string;
  readonly workflows: readonly DeployWorkflow[];
}

export interface DeployRun {
  readonly id: number;
  readonly url: string;
  readonly workflow: string;
  readonly status: string;
  readonly conclusion?: string;
}

export type GhRunner = (arguments_: readonly string[], cwd: string) => Promise<string>;

export class DeployError extends Error {
  constructor(readonly code: "gh-missing" | "not-github" | "invalid-input" | "unknown-workflow" | "run-not-found", message: string) {
    super(message);
    this.name = "DeployError";
  }
}

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const MAX_VALUE_LENGTH = 1_000;

export const runGh: GhRunner = (arguments_, cwd) => new Promise((resolve, reject) => {
  execFile("gh", [...arguments_], {
    cwd, env: { ...runtimeEnvironment(), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true
  }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(new DeployError("gh-missing", "GitHub CLI (gh) is not installed."));
    reject(new Error((stderr || error.message).trim().slice(0, 2_000)));
  });
});

// ------------------------------------------------------------------ parsing

interface Line { readonly indent: number; readonly text: string }

class Lines {
  readonly items: Line[] = [];
  constructor(source: string) {
    for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
      const text = stripComment(raw).trimEnd();
      if (text.trim()) this.items.push({ indent: text.length - text.trimStart().length, text: text.trim() });
    }
  }
  at(index: number): Line { return this.items[index] ?? { indent: -1, text: "" }; }
  /** Indices of the direct children of the block that starts at `start`. */
  children(start: number): number[] {
    const parent = this.at(start).indent;
    const result: number[] = [];
    let childIndent = -1;
    for (let i = start + 1; i < this.items.length && this.at(i).indent > parent; i++) {
      if (childIndent < 0) childIndent = this.at(i).indent;
      if (this.at(i).indent === childIndent) result.push(i);
    }
    return result;
  }
  find(indices: readonly number[], ...names: string[]): number | undefined {
    return indices.find(i => { const kv = keyValue(this.at(i).text); return kv !== undefined && names.includes(kv[0]); });
  }
  listItems(start: number): string[] {
    return this.children(start).filter(i => this.at(i).text.startsWith("- ")).map(i => scalar(this.at(i).text.slice(2)));
  }
}

function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === "\"") quote = char;
    else if (char === "#" && (i === 0 || /\s/.test(line.charAt(i - 1)))) return line.slice(0, i);
  }
  return line;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed.charAt(0);
  if (trimmed.length >= 2 && (quote === "\"" || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1).replace(quote === "'" ? /''/g : /\\"/g, quote);
  }
  return trimmed;
}

function keyValue(text: string): [string, string] | undefined {
  const match = /^("[^"]+"|'[^']+'|[^:\s][^:]*?)\s*:(?:\s+(.*))?$/.exec(text);
  return match ? [scalar(match[1] ?? ""), match[2] ?? ""] : undefined;
}

function flowList(value: string): string[] {
  return value.trim().replace(/^\[|\]$/g, "").split(",").map(scalar).filter(Boolean);
}

/**
 * Returns the manual-dispatch inputs of a GitHub Actions workflow, or undefined when
 * the workflow cannot be started manually. Supports the block, flow-list and scalar
 * forms of `on`; values stay strings.
 */
export function parseDispatchInputs(source: string): DeployInput[] | undefined {
  const doc = new Lines(source);
  const topLevel = doc.items.flatMap((line, index) => line.indent === 0 ? [index] : []);
  const on = doc.find(topLevel, "on", "true");
  if (on === undefined) return undefined;
  const inline = keyValue(doc.at(on).text)?.[1].trim() ?? "";
  if (inline) return flowList(inline).includes("workflow_dispatch") ? [] : undefined;
  const events = doc.children(on);
  if (doc.at(events[0] ?? -1).text.startsWith("- ")) return doc.listItems(on).includes("workflow_dispatch") ? [] : undefined;
  const dispatch = doc.find(events, "workflow_dispatch");
  if (dispatch === undefined) return undefined;
  const inputsKey = doc.find(doc.children(dispatch), "inputs");
  if (inputsKey === undefined) return [];
  return doc.children(inputsKey).flatMap(index => {
    const name = keyValue(doc.at(index).text)?.[0];
    if (!name) return [];
    const fields: Record<string, string> = {};
    let options: string[] | undefined;
    for (const child of doc.children(index)) {
      const kv = keyValue(doc.at(child).text);
      if (!kv) continue;
      if (kv[0] === "options") options = kv[1].trim() ? flowList(kv[1]) : doc.listItems(child);
      else fields[kv[0]] = scalar(kv[1]);
    }
    const type = (["boolean", "choice", "number", "environment"] as const).find(value => value === fields.type) ?? "string";
    return [{
      name, type,
      description: fields.description ?? "",
      required: fields.required === "true",
      ...(fields.default !== undefined ? { default: fields.default } : {}),
      ...(options ? { options } : {})
    }];
  });
}

// --------------------------------------------------------------- detection

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

function compare(a: string, b: string): number {
  const [x, y] = [SEMVER.exec(a) ?? [], SEMVER.exec(b) ?? []];
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  return 0;
}

function nextPatch(version: string | undefined): string | undefined {
  const match = version ? SEMVER.exec(version) : undefined;
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : undefined;
}

/** Highest package.json version in the project root and its direct subdirectories. */
async function projectVersion(root: string): Promise<string | undefined> {
  const candidates = [join(root, "package.json")];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") candidates.push(join(root, entry.name, "package.json"));
    }
  } catch { return undefined; }
  const versions: string[] = [];
  for (const file of candidates) {
    try {
      const version = (JSON.parse(await readFile(file, "utf8")) as { version?: unknown }).version;
      if (typeof version === "string" && SEMVER.test(version)) versions.push(version);
    } catch { /* not a package */ }
  }
  return versions.sort(compare).at(-1);
}

async function workflowSource(root: string, repository: string, ref: string, path: string, gh: GhRunner): Promise<string | undefined> {
  try { return await readFile(join(root, path), "utf8"); } catch { /* not checked out; read the remote copy */ }
  try {
    const content = await gh(["api", `repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`, "--jq", ".content"], root);
    return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
  } catch { return undefined; }
}

export async function detectDeployTarget(root: string, gh: GhRunner = runGh): Promise<DeployTarget> {
  let repository: string, ref: string;
  try {
    const view = JSON.parse(await gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], root)) as {
      nameWithOwner?: unknown; defaultBranchRef?: { name?: unknown };
    };
    if (typeof view.nameWithOwner !== "string" || typeof view.defaultBranchRef?.name !== "string") throw new Error("missing repository");
    repository = view.nameWithOwner; ref = view.defaultBranchRef.name;
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw new DeployError("not-github", error instanceof Error ? error.message : String(error));
  }
  const listed = JSON.parse(await gh(["workflow", "list", "-R", repository, "--json", "id,name,path,state"], root)) as
    { id: number; name: string; path: string; state: string }[];
  const suggestion = nextPatch(await projectVersion(root));
  const workflows: DeployWorkflow[] = [];
  for (const workflow of listed) {
    if (workflow.state !== "active" || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(workflow.path)) continue;
    const source = await workflowSource(root, repository, ref, workflow.path, gh);
    const inputs = source === undefined ? undefined : parseDispatchInputs(source);
    if (!inputs) continue;
    workflows.push({
      id: workflow.id, name: workflow.name, path: workflow.path,
      inputs: inputs.map(input => input.type === "string" && /version/i.test(input.name) && !input.default && suggestion ? { ...input, suggestion } : input)
    });
  }
  return { repository, ref, workflows };
}

// ---------------------------------------------------------------- dispatch

/** Accepts only declared inputs with values of the declared type; returns gh `-f` values. */
export function validateDeployInputs(workflow: DeployWorkflow, values: Readonly<Record<string, unknown>>): Record<string, string> {
  const fail = (message: string): never => { throw new DeployError("invalid-input", message); };
  for (const key of Object.keys(values)) if (!workflow.inputs.some(input => input.name === key)) fail(`Unknown input: ${key}`);
  const result: Record<string, string> = {};
  for (const input of workflow.inputs) {
    const raw = values[input.name];
    if (raw === undefined || raw === "") {
      if (input.required && input.default === undefined) fail(`Missing required input: ${input.name}`);
      continue;
    }
    if (input.type === "boolean") {
      if (typeof raw !== "boolean") fail(`${input.name} must be true or false`);
      result[input.name] = String(raw);
      continue;
    }
    if (typeof raw !== "string" || raw.length > MAX_VALUE_LENGTH || /[\u0000-\u0008\u000b-\u001f]/.test(raw)) fail(`Invalid value for ${input.name}`);
    const value = (raw as string).trim();
    if (input.type === "choice" && !input.options?.includes(value)) fail(`${input.name} must be one of ${input.options?.join(", ")}`);
    if (input.type === "number" && !Number.isFinite(Number(value))) fail(`${input.name} must be a number`);
    if (input.suggestion !== undefined && !/^\d+\.\d+\.\d+$/.test(value)) fail(`${input.name} must be a version like ${input.suggestion}`);
    result[input.name] = value;
  }
  return result;
}

interface RunRecord { databaseId: number; url: string; status: string; conclusion?: string; createdAt: string }

function toRun(record: RunRecord, workflow: string): DeployRun {
  return { id: record.databaseId, url: record.url, workflow, status: record.status, ...(record.conclusion ? { conclusion: record.conclusion } : {}) };
}

export async function dispatchDeploy(
  root: string, target: DeployTarget, workflowId: number, values: Readonly<Record<string, unknown>>,
  gh: GhRunner = runGh, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)), now: () => number = Date.now
): Promise<DeployRun> {
  const workflow = target.workflows.find(item => item.id === workflowId);
  if (!workflow) throw new DeployError("unknown-workflow", `Workflow ${workflowId} was not detected in ${target.repository}.`);
  const inputs = validateDeployInputs(workflow, values);
  const started = now();
  await gh(["workflow", "run", String(workflow.id), "-R", target.repository, "--ref", target.ref,
    ...Object.entries(inputs).flatMap(([key, value]) => ["-f", `${key}=${value}`])], root);
  for (let attempt = 0; attempt < 15; attempt++) {
    await wait(attempt === 0 ? 1_500 : 2_000);
    const runs = JSON.parse(await gh(["run", "list", "-R", target.repository, "--workflow", String(workflow.id), "--event", "workflow_dispatch",
      "-L", "5", "--json", "databaseId,url,status,conclusion,createdAt"], root)) as RunRecord[];
    const match = runs.find(run => Date.parse(run.createdAt) >= started - 10_000);
    if (match) return toRun(match, workflow.name);
  }
  throw new DeployError("run-not-found", `Dispatched ${workflow.name}, but its run did not appear yet. Check the Actions tab.`);
}

export async function deployRunStatus(root: string, repository: string, run: DeployRun, gh: GhRunner = runGh): Promise<DeployRun> {
  const record = JSON.parse(await gh(["run", "view", String(run.id), "-R", repository, "--json", "databaseId,url,status,conclusion,createdAt"], root)) as RunRecord;
  return toRun(record, run.workflow);
}
