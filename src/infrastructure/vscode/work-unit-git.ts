import { localize } from "../../common/localization";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const execute = promisify(execFile);
export async function unitGit(root: string, args: string[]): Promise<string> {
  return (await execute("git", ["-C", root, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}
export async function validateUnitBranch(root: string, branch: string): Promise<string | undefined> {
  try { await unitGit(root, ["check-ref-format", `refs/heads/${branch}`]); }
  catch { return localize("unit.branch.invalid"); }
  try { await unitGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); }
  catch { return undefined; }
  return localize("unit.branch.exists");
}
export function completedGitOperations(reflog: string): string[] {
  return reflog.split("\n").filter(line => /\t(?:merge .*:|update by push(?:\s|$))/.test(line)).sort();
}
export async function directBranchEvidence(root: string): Promise<{ key: string; branch: string; operations: string[] }> {
  const common = await unitGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const branch = await unitGit(root, ["symbolic-ref", "--short", "HEAD"]);
  const log = await unitGit(root, ["reflog", "show", "--all", "--date=iso-strict", "--format=%gD%x09%gs%x09%H"]);
  return { key: createHash("sha256").update(common).digest("hex"), branch, operations: completedGitOperations(log) };
}
