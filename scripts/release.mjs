import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const cleanEnv = { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
delete cleanEnv.VSCE_PAT;
const fail = (message) => { throw new Error(message); };
function run(command, args, credential = false) {
  const result = spawnSync(command, args, {
    cwd: root, shell: false, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: credential ? { ...cleanEnv, VSCE_PAT: process.env.VSCE_PAT } : cleanEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const redact = (value) => process.env.VSCE_PAT ? value.replaceAll(process.env.VSCE_PAT, "[REDACTED]") : value;
  if (result.error || result.status !== 0) {
    fail(redact(`${command} ${args[0]} failed: ${result.error?.message || result.stderr || result.stdout}`));
  }
  return result.stdout;
}
const git = (...args) => run("git", args).trim();
const json = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const names = (...args) => run("git", args).split("\0").filter(Boolean);
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function options(argv) {
  const result = { files: [] };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!["--message", "--version", "--files", "--dry-run", "--resume", "--install", "--published", "--retry-publish", "--publish-via", "--browser-start", "--publication-evidence", "--help"].includes(key)) fail(`Unknown option: ${key}`);
    if (seen.has(key)) fail(`Repeated option: ${key}`);
    seen.add(key);
    if (key === "--files") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) result.files.push(argv[++i]);
      if (!result.files.length) fail("--files requires exact file paths.");
    } else if (["--message", "--version", "--publish-via", "--publication-evidence"].includes(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) fail(`${key} requires a value.`);
      result[key.slice(2)] = argv[++i];
    } else result[key.slice(2)] = true;
  }
  if (result.help) return result;
  if (result["publish-via"] && !["playwright", "vsce"].includes(result["publish-via"])) fail("--publish-via must be playwright or vsce.");
  if (result.resume && result["publish-via"]) fail("--resume preserves the saved publication transport.");
  if (result["browser-start"] && (!result.resume || result.published || result["retry-publish"])) fail("--browser-start requires --resume and cannot confirm or retry publication.");
  if (result["publication-evidence"] && !result.published) fail("--publication-evidence requires --published.");
  if (result.resume && (result.message || result.version || seen.has("--files"))) fail("--resume cannot change the original message, version or files.");
  if (!result.resume && !result.message?.trim()) fail("Provide --message for a new release.");
  if ((result.published || result["retry-publish"]) && !result.resume) fail("Publication recovery flags require --resume.");
  if (result.published && result["retry-publish"]) fail("Choose only one publication recovery flag.");
  return result;
}
function versionParts(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) fail(`Invalid stable version: ${value}`);
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) fail("Version component exceeds the safe integer range.");
  return parts;
}
function validateFiles(files) {
  if (new Set(files).size !== files.length) fail("Duplicate file path.");
  for (const file of files) {
    if (!file || /[\x00-\x1f\x7f\\:*?\[\]]/.test(file) || file.startsWith("-") || path.isAbsolute(file) || file.split("/").some((part) => !part || part === "." || part === ".." || part === ".git") || file === ".vscode/settings.json") fail(`Unsafe file path: ${file}`);
    let current = root;
    for (const part of file.split("/")) {
      current = path.join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail(`Symlink path is not supported: ${file}`);
    }
    if (existsSync(current)) {
      if (!lstatSync(current).isFile()) fail(`Specify files, not directories: ${file}`);
    } else if (!names("ls-files", "-z", "--", file).includes(file)) fail(`Missing file: ${file}`);
    // check-ignore accepts filenames and rejects literal pathspec magic.
    // Keep literal pathspec protection enabled for all other Git commands.
    const ignoreEnv = { ...cleanEnv };
    delete ignoreEnv.GIT_LITERAL_PATHSPECS;
    const ignored = spawnSync("git", ["check-ignore", "-q", "--", file], { cwd: root, env: ignoreEnv });
    if (ignored.status !== 1) fail(`Ignored or invalid file: ${file}`);
  }
}
function cleanIndex() {
  if (names("ls-files", "-u", "-z").length || names("diff", "--cached", "--name-only", "-z").length) fail("Resolve conflicts and staged changes before releasing.");
}
function scope(files) {
  const unexpected = [...names("diff", "--name-only", "-z"), ...names("ls-files", "--others", "--exclude-standard", "-z")]
    .filter((file) => file !== ".vscode/settings.json" || names("ls-files", "-z", "--", file).length)
    .filter((file) => !files.includes(file));
  if (unexpected.length) fail(`Changes outside --files: ${unexpected.join(", ")}`);
}
const vsce = (...args) => run(process.execPath, ["--require", "./scripts/node-file-polyfill.cjs", "./node_modules/@vscode/vsce/vsce", ...args], args[0] !== "package");

