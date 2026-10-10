const assert = require('node:assert/strict');

async function checkTaskStripRemoval(page) {
  const post = message => page.evaluate(value => window.postMessage(value, '*'), message);
  const removed = '#run-status, #run-status-toggle, #run-status-title, #run-status-agents, #run-details, #run-stage-list, #workflow-history, #task-history';

  assert.equal(await page.locator(removed).count(), 0, 'Main chat has no task status or history strip while idle');
  assert.equal(await page.locator('.composer-topline').evaluate(element => element.getBoundingClientRect().height), 0,
    'The removed idle strip leaves no composer gap');

  await post({ type: 'host.initialize', panelId: 'task-strip-removal', agentId: 'main-task-strip-removal', role: 'main', runtimeAvailable: true });
  await post({ type: 'agents.list', agents: [{ agentId: 'worker-task-strip-removal', runId: 'run-task-strip-removal', role: 'work', status: 'running' }], workflows: [{
    loopId: 'loop-task-strip-removal', workAgentId: 'worker-task-strip-removal', status: 'active', taskMode: 'work', workProfile: 'work',
    workflow: { id: 'flow-task-strip-removal', title: 'Removed chat strip fixture', tasks: [{ id: 'task-strip-removal', title: 'Still recorded in the control center', workStatus: 'running', workRunId: 'run-task-strip-removal' }] }
  }] });
  assert.equal(await page.locator(removed).count(), 0, 'Main chat keeps the strip absent while work is running');
  assert.equal(await page.locator('.composer-topline').evaluate(element => element.getBoundingClientRect().height), 0,
    'The running workflow does not recreate a composer gap');
}

module.exports = { checkTaskStripRemoval };
