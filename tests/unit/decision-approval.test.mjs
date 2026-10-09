import assert from "node:assert/strict";
import test from "node:test";
import { importTypeScript } from "../support/import-typescript.mjs";

const { describeDecisionApproval, decisionRequest, irreversibleOperations, approvalMessage } = await importTypeScript("src/modules/chat/decision-approval.ts");

test("approval target is the response's last decision request, quoted verbatim", () => {
  assert.equal(decisionRequest("변경 요약입니다.\n\n- 문서 2개를 갱신했습니다.\n\n이 범위로 구현을 진행할까요?"), "이 범위로 구현을 진행할까요?");
  assert.equal(decisionRequest("Summary first. Shall I apply the two edits above? Thanks."), "Shall I apply the two edits above?");
  assert.equal(decisionRequest("승인해 주시면 Work로 위임하겠습니다.\n\n| 항목 | 값 |\n| --- | --- |\n| a | b |"), "승인해 주시면 Work로 위임하겠습니다.");
  assert.equal(decisionRequest("진행할까요?\n```sh\necho done?\n```"), "진행할까요?");
  assert.equal(decisionRequest("작업을 마쳤습니다. 결과는 위와 같습니다."), undefined);
  assert.equal(decisionRequest(`${"가".repeat(400)}?`).length, 300);
});

test("irreversible operations are detected from clear command shapes", () => {
  const detected = text => irreversibleOperations(text);
  assert.deepEqual(detected("`git checkout -- docs/artifact/evidence/cli-comparison` 로 되돌리기를 권합니다."), ["git checkout -- docs/artifact/evidence/cli-comparison"]);
  assert.deepEqual(detected("```sh\ngit checkout .\ngit reset --hard HEAD\ngit clean -fd\n```"), ["git checkout .", "git reset --hard HEAD", "git clean -fd"]);
  assert.deepEqual(detected("Run `git restore src/a.ts` then `git push --force origin main`."), ["git restore src/a.ts", "git push --force origin main"]);
  assert.deepEqual(detected("`rm -rf build` 후 `git stash drop` 하고 `git branch -D old`"), ["git stash drop", "git branch -D old", "rm -rf build"]);
  assert.deepEqual(detected("Push with `git push -f`."), ["git push -f"]);
});

test("recoverable commands and negated prose do not block one-click approval", () => {
  for (const text of [
    "`git checkout -b feature/x` 로 새 브랜치를 만들까요?",
    "`git restore --staged src/a.ts` 로 스테이징만 해제할까요?",
    "`git reset --soft HEAD~1` 후 다시 커밋할까요?",
    "`git clean -n` 으로 미리 보기만 할까요?",
    "`git push origin main` 을 진행할까요?",
    "`rm notes.tmp` 대신 보관할까요?",
    "커밋되지 않은 변경은 삭제하지 않고 모두 보존합니다. 진행할까요?",
    "Uncommitted changes will not be discarded. Proceed?",
    "The confirm step reverts nothing. Proceed?"
  ]) assert.deepEqual(irreversibleOperations(text), [], text);
  assert.deepEqual(irreversibleOperations("`git restore --staged --worktree a.ts`"), ["git restore --staged --worktree a.ts"]);
});

test("prose that discards uncommitted work is irreversible without a command", () => {
  assert.deepEqual(irreversibleOperations("커밋되지 않은 변경 44개를 되돌릴까요?"), ["커밋되지 않은 변경 44개를 되돌릴까요?"]);
  assert.deepEqual(irreversibleOperations("- Discard the uncommitted edits in docs/."), ["Discard the uncommitted edits in docs/."]);
  assert.deepEqual(describeDecisionApproval("작업 트리의 변경을 덮어쓸까요?").irreversible.length, 1);
});

