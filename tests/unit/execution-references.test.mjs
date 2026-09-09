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
