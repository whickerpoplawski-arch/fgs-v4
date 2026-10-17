/**
 * Execute 墙钟到期进入同会话收束：停环境工具，一条 Fact 关闭 step，回到 Decide。
 * 不设环境工具次数门。磁盘上已是 deferred 的题仍拒绝 Execute。
 * 时钟用 config.now，不真实 sleep。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apply as applyPlugin } from '../index.js';
import { GraphStore } from '../controller/index.js';
import { makeFakeAgent, makeFakeHost, tmpDir, wireServices } from './helpers.mjs';

const TTL = 10 * 60 * 1000;

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  host.ctx.tools.register({
    name: 'bash',
    description: 'fake bash',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute() {
      return { ok: true, text: 'bash ok' };
    },
  });
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex', executeSessionTtlMs: TTL, ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-a', cwd);
  host.emit('agent/created', { agent });
  const command = host.commands.find((item) => item.name === 'fgs');
  const fgs = (raw, who = agent) => command.handler({ agent: who, rawInput: raw });
  return { host, agent, cwd, fgs };
}

function graphOf(cwd, id) {
  return new GraphStore(path.join(cwd, '.fgs', 'projects', id)).load();
}

function metaOf(cwd, id) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'projects', id, 'meta.json'), 'utf8'));
}

function idsOf(graph) {
  return {
    facts: graph.facts.map((item) => item.id),
    goals: graph.goals.map((item) => item.id),
    steps: graph.steps.map((item) => item.id),
  };
}

async function seedProject(host, agent, fgs, id, brief) {
  const created = fgs(`new ${id} ${brief}`);
  assert.equal(created.kind, 'success', JSON.stringify(created));
  return created;
}

async function openOwned(host, agent, action) {
  const drafted = await host.callTool('fgs_open_step', {
    action, from: ['fact_origin'],
  }, agent);
  assert.equal(drafted.ok, true, drafted.text);
  const opened = await host.callTool('fgs_commit', {}, agent);
  assert.equal(opened.ok, true, opened.text);
  return opened;
}

test('未 deferred 时 open → commit → 环境工具 → 收束仍然放行', async () => {
  const { host, agent, cwd, fgs } = boot();
  await seedProject(host, agent, fgs, 'alpha', 'alpha-brief');
  await openOwned(host, agent, '探测端口');
  const graph = graphOf(cwd, 'alpha');
  assert.equal(graph.steps[0].state, 'open');
  assert.equal(graph.steps[0].owner, 'sess-a');
  assert.notEqual(metaOf(cwd, 'alpha').state, 'deferred');

  const bash = await host.callTool('bash', {}, agent);
  assert.equal(bash.ok, true, bash.text);
  assert.equal(bash.text, 'bash ok');

  const submitted = await host.callTool('fgs_submit_fact', {
    title: '扫到 22', content: '只有 ssh',
  }, agent);
  assert.equal(submitted.ok, true, submitted.text);
  const closed = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(closed.ok, true, closed.text);
  assert.equal(graphOf(cwd, 'alpha').steps[0].state, 'done');
  assert.equal(graphOf(cwd, 'alpha').facts.some((fact) => fact.id === 'fact_001'), true);
  assert.notEqual(metaOf(cwd, 'alpha').state, 'deferred');
  assert.equal(agent.concluded, false);
});

test('TTL 前环境工具有 Fact 草稿上限；到期后停环境工具，commit_step 关 step 并回到 Decide', async () => {
  const clock = { now: 1_700_000_000_000 };
  const { host, agent, cwd, fgs } = boot({ now: () => clock.now });
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /executeEnvCallsBeforeFact:\s*8/);
  await seedProject(host, agent, fgs, 'alpha', 'alpha-brief');
  await openOwned(host, agent, '探测端口');

  for (let i = 0; i < 8; i += 1) {
    const live = await host.callTool('bash', {}, agent);
    assert.equal(live.ok, true, live.text);
    assert.equal(live.text, 'bash ok');
  }
  const capped = await host.callTool('bash', {}, agent);
  assert.equal(capped.ok, false, capped.text);
  assert.match(capped.text, /fgs_submit_fact/);
  assert.doesNotMatch(capped.text, /deferred/);
  assert.equal(agent.concluded, false);
  assert.equal(graphOf(cwd, 'alpha').steps[0].state, 'open');

  const before = idsOf(graphOf(cwd, 'alpha'));
  clock.now += TTL;
  const bash = await host.callTool('bash', {}, agent);
  assert.equal(bash.ok, false, bash.text);
  assert.match(bash.text, /conclude|收束/);
  assert.match(bash.text, /bash/);
  assert.doesNotMatch(bash.text, /deferred/);
  assert.notEqual(bash.text, 'bash ok');
  assert.equal(agent.concluded, false);
  assert.equal(graphOf(cwd, 'alpha').steps[0].state, 'open');
  assert.notEqual(metaOf(cwd, 'alpha').state, 'deferred');

  const preview = await host.callTool('fgs_preview', {}, agent);
  assert.equal(preview.ok, true, preview.text);
  const submitted = await host.callTool('fgs_submit_fact', {
    title: '只看到 ssh', content: '22 端口开放',
  }, agent);
  assert.equal(submitted.ok, true, submitted.text);
  const closed = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(closed.ok, true, closed.text);
  assert.match(closed.text, /Decide/);

  const settled = graphOf(cwd, 'alpha');
  const settledIds = idsOf(settled);
  for (const id of before.facts) assert.ok(settledIds.facts.includes(id));
  for (const id of before.goals) assert.ok(settledIds.goals.includes(id));
  for (const id of before.steps) assert.ok(settledIds.steps.includes(id));
  assert.equal(settled.steps[0].state, 'done');
  assert.equal(settled.steps[0].to, 'fact_001');
  assert.equal(settled.facts.filter((fact) => fact.kind === 'unfinished').length, 0);
  assert.notEqual(metaOf(cwd, 'alpha').state, 'deferred');

  const againBash = await host.callTool('bash', {}, agent);
  assert.equal(againBash.ok, false, againBash.text);
  assert.match(againBash.text, /先 fgs_open_step/);
  assert.doesNotMatch(againBash.text, /deferred/);

  const opened = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '下一刀', from: ['fact_001'] }],
  }, agent);
  assert.equal(opened.ok, true, opened.text);
  assert.equal(graphOf(cwd, 'alpha').steps[1].state, 'open');
  assert.equal(graphOf(cwd, 'alpha').facts.filter((fact) => fact.id !== 'fact_origin').length, 1);
});

test('maxCommitsPerRound 挡不住 TTL 收束的强制关 step', async () => {
  const clock = { now: 1_700_000_000_000 };
  const { host, agent, cwd, fgs } = boot({
    now: () => clock.now,
    maxCommitsPerRound: 0,
  });
  await seedProject(host, agent, fgs, 'alpha', 'alpha-brief');
  await openOwned(host, agent, '探测端口');
  clock.now += TTL;
  const denied = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(denied.ok, false, denied.text);
  host.emit('agent/turn-stopping', { agent });
  const graph = graphOf(cwd, 'alpha');
  assert.equal(graph.steps[0].state, 'done');
  assert.equal(graph.facts.filter((fact) => fact.id !== 'fact_origin').length, 1);
  assert.notEqual(metaOf(cwd, 'alpha').state, 'deferred');
  host.emit('agent/turn-stopping', { agent });
  assert.equal(graphOf(cwd, 'alpha').facts.filter((fact) => fact.id !== 'fact_origin').length, 1);
});

test('磁盘上已是 deferred 的题仍拒绝 Execute 入口与环境工具', async () => {
  const { host, agent, cwd, fgs } = boot();
  await seedProject(host, agent, fgs, 'alpha', 'alpha-brief');
  await openOwned(host, agent, '探测端口');
  const metaPath = path.join(cwd, '.fgs', 'projects', 'alpha', 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.state = 'deferred';
  meta.deferredAt = '2020-01-01T00:00:00.000Z';
  meta.deferredReason = 'execute_timeout';
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  const bash = await host.callTool('bash', {}, agent);
  assert.equal(bash.ok, false, bash.text);
  assert.match(bash.text, /deferred/);
  assert.match(bash.text, /execute_timeout/);
  const opened = await host.callTool('fgs_open_step', {
    action: '继续扫', from: ['fact_origin'],
  }, agent);
  assert.equal(opened.ok, false, opened.text);
  assert.match(opened.text, /deferred/);
  const status = await host.callTool('fgs_status', {}, agent);
  assert.equal(status.ok, true, status.text);
});
