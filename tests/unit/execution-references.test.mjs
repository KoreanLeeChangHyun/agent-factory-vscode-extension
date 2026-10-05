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
test('structured runtime operations render without shell parsing and reject unknown contracts', () => {
  const scripts = output => JSON.parse(JSON.stringify(context.agentFactoryExecutionReferences.runtimeScripts(JSON.stringify(output))));
  const operation = { schemaVersion: 1, provider: 'agent-factory', script: 'exec.py', action: 'submit' };
  assert.equal(scripts({ operation })[0].action, 'submit');
  const wrapped = context.agentFactoryExecutionReferences.managedCommand("python3 - <<'PY'\n# wrapper\nPY", JSON.stringify({ operation, kind: 'ack', agentId: 'work-1', runId: 'run-1', status: 'accepted' }), []);
  assert.equal(wrapped.agentId, 'work-1');
  assert.equal(wrapped.runId, 'run-1');
  assert.equal(wrapped.observedStatus, 'accepted');
  for (const changed of [{ schemaVersion: 2 }, { provider: 'other' }, { script: '__proto__' }, { action: '<script>' }]) {
    assert.deepEqual(scripts({ operation: { ...operation, ...changed } }), []);
  }
  assert.deepEqual(scripts(null), []);
});
test('command outcomes use lifecycle and structured errors without inventing run completion', () => {
  const outcome = event => JSON.parse(JSON.stringify(context.agentFactoryExecutionReferences.commandOutcome(event)));
  assert.equal(outcome({ phase: 'started' }).status, 'running');
  assert.equal(outcome({ phase: 'failed', output: 'plain stderr' }).status, 'failed');
  assert.deepEqual(outcome({ phase: 'completed', output: '{"kind":"error","error":{"code":"invalid_dispatch_id","message":"bad ID"}}' }), {
    status: 'failed', label: 'Failed', detail: 'invalid_dispatch_id: bad ID'
  });
  assert.equal(outcome({ phase: 'completed', output: '{"kind":"ack","runId":"run-1"}' }).label, 'Command completed');
  for (const output of ['null', '[]', 'mixed output\n{}', '{"kind":"error","error":null}']) {
    assert.equal(outcome({ phase: 'completed', output }).status, 'completed');
  }
});
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
  assert.equal(managed(loop + ' start --work-agent work-1 --task-mode plan-work').taskMode, 'plan-work');
  const status = loop + ' status --work-agent work-1 --loop-id loop-1';
  assert.equal(managed(status, JSON.stringify({ workAgentId: 'work-1', loopId: 'loop-1', taskMode: 'plan-work-verification', status: 'active' })).taskMode, 'plan-work-verification');
  assert.equal(managed(status, JSON.stringify({ workAgentId: 'other', loopId: 'loop-1', taskMode: 'work' })).taskMode, undefined);
  assert.equal(managed(status, JSON.stringify({ workAgentId: 'work-1', loopId: 'other', taskMode: 'work' })).taskMode, undefined);
});

test('Factory calls recognize shell/env wrappers, Python flags and direct executable paths', () => {
  for (const command of [
    'env PYTHONUNBUFFERED=1 python3 -u -B skills/agent/scripts/exec.py submit --agent work-1 --role work --task-mode plan',
    'bash -lc "python3 skills/agent/scripts/exec.py submit --agent work-1 --role work --task-mode plan"',
    'X=1 command skills/agent/scripts/exec.py submit --agent work-1 --role work --task-mode plan'
  ]) {
    assert.equal(managed(command).agentId, 'work-1');
    assert.equal(managed(command).taskMode, 'plan');
  }
});

