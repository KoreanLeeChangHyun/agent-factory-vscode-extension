import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import test from 'node:test';
import { importTypeScript } from '../support/import-typescript.mjs';

// Tests may run inside an Agent Factory chat that already exported a live broker handoff.
for (const key of ['AGENT_FACTORY_SUDO_SOCKET', 'AGENT_FACTORY_SUDO_TOKEN', 'AGENT_FACTORY_SUDO_HELPER']) delete process.env[key];

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const output = await build({ entryPoints: [join(root, 'src/infrastructure/vscode/sudo-broker.ts')],
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node18' });
const module = { exports: {} };
new Function('module', 'exports', 'require', output.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));

const helper = join(root, 'static/sudo-request.py');
const fakeRunId = 'run-sudo-test';
const fakeAgentId = 'main-sudo-test';

test('sudo replies accept ciphertext only', async () => {
  const { parseClientMessage } = await importTypeScript('src/protocol/validator.ts');
  const id = '12345678-1234-1234-1234-123456789abc';
  assert.equal(parseClientMessage({ type: 'sudo.reply', id, password: 'secret' }), undefined);
  assert.deepEqual(parseClientMessage({ type: 'sudo.reply', id, key: 'YWJj', iv: 'YWJj', data: 'YWJj', password: 'secret' }),
    { type: 'sudo.reply', id, key: 'YWJj', iv: 'YWJj', data: 'YWJj' });
});

function invoke(command, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [helper, '--', ...command], { env: { ...process.env, ...module.exports.sudoHandoffEnvironment(), AGENT_FACTORY_PARENT_STATE: `/tmp/agents/${fakeAgentId}/runs/${fakeRunId}/state.json`, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

async function encrypt(publicKeyPem, secret) {
  const der = Buffer.from(publicKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
  const publicKey = await webcrypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aes = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const rawKey = await webcrypto.subtle.exportKey('raw', aes);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  return {
    key: Buffer.from(await webcrypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawKey)).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    data: Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, Buffer.from(secret))).toString('base64')
  };
}

test('chat challenge runs only the displayed argument vector after encrypted reply', async () => {
  const secret = 'a'.repeat(300);
  const seen = [], messages = [];
  let broker;
  broker = new module.exports.SudoBroker((runId, agentId) => {
    assert.equal(runId, fakeRunId); assert.equal(agentId, fakeAgentId);
    return { id: 'panel-current', cwd: root, async post(message) {
    messages.push(message);
    if (message.type === 'sudo.challenge') {
      assert.equal(broker.challengeFor('panel-current')?.id, message.id);
      const encrypted = await encrypt(message.publicKey, secret);
      broker.respond('panel-other', { id: message.id, ...encrypted });
      broker.respond('panel-current', { id: message.id, ...encrypted });
    }
  } }; }, async (command, password, cwd) => {
    seen.push({ command, password, cwd });
    return { exitCode: 0, stdout: 'done\n', stderr: '' };
  });
  try {
    await broker.start(helper);
    const result = await invoke(['systemctl', 'restart', 'mmd.service']);
    assert.deepEqual(result, { code: 0, stdout: 'done\n', stderr: '' });
    assert.deepEqual(seen, [{ command: ['systemctl', 'restart', 'mmd.service'], password: secret, cwd: root }]);
    assert.equal(messages[0].type, 'sudo.challenge');
    assert.deepEqual(messages[0].command, ['systemctl', 'restart', 'mmd.service']);
    assert.equal(messages.at(-1).type, 'sudo.closed');
    assert.ok(!JSON.stringify(messages).includes(secret));
  } finally { broker.dispose(); }
});

test('cancelling in chat does not execute the command', async () => {
  let executed = false, broker;
  broker = new module.exports.SudoBroker((runId, agentId) => {
    assert.equal(runId, fakeRunId); assert.equal(agentId, fakeAgentId);
    return { id: 'panel-current', cwd: root, async post(message) {
    if (message.type === 'sudo.challenge') broker.respond('panel-current', { id: message.id, cancelled: true });
  } }; }, async () => { executed = true; return { exitCode: 0, stdout: '', stderr: '' }; });
  try {
    await broker.start(helper);
    const result = await invoke(['systemctl', 'restart', 'mmd.service']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cancelled/);
    assert.equal(executed, false);
  } finally { broker.dispose(); }
});

async function withFakeSudo(script, run) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-factory-sudo-test-'));
  const previousPath = process.env.PATH;
  await writeFile(join(directory, 'sudo'), `#!/usr/bin/env python3
import json, sys
arguments = sys.argv[1:]
if arguments[:2] != ['-S', '-k'] or arguments[2] != '-p' or not arguments[3].startswith('[agent-factory-sudo:') or arguments[4] != '--':
    print('invalid sudo invocation', file=sys.stderr)
    sys.exit(2)
marker, command = arguments[3], arguments[5:]
${script}
`, { mode: 0o700 });
  process.env.PATH = `${directory}:${previousPath}`;
  try { return await run(); } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

function realBroker(password, limits) {
  let broker;
  broker = new module.exports.SudoBroker(() => ({ id: 'panel-current', cwd: root, async post(message) {
    if (message.type === 'sudo.challenge') broker.respond('panel-current', { id: message.id, ...await encrypt(message.publicKey, password) });
  } }), undefined, limits);
  return broker;
}

test('the real execution path gives a password only on stdin after the sudo prompt', async () => {
  await withFakeSudo(`
sys.stderr.write(marker); sys.stderr.flush()
password = sys.stdin.readline().rstrip('\\n')
if password != 'test-password' or password in arguments:
    print('invalid password delivery', file=sys.stderr)
    sys.exit(2)
print(json.dumps(command))
`, async () => {
    const broker = realBroker('test-password');
    try {
      await broker.start(helper);
      const result = await invoke(['systemctl', 'restart', 'mmd.service']);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ['systemctl', 'restart', 'mmd.service']);
      assert.equal(result.stderr, '');
    } finally { broker.dispose(); }
  });
});

test('a command that runs without a sudo prompt never receives the password', async () => {
  await withFakeSudo(`
print(json.dumps(sys.stdin.read()))
`, async () => {
    const broker = realBroker('never-leak', { requestMs: 5000, challengeMs: 5000, executionMs: 5000, promptGraceMs: 50, maxOutputBytes: 65536 });
    try {
      await broker.start(helper);
      const result = await invoke(['tee', '/tmp/x']);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout), '');
    } finally { broker.dispose(); }
  });
});

