import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readGitBranch(projectRoot?: string): Promise<string | undefined> {
  if (!projectRoot) return undefined;
  const git = async (args: string[]) => (await execFileAsync("git", args, {
    cwd: projectRoot, timeout: 2_000, maxBuffer: 64 * 1024
  })).stdout.trim();
  try {
    return await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    try {
      return "detached " + await git(["rev-parse", "--short", "HEAD"]);
    } catch {
      return undefined;
    }
  }
}
