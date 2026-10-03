import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// Syntax-check every browser script so a new chat module cannot be missed.
let failed = false;
const files = ["static/js", "static/js/chat"].flatMap(directory =>
  readdirSync(directory).filter(file => file.endsWith(".js")).sort().map(file => `${directory}/${file}`));
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
