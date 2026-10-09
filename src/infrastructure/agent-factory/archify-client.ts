import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ArchifyPreview {
  readonly title: string;
  readonly type: "architecture" | "sequence";
  readonly svg: string;
  readonly styles: string;
}

export interface ArchifyOptions {
  readonly script: string;
  readonly python: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** Shares one pinned installation per host; all dependency/snapshot material stays in system temp. */
export class ArchifyClient {
  private installation?: Promise<string>;
  private readonly roots = new Set<string>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly abort = new AbortController();

  constructor(private readonly options: () => Promise<ArchifyOptions>) {}

  async preview(text: string): Promise<ArchifyPreview> {
    const options = await this.options();
    if (!this.installation) {
      this.installation = this.install(options).catch(error => {
        this.installation = undefined;
        throw error;
      });
    }
    const tool = await this.installation;
    const report = await this.run(options, ["preview", "--tool-dir", tool], text);
    if (typeof report.title !== "string" || typeof report.svg !== "string" || typeof report.styles !== "string"
      || !["architecture", "sequence"].includes(String(report.type))) {
      throw new Error("Archify returned an invalid preview.");
    }
    return report as unknown as ArchifyPreview;
  }

  private async install(options: ArchifyOptions): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "agent-factory-archify-editor-"));
    this.roots.add(root);
    const tool = join(root, "renderer");
    try { await this.run(options, ["install", "--tool-dir", tool]); }
    catch (error) { await rm(root, { recursive: true, force: true }); this.roots.delete(root); throw error; }
    return tool;
  }

  private run(options: ArchifyOptions, args: readonly string[], input = ""): Promise<Record<string, unknown>> {
    const operation = new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.abort.signal.aborted) { reject(new Error("Archify editor was closed.")); return; }
      const child = spawn(options.python, [options.script, ...args], {
        shell: false, env: options.environment, signal: this.abort.signal, stdio: ["pipe", "pipe", "pipe"]
      });
      const out: Buffer[] = [], err: Buffer[] = [];
      child.stdout.on("data", data => out.push(Buffer.from(data)));
      child.stderr.on("data", data => err.push(Buffer.from(data)));
      child.stdin.on("error", () => {}); // Missing executables/early validation exits are reported below.
      child.once("error", reject);
      child.once("close", code => {
        const output = Buffer.concat(out).toString("utf8");
        let report: Record<string, unknown>;
        try { report = JSON.parse(output) as Record<string, unknown>; }
        catch { reject(new Error(Buffer.concat(err).toString("utf8").trim() || "Archify tool is unavailable. Use a matching plugin with scripts/archify.py.")); return; }
        if (code !== 0 || report?.ok !== true) { reject(new Error(String(report?.error ?? "Archify could not render this JSON."))); return; }
        resolve(report);
      });
      child.stdin.end(input, "utf8");
    });
    this.running.add(operation);
    void operation.finally(() => this.running.delete(operation)).catch(() => {});
    return operation;
  }

  dispose(): void {
    this.abort.abort();
    void Promise.allSettled([...this.running]).then(() => Promise.all(
      [...this.roots].map(root => rm(root, { recursive: true, force: true }))
    )).catch(error => console.warn("[Archify] Temporary renderer cleanup failed", error));
  }
}
