import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const context = {};
runInNewContext(await readFile(new URL("../../static/js/ansi-renderer.js", import.meta.url), "utf8"), context);
const document = {
  createDocumentFragment: () => ({ children: [], appendChild(node) { this.children.push(node); } }),
  createElement: tag => ({ tag, style: {}, textContent: "" }),
  createTextNode: textContent => ({ textContent })
};
const render = text => context.agentFactoryAnsi.render(text, document).children;
const content = nodes => nodes.map(node => node.textContent).join("");

test("ANSI output preserves plain text, whitespace and markup as text", () => {
  const source = '<img src=x onerror="alert(1)">\n\t한글 😀\r\n';
  const nodes = render(source);
  assert.equal(content(nodes), source);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].tag, undefined);
});

test("ANSI standard/bright colors and individual style resets", () => {
  const nodes = render("\x1b[31;104;1;3;4mred\x1b[22;23;24;39;49mplain\x1b[0m!");
  assert.match(nodes[0].style.color, /ansiRed/);
  assert.match(nodes[0].style.backgroundColor, /ansiBrightBlue/);
  assert.equal(nodes[0].style.fontWeight, "bold");
  assert.equal(nodes[0].style.fontStyle, "italic");
  assert.equal(nodes[0].style.textDecoration, "underline");
  assert.equal(nodes[1].tag, undefined);
  assert.equal(content(nodes), "redplain!");
});

test("ANSI indexed and RGB colors support semicolon and colon syntax", () => {
  const nodes = render("\x1b[38;5;196;48;5;232mA\x1b[38;2;12;34;56mB\x1b[48:2::1:2:3mC\x1b[38:5:15mD");
  assert.equal(nodes[0].style.color, "rgb(255, 0, 0)");
  assert.equal(nodes[0].style.backgroundColor, "rgb(8, 8, 8)");
  assert.equal(nodes[1].style.color, "rgb(12, 34, 56)");
  assert.equal(nodes[2].style.backgroundColor, "rgb(1, 2, 3)");
  assert.match(nodes[3].style.color, /ansiBrightWhite/);
});

test("ANSI invalid color parameters cannot inject CSS or become style commands", () => {
  const nodes = render("\x1b[38;2;999;1;3mA\x1b[48;5;256mB\x1b[38:2::1:2:999mC");
  assert.equal(content(nodes), "ABC");
  assert.ok(nodes.every(node => node.tag === undefined));
});

test("ANSI OSC links, clipboard, cursor controls and other escape strings are inert", () => {
  const source = "a\x1b]8;;javascript:alert(1)\x07link\x1b]8;;\x1b\\b\x1b]52;c;SECRET\x07c\x1b[2Jd\x1bPpayload\x1b\\e\x1b(Bf\x00\x07";
  const nodes = render(source);
  assert.equal(content(nodes), "alinkbcdef");
  assert.ok(nodes.every(node => node.tag === undefined));
  assert.equal(content(render("a\x1b]unfinished")), "a");
  assert.equal(content(render("a\x1b[31")), "a");
  assert.equal(content(render("a\x9d8;;bad\x9clink\x9b0m")), "alink");
});

test("ANSI snapshots do not leak styles between outputs and preserve multiline style", () => {
  const colored = render("\x1b[32mfirst\nsecond");
  assert.equal(colored.length, 1);
  assert.match(colored[0].style.color, /ansiGreen/);
  assert.equal(render("next")[0].tag, undefined);
  assert.equal(content(render("\x1b[31mred\x1b[mplain")), "redplain");
});

test("ANSI adversarial style changes have bounded DOM expansion without losing text", () => {
  const nodes = render("\x1b[31mx\x1b[32my".repeat(10000));
  assert.ok(nodes.length <= 4097);
  assert.equal(content(nodes), "xy".repeat(10000));
  const resets = render("x\x1b[0m".repeat(10000));
  assert.ok(resets.length <= 4097);
  assert.equal(content(resets), "x".repeat(10000));
});