test('a rejected password stops sudo instead of retrying', async () => {
  await withFakeSudo(`
sys.stderr.write(marker); sys.stderr.flush()
sys.stdin.readline()
sys.stderr.write('Sorry, try again.\\n' + marker); sys.stderr.flush()
sys.stdin.readline()
print('should not run')
`, async () => {
    const broker = realBroker('wrong-password');
    try {
      await broker.start(helper);
      const result = await invoke(['true']);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /rejected/);
      assert.doesNotMatch(result.stdout, /should not run/);
    } finally { broker.dispose(); }
  });
});

test('the handoff requires the broker token and stays out of the host environment', async () => {
  let challenged = false, broker;
  broker = new module.exports.SudoBroker(() => ({ id: 'panel-current', cwd: root, async post(message) {
    if (message.type === 'sudo.challenge') challenged = true;
  } }), async () => { throw new Error('must not execute'); });
  try {
    await broker.start(helper);
    assert.equal(process.env.AGENT_FACTORY_SUDO_SOCKET, undefined);
    assert.equal(process.env.AGENT_FACTORY_SUDO_TOKEN, undefined);
    assert.match(module.exports.sudoHandoffEnvironment().AGENT_FACTORY_SUDO_TOKEN, /^[0-9a-f]{64}$/);
    const forged = await invoke(['id'], { AGENT_FACTORY_SUDO_TOKEN: '0'.repeat(64) });
    assert.equal(forged.code, 1);
    assert.match(forged.stderr, /not authorized/);
    const missing = await invoke(['id'], { AGENT_FACTORY_SUDO_TOKEN: '' });
    assert.equal(missing.code, 2);
    assert.equal(challenged, false);
  } finally { broker.dispose(); }
  assert.deepEqual(module.exports.sudoHandoffEnvironment(), {});
});

test('an unanswered challenge expires and releases the broker', async () => {
  const messages = [];
  const broker = new module.exports.SudoBroker(() => ({ id: 'panel-current', cwd: root, async post(message) { messages.push(message); } }),
    async () => { throw new Error('must not execute'); },
    { requestMs: 5000, challengeMs: 100, executionMs: 5000, promptGraceMs: 50, maxOutputBytes: 65536 });
  try {
    await broker.start(helper);
    const result = await invoke(['id']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /timed out/);
    assert.equal(broker.challengeFor('panel-current'), undefined);
    assert.equal(messages[0].type, 'sudo.challenge');
    assert.equal(messages[0].cwd, root);
    assert.equal(messages[0].agentId, fakeAgentId);
    assert.equal(messages.at(-1).type, 'sudo.closed');
  } finally { broker.dispose(); }
});