test('Factory utility calls and batched runs retain a dedicated classification without guessed identity', () => {
  const scripts = command => JSON.parse(JSON.stringify(context.agentFactoryExecutionReferences.scriptInvocations(command)));
  assert.equal(scripts(exec + ' capabilities --project-root /repo')[0].action, 'capabilities');
  assert.equal(scripts('python3 skills/agent/scripts/loop.py status --loop-id loop-1')[0].script, 'loop.py');
  assert.equal(scripts(exec + ' status --agent work-1; ' + exec + ' status --agent work-2').length, 2);
  const root = scripts('python3 "/installed plugin/agent-factory/scripts/exec.py" status --agent work-1')[0];
  assert.deepEqual([root.skill, root.script, root.action], ['agent', 'exec.py', 'status']);
  assert.equal(scripts('python3 /p/agent-factory/scripts/loop.py status --loop-id loop-1')[0].script, 'loop.py');
  assert.equal(scripts('python3 /p/agent-factory/scripts/lessons.py --project-root /r record')[0].skill, 'document');
  assert.deepEqual(scripts('python3 scripts/build.py'), []);
  for (const command of ['echo "' + exec + ' status --agent work-1"', 'python3 -c "' + exec + '"', 'cat <<EOF\n' + exec + '\nEOF', 'python3 other/exec.py status']) {
    assert.deepEqual(scripts(command), [], command);
  }
});

test('Factory labels read actions after global options without consuming option values as verbs', () => {
  const scripts = command => JSON.parse(JSON.stringify(context.agentFactoryExecutionReferences.scriptInvocations(command)));
  const prefix = 'python3 "/home/test/.codex/plugins/cache/personal/agent-factory/local/scripts/lessons.py"';
  for (const args of ['--project-root "/repo with spaces" record --input input.json', '--project-root="/repo with spaces" record --input=input.json', 'record --project-root "/repo with spaces" --input input.json']) {
    const [script] = scripts(prefix + ' ' + args);
    assert.equal(script.action, 'record');
    assert.equal(script.target, '/repo with spaces');
  }
  assert.equal(scripts(prefix + ' --project-root status audit')[0].action, 'audit');
  assert.equal(scripts(prefix + ' --project-root /repo --documents-root /docs --input /tmp/record.json record')[0].action, 'record');
  assert.equal(scripts(prefix + ' --unknown record')[0].action, '');
  assert.equal(scripts(prefix + ' --project-root --input record')[0].action, '');
  assert.equal(scripts('python3 /home/test/.gemini/config/plugins/agent-factory/scripts/exec.py doctor')[0].action, 'doctor');
  assert.equal(scripts('python3 /repo/agent-factory/plugin/scripts/loop.py status')[0].action, 'status');
  for (const path of ['scripts/exec.py', '/other/scripts/exec.py', '/tmp/scripts/lessons.py', '/other/agent-factory-copy/scripts/loop.py']) {
    assert.deepEqual(scripts('python3 ' + path + ' status --agent ordinary'), []);
  }
});

test('mixed Factory calls do not borrow another command result or override nonzero exit status', () => {
  const command = exec + ' status --agent work-1; python3 skills/agent/scripts/exec.py doctor';
  assert.equal(managed(command, '{"agentId":"work-1","runId":"run-1","status":"completed"}'), undefined);
  assert.equal(context.agentFactoryExecutionReferences.commandOutcome({ phase: 'completed', exitCode: 2, output: 'usage error' }).status, 'failed');
});

test('wrapped Skill reads include local canonical docs and owned prompts', () => {
  const docs = command => JSON.parse(JSON.stringify(context.agentFactoryExecutionReferences.skillDocuments(command)));
  assert.equal(docs('bash -lc "cat docs/skills/design-main-chat/SKILL.md"')[0].skill, 'design-main-chat');
  assert.equal(docs('env LANG=C cat skills/agent/prompt/work.md')[0].document, 'prompt/work.md');
  assert.equal(docs('command cat skills/agent/SKILL.md skills/convention/references/testing.md').length, 2);
  assert.deepEqual(docs('bash -lc "echo skills/agent/SKILL.md"'), []);
});
