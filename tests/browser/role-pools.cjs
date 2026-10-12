const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function checkRolePools(page) {
  const plugin = path.resolve(__dirname, '../../../plugin');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-role-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'af-role-project-'));
  const env = { ...process.env, AGENT_FACTORY_HOME: home, PYTHONPATH: path.join(plugin, 'runtime') };
  delete env.AGENT_FACTORY_CODEX_POOL;
  let configured;
  try { configured = JSON.parse(execFileSync('python3', ['-c', `import sys,json
from pathlib import Path
from storage import paths
from tasks import domains
r=Path(paths.resolve(sys.argv[1],create=True)['runtimeRoot'])
d=domains.create(r,'Engineering','human','browser fixture')['domainId']
s=domains.subdomain(r,d,'Runtime','human','browser fixture',write_scope=[])['subdomain']['id']
print(json.dumps({'domainId':d,'subdomainId':s}))`, project], { env, encoding: 'utf8' })); } catch(error) { fs.rmSync(project,{recursive:true,force:true}); fs.rmSync(home,{recursive:true,force:true}); throw error; }
  const { importTypeScript } = await import('../support/import-typescript.mjs');
  const { ConductorQueueChannel } = await importTypeScript('src/infrastructure/agent-factory/conductor-queue-client.ts');
  const channel = new ConductorQueueChannel(async () => ({ executable: 'python3', args: [path.join(plugin, 'scripts/conductor_queue.py'), 'serve', '--project-root', project, '--conductor-delay', '0.02'], env }));
  const policy = { executor: 'fake', conductor: 'fake', employment: true, approvalPolicy: 'bypass', sandbox: 'read-only', reference: 'browser fixture', work: { model: 'fixture', provider: 'codex' } };
  const settings = { ...policy.work, sandbox: policy.sandbox, approvalPolicy: 'bypass' };
  const post = data => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), data);
  let processed = 0, command = 0;
  async function sync() { await post({ type: 'conductor.snapshot', snapshot: await channel.request('board') }); }
  async function controls() {
    const messages = await page.evaluate(() => window.sentMessages);
    for (const m of messages.slice(processed)) {
      processed++;
      if (m.type !== 'role.pool.control') continue;
      const { type, ...payload } = m;
      await channel.request('ingest', { chatId: m.chatId, class: 'control', payload: { ...payload, commandId: m.commandId || 'role-browser-' + ++command, ...(m.action === 'hire-role' ? { settings } : {}) } });
    }
    await page.waitForTimeout(100); await sync();
  }
  try {
    await channel.request('ensure-chat', { chatId: 'role-browser', policy });
    await page.goto(new URL('/center?lang=ko', page.url()).href);
    await sync();
    const area = page.locator(`#role-pools details[data-id="${configured.subdomainId}"]`);
    await page.locator(`#role-pools details[data-id="${configured.domainId}"] > summary`).click();
    await area.locator(':scope > summary').click();
    for (const profile of ['workLight', 'work', 'verification']) {
      await area.getByLabel('고용 역할').selectOption(profile);
      await area.getByRole('button', { name: '수행자 고용 / 재사용', exact: true }).click();
      await controls();
    }
    await area.getByLabel('고용 역할').selectOption('verification');
    await area.getByRole('button', { name: '수행자 고용 / 재사용', exact: true }).click(); await controls();
    const pools = await channel.request('role-pools');
    const child = pools.areas.find(a => a.id === configured.subdomainId);
    assert.deepEqual(Object.values(child.counts).map(c => c.hired), [1, 1, 1]);
    assert.equal(await area.locator('.role-pool-groups > section').count(), 2);
    const domainRow = page.locator(`#role-pools details[data-id="${configured.domainId}"]`);
    await domainRow.getByLabel('서브도메인 이름').fill('Tools');
    await domainRow.getByRole('button', { name: '서브도메인 추가', exact: true }).click(); await controls();
    assert.ok((await channel.request('role-pools')).catalog.subdomains.some(s => s.name === 'Tools' && s.domainId === configured.domainId));
    await area.getByLabel('새 작업 기본 처리').selectOption('work-verification'); await controls();
    assert.equal((await channel.request('role-pools')).areas.find(a => a.id === configured.subdomainId).processing.route, 'work-verification');
    await area.getByLabel('작업 요청').fill('Draft survives refresh'); await sync();
    assert.equal(await area.getByLabel('작업 요청').inputValue(), 'Draft survives refresh');
    await area.getByLabel('이번 요청 처리').selectOption('work');
    await area.getByLabel('작업 역할', { exact: true }).selectOption('workLight');
    await area.getByLabel('작업 요청').fill('작업 1개 0.01초');
    await area.getByRole('button', { name: '작업 접수', exact: true }).click(); await controls();
    await page.waitForTimeout(800); await sync();
    const tasks = (await channel.request('role-pools')).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].workProfile, 'workLight');
    assert.equal(tasks[0].verificationState, 'not-requested');
    assert.equal(tasks[0].workAgentId, child.members.find(m => m.profile === 'workLight').id);
    const artifact = path.resolve(__dirname, '../../../docs/artifact/evidence/parallel-intents-20261012');
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.locator('#role-pools').screenshot({ path: path.join(artifact, 'role-pools-wide.png') });
    await page.setViewportSize({ width: 360, height: 780 });
    const columns = await area.locator('.role-pool-groups').evaluate(n => getComputedStyle(n).gridTemplateColumns);
    assert.equal(columns.split(' ').length, 1);
    await page.locator('#role-pools').screenshot({ path: path.join(artifact, 'role-pools-narrow.png') });
    await page.reload(); await sync();
    assert.equal((await channel.request('role-pools')).areas.find(a => a.id === configured.subdomainId).counts.verification.hired, 1);
    console.log('Canonical role hire/reuse, inherited policy, accepted workLight task, refresh drafts and responsive UI passed.');
  } finally { await channel.request('stop').catch(() => undefined); channel.dispose(); fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
}
module.exports = { checkRolePools };