let state;
let stateFile;
let lockFile;
let locked = false;
try {
  const opts = options(process.argv.slice(2));
  if (opts.help) {
    console.log("npm run release -- --message 'Release description' [--files file ...] [--version X.Y.Z] [--dry-run] [--install] [--publish-via playwright|vsce]\nnpm run release -- --resume [--dry-run] [--browser-start | --published --publication-evidence 'Marketplace receipt' | --retry-publish]\nSee README.md for recovery requirements.");
  } else {
    if (realpathSync(git("rev-parse", "--show-toplevel")) !== root) fail("The extension must be the Git repository root.");
    if (git("branch", "--show-current") !== "main" || git("rev-parse", "--abbrev-ref", "@{upstream}") !== "origin/main") fail("Release requires main tracking origin/main.");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
      if (existsSync(path.resolve(root, git("rev-parse", "--git-path", marker)))) fail(`Finish Git operation: ${marker}`);
    }
    const gitDir = path.resolve(root, git("rev-parse", "--git-dir"));
    stateFile = path.join(gitDir, "agent-factory-release.json");
    lockFile = path.join(gitDir, "agent-factory-release.lock");
    const save = (stage) => {
      state.stage = stage;
      writeFileSync(`${stateFile}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(`${stateFile}.tmp`, stateFile);
    };
    const previous = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
    if (opts.resume) {
      if (!previous) fail("No saved release to resume.");
      state = previous;
      state.publishVia ??= "vsce"; // Historical releases used VSCE.
      if (!["committed", "pushing", "pushed", "awaiting-browser", "publishing", "published", "installing", "completed"].includes(state.stage)) fail(`Release stopped at ${state.stage}; inspect manifests, index and HEAD manually. Do not start another release until recovery is resolved. See README.`);
      if (state.root !== root || git("rev-parse", "HEAD") !== state.commit) fail("Saved release does not match this checkout HEAD.");
      if (hash(state.vsix) !== state.sha256) fail("Saved VSIX has changed; refusing publication.");
      cleanIndex();
      scope([]);
    } else {
      if (previous && previous.stage !== "completed") fail(`Unfinished release (${previous.stage}); use --resume or the documented manual recovery.`);
      cleanIndex();
      const files = [...new Set([...opts.files, "package.json", "package-lock.json"])];
      validateFiles(opts.files);
      validateFiles(files);
      scope(files);
      const manifest = json("package.json");
      const lock = json("package-lock.json");
      const current = versionParts(manifest.version);
      if (lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version) fail("Manifest and lockfile versions must agree.");
      const version = opts.version || `${current[0]}.${current[1]}.${current[2] + 1}`;
      const next = versionParts(version);
      const firstDifference = next.findIndex((part, i) => part !== current[i]);
      if (firstDifference < 0 || next[firstDifference] < current[firstDifference]) fail("Release version must increase.");
      state = { root, stage: "planned", publishVia: opts["publish-via"] || "playwright", publisher: manifest.publisher, extension: manifest.name, version, files, message: opts.message, install: !!opts.install, base: git("rev-parse", "HEAD"), vsix: path.join(root, "releases", `${manifest.name}-${version}.vsix`) };
      if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.publisher)) fail("Unsafe publisher name.");
      if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) fail("Unsafe extension name.");
      if (existsSync(state.vsix)) fail("Target VSIX already exists; resolve the earlier release first.");
      if (git("rev-parse", "origin/main") !== state.base) fail("HEAD must equal origin/main before a new release.");
    }
    if (opts["browser-start"] && (state.publishVia !== "playwright" || state.stage !== "awaiting-browser")) fail("--browser-start requires a saved Playwright release awaiting browser upload.");
    if (opts.published && state.publishVia === "playwright" && !opts["publication-evidence"]?.trim()) fail("Record the publisher page URL, exact version and observed acceptance with --publication-evidence.");
    if (opts.install && opts.resume && !state.install) fail("Installation was not selected for the saved release; install the recorded VSIX manually if needed.");
    if (opts["dry-run"]) {
      console.log(JSON.stringify({ ...state, plan: `typecheck → static checks → build → package → exact staging → commit → push origin main → publish saved VSIX using ${state.publishVia} → optional install`, note: "Read-only plan; credentials and remote freshness are checked only in live mode." }, null, 2));
    } else {
      if (state.publishVia === "vsce" && !process.env.VSCE_PAT?.trim()) fail("Set VSCE_PAT to a Marketplace token authorized for this publisher.");
      writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      locked = true;
      if (!opts.resume) {
        git("fetch", "origin", "main");
        if (git("rev-parse", "origin/main") !== state.base) fail("Remote main changed; integrate it before releasing.");
        if (state.publishVia === "vsce") vsce("verify-pat", json("package.json").publisher);
        save("preparing");
        for (const file of ["package.json", "package-lock.json"]) {
          const data = json(file);
          data.version = state.version;
          if (file === "package-lock.json") data.packages[""].version = state.version;
          writeFileSync(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`);
        }
        for (const script of ["typecheck", "check:static", "build"]) {
          console.log(`Running ${script}...`);
          run("npm", ["run", script]);
        }
        const changedTests = state.files.filter((file) => file.startsWith("tests/") && file.endsWith(".test.mjs") && existsSync(path.join(root, file)));
        if (changedTests.length) {
          console.log(`Running ${changedTests.length} changed test files...`);
          run(process.execPath, ["--test", ...changedTests]);
        }
        mkdirSync(path.dirname(state.vsix), { recursive: true });
        vsce("package", "--allow-missing-repository", "--baseContentUrl", "https://github.com/KoreanLeeChangHyun/agent-factory-vscode-extension/blob/main/", "--baseImagesUrl", "https://raw.githubusercontent.com/KoreanLeeChangHyun/agent-factory-vscode-extension/main/", "--out", state.vsix);
        state.sha256 = hash(state.vsix);
        if (json("package.json").version !== state.version || json("package-lock.json").version !== state.version) fail("Build changed the release version.");
        cleanIndex();
        scope(state.files);
        if (git("rev-parse", "HEAD") !== state.base) fail("HEAD changed while building.");
        git("add", "--", ...state.files);
        const staged = names("diff", "--cached", "--name-only", "-z");
        if (staged.some((file) => !state.files.includes(file))) fail("Index contains unexpected paths.");
        state.tree = git("write-tree");
        save("committing");
        git("commit", "-m", state.message);
        state.commit = git("rev-parse", "HEAD");
        if (git("rev-parse", "HEAD^{tree}") !== state.tree || git("rev-parse", "HEAD^") !== state.base) fail("Commit hooks or concurrent changes altered the release commit; inspect it manually before publication.");
        if (hash(state.vsix) !== state.sha256) fail("VSIX changed during commit.");
        save("committed");
      }
      cleanIndex();
      scope([]);
      if (["committed", "pushing"].includes(state.stage)) {
        save("pushing");
        git("push", "origin", `${state.commit}:refs/heads/main`);
        save("pushed");
      }
      if (git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0] !== state.commit) fail("Remote main must match the saved release commit.");
      if (state.stage === "publishing") {
        if (opts.published) {
          if (state.publishVia === "playwright") state.publicationEvidence = { observedAt: new Date().toISOString(), description: opts["publication-evidence"] };
          save("published");
        }
        else if (opts["retry-publish"]) save("pushed");
        else fail("Submission outcome is uncertain. Check the Marketplace publisher management page; resume with --published only if this exact submission was accepted, or --retry-publish only after confirming no submission exists, including pending validation.");
      } else if (opts.published || opts["retry-publish"]) fail("Publication recovery flags apply only to the publishing stage.");
      if (state.stage === "pushed") {
        if (state.publishVia === "playwright") save("awaiting-browser");
        else {
          save("publishing");
          vsce("publish", "--packagePath", state.vsix);
          save("published");
        }
      }
      if (state.stage === "awaiting-browser") {
        if (opts["browser-start"]) save("publishing");
        console.log(JSON.stringify({
          kind: "playwright-marketplace-handoff", stage: state.stage,
          publisherUrl: `https://marketplace.visualstudio.com/manage/publishers/${encodeURIComponent(state.publisher)}`,
          extension: `${state.publisher}.${state.extension}`, version: state.version,
          commit: state.commit, vsix: state.vsix, sha256: state.sha256,
          next: opts["browser-start"]
            ? "Use connected Playwright to upload this exact VSIX. Confirm exact version acceptance, then --resume --published --publication-evidence. Do not retry an uncertain submission."
            : "Open publisherUrl with connected Playwright and sign in if needed. Before selecting the VSIX, run --resume --browser-start to record the upload attempt. See README."
        }, null, 2));
      } else {
        if (state.install && ["published", "installing"].includes(state.stage)) {
          save("installing");
          run("code", ["--install-extension", state.vsix, "--force"]);
        }
        save("completed");
        console.log(`Marketplace submission accepted for ${state.version}, commit ${state.commit}, VSIX ${state.vsix}. Automatic validation and public availability are not checked; confirm them in Marketplace.`);
      }
    }
  }
} catch (error) {
  console.error(error.message);
  if (stateFile && existsSync(stateFile)) console.error(`Progress saved in ${stateFile}. Inspect its stage and follow README recovery before retrying. No rollback was performed.`);
  process.exitCode = 1;
} finally {
  if (locked) unlinkSync(lockFile);
}