test("added Korean and English decision, discard and negation expressions", () => {
  assert.equal(decisionRequest("두 방식 중 하나를 선택해 주세요."), "두 방식 중 하나를 선택해 주세요.");
  assert.equal(decisionRequest("Want me to apply this to the docs as well."), "Want me to apply this to the docs as well.");
  assert.equal(decisionRequest("Is it okay to proceed with the migration."), "Is it okay to proceed with the migration.");
  assert.equal(decisionRequest("구현을 마쳤습니다."), undefined);
  assert.deepEqual(irreversibleOperations("커밋되지 않은 변경을 모두 지우겠습니다."), ["커밋되지 않은 변경을 모두 지우겠습니다."]);
  assert.deepEqual(irreversibleOperations("I will reset the uncommitted edits in docs/."), ["I will reset the uncommitted edits in docs/."]);
  assert.deepEqual(irreversibleOperations("Remove the local changes in plugin/."), ["Remove the local changes in plugin/."]);
  assert.deepEqual(irreversibleOperations("커밋되지 않은 변경은 그대로 두고 문서만 덮어씁니다."), []);
  assert.deepEqual(irreversibleOperations("Uncommitted changes stay untouched; the generated file is removed."), []);
});

test("approval message preserves its run, quote and irreversible boundary in each UI language", () => {
  for (const [language, label, boundary] of [
    ["en", "Approves", /not included in this approval/],
    ["ko", "승인 대상", /되돌릴 수 없는 작업.*포함되지 않습니다/]
  ]) {
    for (const request of ["Shall I update both documents?", "이 범위로 구현을 진행할까요?", undefined]) {
      const message = approvalMessage(`run-${language}`, request, language);
      assert.match(message, new RegExp(`run run-${language}`));
      assert.match(message, /git checkout·restore·reset·clean/);
      assert.match(message, boundary);
      if (request) assert.ok(message.includes(`${label}: “${request}”`));
      else assert.ok(!message.includes(label));
      if (language === "en") assert.doesNotMatch(message.replace(request ?? "", ""), /[가-힣]/);
      else assert.match(message, /제안한 범위와 조건대로 진행하세요/);
    }
  }
});

test("controller sends the approval target and refuses one-click approval of irreversible proposals", async () => {
  const { ChatSessionController } = await importTypeScript("src/modules/chat/session-controller.ts");
  let resultText = "";
  const decisions = [], sent = [], human = [];
  const runtime = {
    async submit(agentId) { return { agentId, runId: "proposal-run" }; },
    async send(agentId, text) { sent.push(text); return { agentId, runId: "reply-run" }; },
    async updates() { return { cursor: 0, updates: [] }; },
    async status() { return { status: "needs-human-decision" }; },
    async result() { return { status: "needs-human-decision", text: resultText, decisionKind: "approval" }; }
  };
  const events = {
    onBound() {}, onRunningChanged() {}, onProgress() {}, onActivity() {}, onUsage() {}, onAssistantText() {}, onError() {},
    onDecision(...args) { decisions.push(args); }, onHumanDecision(text) { human.push(text); }
  };
  resultText = "아티팩트 44개를 `git checkout -- docs/artifact/evidence/cli-comparison` 로 되돌릴까요?";
  const blocked = new ChatSessionController(runtime, events, undefined, { pollIntervalMs: 0, maxPolls: 1 });
  await blocked.send("task", [], {});
  assert.deepEqual(JSON.parse(JSON.stringify(decisions.at(-1))), ["proposal-run", false, {
    request: "아티팩트 44개를 `git checkout -- docs/artifact/evidence/cli-comparison` 로 되돌릴까요?",
    irreversible: ["git checkout -- docs/artifact/evidence/cli-comparison"]
  }]);
  assert.equal(blocked.approveDecision("proposal-run", {}), false);
  assert.equal(sent.length, 0);

  resultText = "문서 두 개를 갱신하는 범위로 Work를 진행할까요?";
  for (const [language, label] of [["ko", "승인 대상"], ["en", "Approves"]]) {
    const allowed = new ChatSessionController(runtime, events, undefined, { pollIntervalMs: 0, maxPolls: 1 });
    await allowed.send("task", [], {});
    assert.equal(decisions.at(-1)[1], true);
    assert.equal(allowed.approveDecision("proposal-run", {}, language), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(human.at(-1), /run proposal-run/);
    assert.ok(human.at(-1).includes(`${label}: “문서 두 개를 갱신하는 범위로 Work를 진행할까요?”`));
    assert.ok(sent.at(-1).startsWith(human.at(-1)));
    if (language === "en") assert.match(human.at(-1), /^Proceed only with/);
  }
});
