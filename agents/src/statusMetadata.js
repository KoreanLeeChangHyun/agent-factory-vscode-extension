"use strict";

const { execFile: nodeExecFile, spawn: nodeSpawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFile = promisify(nodeExecFile);

class StatusMetadataReader {
  constructor({ executablePath, workspaceRoot, spawn = nodeSpawn }) {
    this.executablePath = executablePath;
    this.workspaceRoot = workspaceRoot;
    this.spawn = spawn;
  }

  async read() {
    const [gitBranch, rateLimit] = await Promise.all([
      this.#readGitBranch(),
      this.#readRateLimit(),
    ]);
    return { gitBranch, ...rateLimit };
  }

  async #readGitBranch() {
    try {
      const { stdout } = await execFile(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: this.workspaceRoot, timeout: 3_000 },
      );
      const branch = stdout.trim();
      return branch && branch !== "HEAD" ? branch : null;
    } catch {
      return null;
    }
  }

  #readRateLimit() {
    return new Promise((resolve) => {
      const child = this.spawn(this.executablePath, ["app-server", "--stdio"], {
        cwd: this.workspaceRoot,
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      let buffer = "";
      let settled = false;
      const finish = (value = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve(value);
      };
      const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
      const timer = setTimeout(() => finish(), 5_000);
      timer.unref?.();

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.id === 1 && message.result) {
            send({ method: "initialized" });
            send({ method: "account/rateLimits/read", id: 2 });
          }
          if (message.id === 2) {
            const response = message.result || {};
            const buckets = response.rateLimitsByLimitId || {};
            const snapshot = buckets.codex || response.rateLimits || {};
            const window = snapshot.secondary || snapshot.primary;
            finish(window ? {
              weeklyRemainingPercent: Math.max(0, 100 - Number(window.usedPercent || 0)),
              weeklyResetsAt: Number(window.resetsAt) || null,
            } : {});
          }
        }
      });
      child.once("error", () => finish());
      child.once("close", () => finish());
      send({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "agent-factory-agents",
            title: "Agent Factory Agents",
            version: "0.0.1",
          },
          capabilities: null,
        },
      });
    });
  }
}

module.exports = { StatusMetadataReader };
