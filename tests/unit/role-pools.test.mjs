import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { importTypeScript } from "../support/import-typescript.mjs";

const { parseRolePoolMessage } = await importTypeScript("src/protocol/role-pools.ts");
test("area role controls validate their private channel and strip supplied model overrides", () => {
  const area = { domainId: "domain-one", subdomainId: "sub-one" };
  const value = parseRolePoolMessage({ type: "role.pool.control", action: "hire-role", chatId: "chat-one", area, profile: "verification", settings: { model: "untrusted" } });
  assert.deepEqual(value, { type: "role.pool.control", action: "hire-role", chatId: "chat-one", area, profile: "verification" });
  assert.equal(parseRolePoolMessage({ ...value, profile: "main" }), undefined);
  assert.equal(parseRolePoolMessage({ ...value, area: { domainId: "domain-one" } }), undefined);
  assert.equal(parseRolePoolMessage({ ...value, action: "accept-area-task", text: "task" }), undefined);
  const task = parseRolePoolMessage({ ...value, profile: "workLight", action: "accept-area-task", text: "bounded", route: "work-verification" });
  assert.equal(task.profile, "workLight");
  assert.equal(task.route, "work-verification");
});

test("control-center role messages are sent, privately validated and handled using captured role presets", () => {
  const browser = readFileSync(new URL("../../static/js/role-pools.js", import.meta.url), "utf8");
  const host = readFileSync(new URL("../../src/infrastructure/vscode/control-center-window.ts", import.meta.url), "utf8");
  assert.match(browser, /type: "role\.pool\.control"/);
  assert.match(host, /parseRolePoolMessage\(raw\)/);
  assert.match(host, /readAgentDefaults\(this\.orderStore\)\.project/);
  assert.match(host, /modelSelectionCatalog\(\)/);
  assert.match(host, /settings.*selected.*provider: detected\.provider/);
  assert.match(host, /this\.conductor\.control\(root, message\.chatId/);
});
