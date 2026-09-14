import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import MarkdownIt from "markdown-it";

const context = {};
runInNewContext(await readFile(new URL("../../static/js/execution-references.js", import.meta.url), "utf8"), context);
const markdown = new MarkdownIt({ html: false });
const extract = text => JSON.parse(JSON.stringify(context.agentFactoryExecutionReferences.extract(text, markdown)));
const block = '실행 식별자:\n- Work Agent: `work-123`\n- Work Run: run-123\n- Work Session: `session-123`\n- 예약된 Verification Agent: verification-123\n- Loop: loop-123';

test("exact standalone execution identifier paragraph and contiguous bullets become references", () => {
  const result = extract('진행 내용\n\n' + block + '\n\n다음 안내');
  assert.equal(result.references.length, 5);
  assert.deepEqual(result.references[0], { label: "Work Agent", id: "work-123" });
  assert.equal(result.references[3].id, "verification-123");
  assert.equal(result.before, "진행 내용\n");
  assert.equal(result.after, "다음 안내");
  assert.match(result.text, /^진행 내용\n\n+다음 안내$/);
  assert.equal(extract(block.replaceAll(':', '：')).references.length, 5);
});

test("malformed, unknown, duplicated and nested execution reference blocks remain source-faithful", () => {
  for (const text of [
    block + '\n- Unknown: unknown-123',
    block.replace('work-123', '../work'),
    block.replace('work-123', 'x'.repeat(129)),
    block.replace('work-123', '<script>'),
    block + '\n- Work Agent: work-another',
    block.replace('- Work Run: run-123', '- Work Run: [run-123](https://example.com)'),
    block.replace('- Work Run: run-123', '  - Work Run: run-123'),
    block.replace('- Work Run: run-123', '- Work Run: run-123\n  explanation'),
    '```\n' + block + '\n```',
    block.split('\n').map(line => '> ' + line).join('\n'),
    '여기에 ' + block,
    block + '\n\n' + block
  ]) {
    assert.deepEqual(extract(text), { text, references: [] });
  }
});

const managed = (command, output, children = []) => {
  const result = context.agentFactoryExecutionReferences.managedCommand(command, output, children);
  return result && JSON.parse(JSON.stringify(result));
};
const exec = 'python3 skills/agent/scripts/exec.py';
test('managed commands recognize explicit roles, exact runs, quoted paths and polling substitutions', () => {
  assert.equal(managed(exec + ' submit --agent work-1 --role work --message "hello --role verification"').role, 'work');
  assert.equal(managed('python3 "/repo with spaces/skills/agent/scripts/exec.py" status --agent work-1 --run-id run-1').runId, 'run-1');
  assert.equal(managed('for i in {1..15}; do state_json=$(' + exec + ' status --agent work-1 --run-id run-1); done').action, 'status');
  assert.equal(managed(exec + ' result --agent verifier --run-id run-2', undefined, [{ agentId: 'verifier', role: 'verification' }]).role, 'verification');
  assert.equal(managed(exec + ' submit --agent work-1 --role work', '{"agentId":"work-1","runId":"run-1","kind":"ack"}').runId, 'run-1');
  assert.equal(managed(exec + ' result --agent work-1 --run-id run-1', '{"run":{"agentId":"work-1","runId":"other","status":"completed"}}').observedStatus, undefined);
  assert.equal(managed('python3 skills/agent/scripts/loop.py start --work-agent work-1 --verification-agent verification-1').kind, 'loop');
});
test('ordinary commands, quoted examples and ambiguous multiple invocations stay Bash', () => {
  for (const command of ['echo ready', 'echo ";" "python3" "skills/agent/scripts/exec.py" status --agent work-1', 'cat <<EOF\n' + exec + ' status --agent work-1\nEOF', 'python3 other/exec.py status --agent work-1', 'echo "' + exec + ' status --agent work-1"', "echo 'example; " + exec + " status --agent work-1'", exec + ' status --agent "$agent"', exec + ' status --agent work-1; ' + exec + ' status --agent work-2']) {
    assert.equal(managed(command), undefined, command);
  }
});

test("skill reads identify entrypoint and reference ownership without labeling quoted examples", () => {
  const docs = command => JSON.parse(JSON.stringify(context.agentFactoryExecutionReferences.skillDocuments(command)));
  const prefix = '/home/test/.codex/plugins/cache/agent-factory/agent-factory/1.0.0/skills/';
  assert.deepEqual(docs(`cat ${prefix}convention/references/communication.md`), [{
    skill: 'agent-factory:convention', document: 'references/communication.md', path: `${prefix}convention/references/communication.md`
  }]);
  assert.equal(docs(`sed -n '1,40p' ${prefix}agent/SKILL.md`)[0].skill, 'agent-factory:agent');
  assert.equal(docs('cat "/home/test path/.codex/skills/.system/imagegen/SKILL.md"')[0].skill, 'imagegen');
  assert.equal(docs(`cat ${prefix}agent/SKILL.md; cat ${prefix}convention/references/communication.md`).length, 2);
  assert.deepEqual(docs(`echo 'cat ${prefix}agent/SKILL.md'`), []);
  assert.deepEqual(docs('cat README.md'), []);
});

test("managed loop cards retain the captured route from matching command output", () => {
  const loop = 'python3 skills/agent/scripts/loop.py';
  assert.equal(managed(loop + ' start --work-agent work-1 --task-mode work').taskMode, 'work');
  const status = loop + ' status --work-agent work-1 --loop-id loop-1';
  assert.equal(managed(status, JSON.stringify({ workAgentId: 'work-1', loopId: 'loop-1', taskMode: 'plan-work-verification', status: 'active' })).taskMode, 'plan-work-verification');
  assert.equal(managed(status, JSON.stringify({ workAgentId: 'other', loopId: 'loop-1', taskMode: 'work' })).taskMode, undefined);
  assert.equal(managed(status, JSON.stringify({ workAgentId: 'work-1', loopId: 'other', taskMode: 'work' })).taskMode, undefined);
});
