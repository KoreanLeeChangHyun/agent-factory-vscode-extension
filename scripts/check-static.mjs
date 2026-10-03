import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// Syntax-check every browser script so a new chat module cannot be missed.
const directory = "static/js";
let failed = false;
for (const name of readdirSync(directory).filter(file => file.endsWith(".js")).sort()) {
  const result = spawnSync(process.execPath, ["--check", `${directory}/${name}`], { stdio: "inherit" });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
