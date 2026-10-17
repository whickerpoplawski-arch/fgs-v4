/**
 * P0：Execute 环境调用上限 + 结构化收束；Decide 先认领再开步。
 * 调度（75/125）不在这里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { apply as applyPlugin } from '../index.js';
import { GraphStore } from '../controller/index.js';
import { dropReasonCitesFact } from '../hooks/validate_write.js';
import {
  ensureActiveProject,
  makeFakeAgent,
  makeFakeHost,
  projectGraphPath,
  tmpDir,
  wireServices,
} from './helpers.mjs';

const FORBIDDEN = ['没有未提交草稿', '未经模型收束', '以平台侧进度为准'];

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
  applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex', ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-a', cwd);
  host.emit('agent/created', { agent });
  return { host, agent, cwd };
}

async function seed(host, agent) {
  const created = ensureActiveProject(host, agent, 'alpha');
  assert.equal(created.kind, 'success', JSON.stringify(created));
  const seeded = await host.callTool('fgs_seed', {
    brief: '拿 flag',
    target: 'http://10.0.0.8',
  }, agent);
  assert.equal(seeded.ok, true, seeded.text);
}

function graphOf(cwd) {
  return new GraphStore(projectGraphPath(cwd, 'alpha').replace(/\/graph\.yaml$/, '')).load();
}

function extraFacts(cwd) {
  return graphOf(cwd).facts.filter((fact) => fact.id !== 'fact_origin');
}

function assertStructured(fact) {
  assert.match(fact.content, /已确认：/);
  assert.match(fact.content, /已试：/);
  assert.match(fact.content, /卡在：/);
  for (const phrase of FORBIDDEN) {
    assert.notEqual(fact.content.trim(), phrase);
    assert.equal(fact.content.includes(phrase), false, phrase);
    assert.equal(String(fact.title).includes(phrase), false, phrase);
  }
}

async function openOwned(host, agent, action = '探测') {
  const opened = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action, from: ['fact_origin'] }],
  }, agent);
  assert.equal(opened.ok, true, opened.text);
  return opened;
}

function emitTerm() {
  const sentinel = () => {};
  process.on('SIGTERM', sentinel);
  try {
    process.emit('SIGTERM');
  } finally {
    process.removeListener('SIGTERM', sentinel);
  }
}

test('默认 executeEnvCallsBeforeFact 为 8；超过且没有草稿则拒绝 bash', async () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /executeEnvCallsBeforeFact:\s*8/);
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  host.ctx.setTurn(1);
  await openOwned(host, agent, '扫端口');
  host.ctx.setTurn(2);
  for (let i = 0; i < 8; i += 1) {
    const hit = await host.callTool('bash', { i }, agent);
    assert.equal(hit.ok, true, `第 ${i + 1} 次应放行: ${hit.text}`);
  }
  const blocked = await host.callTool('bash', {}, agent);
  assert.equal(blocked.ok, false, blocked.text);
  assert.match(blocked.text, /fgs_submit_fact/);
  assert.match(blocked.text, /conclude|收束/);
  assert.equal(extraFacts(cwd).length, 0);

  host.emit('agent/turn-stopping', { agent });
  host.emit('agent/turn-stopping', { agent });
  const facts = extraFacts(cwd);
  assert.equal(facts.length, 1);
  assertStructured(facts[0]);
  assert.equal(graphOf(cwd).steps[0].state, 'done');
  assert.equal(graphOf(cwd).steps[0].to, facts[0].id);
});

test('有草稿后环境计数归零；收束保留草稿且第二次不追加 Fact', async () => {
  const { host, agent, cwd } = boot({ executeEnvCallsBeforeFact: 2 });
  await seed(host, agent);
  host.ctx.setTurn(1);
  await openOwned(host, agent);
  host.ctx.setTurn(2);
  assert.equal((await host.callTool('bash', {}, agent)).ok, true);
  assert.equal((await host.callTool('bash', {}, agent)).ok, true);
  const blocked = await host.callTool('bash', {}, agent);
  assert.equal(blocked.ok, false);
  const drafted = await host.callTool('fgs_submit_fact', {
    title: '扫到 22',
    content: 'ssh 开着',
  }, agent);
  assert.equal(drafted.ok, true, drafted.text);
  const again = await host.callTool('bash', {}, agent);
  assert.equal(again.ok, true, again.text);

  host.emit('agent/turn-stopping', { agent });
  host.emit('agent/turn-stopping', { agent });
  const facts = extraFacts(cwd);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].title, '扫到 22');
  assert.match(facts[0].content, /ssh 开着/);
  assert.equal(graphOf(cwd).steps[0].state, 'done');
});

test('SIGTERM 没有草稿时写一条三栏 Fact 并关 step；有草稿则原样保住', async () => {
  const bare = boot();
  await seed(bare.host, bare.agent);
  bare.host.ctx.setTurn(3);
  await openOwned(bare.host, bare.agent, '探路');
  emitTerm();
  emitTerm();
  const bareFacts = extraFacts(bare.cwd);
  assert.equal(bareFacts.length, 1);
  assert.match(bareFacts[0].title, /中断/);
  assertStructured(bareFacts[0]);
  assert.doesNotMatch(bareFacts[0].title + bareFacts[0].content, /无有效产出/);
  assert.equal(graphOf(bare.cwd).steps[0].state, 'done');

  const kept = boot();
  await seed(kept.host, kept.agent);
  kept.host.ctx.setTurn(4);
  await openOwned(kept.host, kept.agent, '探路');
  const drafted = await kept.host.callTool('fgs_submit_fact', {
    title: '已确认：/admin 需要口令',
    content: '无参返回 403',
  }, kept.agent);
  assert.equal(drafted.ok, true, drafted.text);
  emitTerm();
  emitTerm();
  const keptFacts = extraFacts(kept.cwd);
  assert.equal(keptFacts.length, 1);
  assert.equal(keptFacts[0].title, '已确认：/admin 需要口令');
  assert.match(keptFacts[0].content, /无参返回 403/);
  assert.doesNotMatch(keptFacts[0].content, /中断/);
  assert.equal(graphOf(kept.cwd).steps[0].state, 'done');
});

test('TTL conclude 落一条三栏 Fact，第二次 turn-stopping 不追加', async () => {
  const clock = { now: 1_700_000_000_000 };
  const ttl = 10 * 60 * 1000;
  const { host, agent, cwd } = boot({
    executeSessionTtlMs: ttl,
    now: () => clock.now,
  });
  await seed(host, agent);
  await openOwned(host, agent, '限时探查');
  clock.now += ttl;
  const denied = await host.callTool('fgs_satisfy_goal', {
    goalId: 'goal_final', reason: '还没', satisfiedBy: ['fact_origin'],
  }, agent);
  assert.equal(denied.ok, false, denied.text);
  assert.match(denied.text, /Execute|satisfy_goal|收束/);
  host.emit('agent/turn-stopping', { agent });
  host.emit('agent/turn-stopping', { agent });
  const facts = extraFacts(cwd);
  assert.equal(facts.length, 1);
  assert.match(facts[0].title, /收束/);
  assert.match(facts[0].content, /探索时限到了/);
  assertStructured(facts[0]);
  assert.equal(graphOf(cwd).steps[0].state, 'done');
});

test('补图后有未认领 open step 时不能再 open；claim 后进入 Execute', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  const first = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '记下 baseline', from: ['fact_origin'] }],
  }, agent);
  assert.equal(first.ok, true, first.text);
  assert.equal((await host.callTool('fgs_submit_fact', {
    title: '已验证: sqli on /login',
    content: 'OBS_SQLI_LOGIN',
  }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);

  const parked = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '沿已验证继续', from: ['fact_001'] }],
    claimOpened: false,
  }, agent);
  assert.equal(parked.ok, true, parked.text);
  const open = graphOf(cwd).steps.filter((step) => step.state === 'open');
  assert.equal(open.length, 1);
  assert.equal(open[0].owner ?? null, null);
  assert.ok(extraFacts(cwd).length >= 1);

  const viaTool = await host.callTool('fgs_open_step', {
    action: '再开一条', from: ['fact_001'],
  }, agent);
  assert.equal(viaTool.ok, false, viaTool.text);
  assert.match(viaTool.text, /fgs_claim_step/);
  const viaBatch = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '再开一条', from: ['fact_001'] }],
  }, agent);
  assert.equal(viaBatch.ok, false, viaBatch.text);
  assert.match(viaBatch.text, /fgs_claim_step/);
  assert.equal(graphOf(cwd).steps.filter((step) => step.state === 'open').length, 1);

  const claimed = await host.callTool('fgs_claim_step', { stepId: open[0].id }, agent);
  assert.equal(claimed.ok, true, claimed.text);
  const status = await host.callTool('fgs_status', {}, agent);
  assert.match(status.text, /Execute/);
  assert.equal(graphOf(cwd).steps.find((step) => step.id === open[0].id).owner, 'sess-a');
});

test('仅有 fact_origin、没有 open step 时仍可开一条指向 goal_final 的 step', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  assert.equal(graphOf(cwd).facts.map((fact) => fact.id).join(','), 'fact_origin');
  assert.equal(graphOf(cwd).steps.length, 0);
  const drafted = await host.callTool('fgs_open_step', {
    action: '尝试直接满足 goal_final',
    from: ['fact_origin'],
  }, agent);
  assert.equal(drafted.ok, true, drafted.text);
  const committed = await host.callTool('fgs_commit', {}, agent);
  assert.equal(committed.ok, true, committed.text);
  const steps = graphOf(cwd).steps;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].state, 'open');
  assert.match(steps[0].action, /goal_final/);
  assert.equal(steps[0].owner, 'sess-a');
});

test('别人持有的 step 不挡住 open；未认领的才要求先 claim', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  const bob = makeFakeAgent('sess-b', cwd);
  host.emit('agent/created', { agent: bob });
  const theirs = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'bob 的步', from: ['fact_origin'] }],
  }, bob);
  assert.equal(theirs.ok, true, theirs.text);
  const mine = await host.callTool('fgs_open_step', {
    action: '我另开一条', from: ['fact_origin'],
  }, agent);
  assert.equal(mine.ok, true, mine.text);
});

test('drop_step 的 reason 必须点名 fact id，artifact_001 不算', async () => {
  assert.equal(dropReasonCitesFact('见 fact_origin'), true);
  assert.equal(dropReasonCitesFact('因为 fact_012 已排除'), true);
  assert.equal(dropReasonCitesFact('死胡同'), false);
  assert.equal(dropReasonCitesFact('artifact_001 看起来像'), false);

  const { host, agent } = boot();
  await seed(host, agent);
  const empty = await host.callTool('fgs_commit', {}, agent);
  assert.equal(empty.ok, false);
  assert.match(empty.text, /草稿为空/);
  await openOwned(host, agent);
  const bare = await host.callTool('fgs_drop_step', { stepId: 'step_001', reason: '死胡同' }, agent);
  assert.equal(bare.ok, false, bare.text);
  assert.match(bare.text, /fact_origin|fact_NNN/);
  const tricky = await host.callTool('fgs_drop_step', {
    stepId: 'step_001', reason: 'artifact_001',
  }, agent);
  assert.equal(tricky.ok, false, tricky.text);
  const cited = await host.callTool('fgs_drop_step', {
    stepId: 'step_001', reason: '方向失效，见 fact_origin',
  }, agent);
  assert.equal(cited.ok, true, cited.text);
});

test('Decide 提示只有认领优先和 drop 引用两句，不把 Bootstrap 贴到已补图', () => {
  const decide = fs.readFileSync(new URL('../prompts/decide.system.md', import.meta.url), 'utf8');
  assert.match(decide, /先 fgs_claim_step，不要 fgs_open_step/);
  assert.match(decide, /reason 必须包含 fact_origin 或 fact_NNN/);
  assert.match(decide, /仅有 fact_origin\(冷启动\)/);
  assert.doesNotMatch(decide, /SQL|上传|内网|webshell/i);
  const lines = decide.split('\n').filter((line, i, all) => line !== '' || i < all.length - 1);
  assert.ok(lines.length <= 24, `decide.system.md 行数 ${lines.length}`);
});
