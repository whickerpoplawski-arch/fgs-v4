/**
 * Baseline 轻约束：注入文案、环检测、总开关。不启动 dsh。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tmpDir } from './helpers.mjs';
import {
  L1_CONTRACT,
  L2_BREAK,
  L3_ANCHORS,
  PLUGIN_ID,
  applyLightConstraint,
  buildInjectText,
  createPluginUserMessage,
  fingerprintText,
  observeFingerprint,
  readLightConstraintConfig,
  shouldBreak,
  similarFingerprints,
} from '../contest-benchmark-tools/light_constraint.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeBus() {
  const events = new Map();
  return {
    tools: {
      register() {
        return () => {};
      },
    },
    on(name, listener) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(listener);
      return () => {
        const list = events.get(name) || [];
        const i = list.indexOf(listener);
        if (i >= 0) list.splice(i, 1);
      };
    },
    events,
    async emit(name, payload, next) {
      const listeners = events.get(name) || [];
      let decision;
      for (const listener of listeners) {
        if (name === 'tools/post-execute') {
          decision = await listener(payload, { ok: true }, next);
        } else {
          decision = await listener(payload, next);
        }
      }
      return decision;
    },
  };
}

function fakeAgent(cwd, assistantTexts = []) {
  return {
    cwd,
    session: {
      header: { cwd },
      events: assistantTexts.map((text) => ({
        type: 'assistant/message',
        data: { content: [{ type: 'text', text }] },
      })),
    },
  };
}

async function preStep(ctx, agent, messages = []) {
  return ctx.emit('agent/pre-step', { agent, messages }, async () => ({
    kind: 'enter',
    messages,
  }));
}

test('env kill switch defaults on and CONTEST_LIGHT_CONSTRAINT=0 disables all layers', () => {
  assert.deepEqual(readLightConstraintConfig({}), {
    enabled: true,
    notes: true,
    loopBreak: true,
    loopN: 3,
    anchors: true,
  });
  const off = readLightConstraintConfig({ CONTEST_LIGHT_CONSTRAINT: '0' });
  assert.equal(off.enabled, false);
  assert.equal(off.notes, false);
  assert.equal(off.loopBreak, false);
  assert.equal(off.anchors, false);
  const partial = readLightConstraintConfig({
    CONTEST_LIGHT_CONSTRAINT: '1',
    CONTEST_LIGHT_NOTES: '0',
    CONTEST_LIGHT_LOOP_BREAK: 'off',
    CONTEST_LIGHT_ANCHORS: 'false',
    CONTEST_LIGHT_LOOP_N: '5',
  });
  assert.equal(partial.enabled, true);
  assert.equal(partial.notes, false);
  assert.equal(partial.loopBreak, false);
  assert.equal(partial.anchors, false);
  assert.equal(partial.loopN, 5);
});

test('buildInjectText carries 轻约束 / ≤2 and optional 环打断 / 三锚', () => {
  const l1 = buildInjectText({ notes: true, loopBreak: false, anchors: false });
  assert.match(l1, /【轻约束】/);
  assert.match(l1, /≤2/);
  assert.doesNotMatch(l1, /【环打断】/);
  assert.doesNotMatch(l1, /【锚】/);
  const all = buildInjectText({
    notes: true,
    loopBreak: true,
    anchors: true,
    notesExcerpt: '端口 8000 登录失败',
  });
  assert.match(all, /【轻约束】/);
  assert.match(all, /【环打断】/);
  assert.match(all, /回顾/);
  assert.match(all, /收敛/);
  assert.match(all, /反跑题/);
  assert.match(all, /【NOTES】/);
  assert.match(all, /端口 8000/);
  assert.ok(all.split('\n').length <= 8);
  assert.equal(L1_CONTRACT.includes('≤2'), true);
  assert.equal(L2_BREAK.includes('环打断'), true);
  assert.equal(L3_ANCHORS.includes('反跑题'), true);
});

test('L1 is a one-line operational ≤2 then tool_call contract without language bans', () => {
  assert.equal(L1_CONTRACT.includes('\n'), false);
  assert.match(L1_CONTRACT, /≤2/);
  assert.match(L1_CONTRACT, /tool_call/);
  assert.match(L1_CONTRACT, /无文字/);
  assert.match(L1_CONTRACT, /本题结束|收尾/);
  assert.doesNotMatch(L1_CONTRACT, /默认中文/);
  assert.doesNotMatch(L1_CONTRACT, /I'll start/);
  assert.doesNotMatch(L1_CONTRACT, /Let me/);
  const l1 = buildInjectText({ notes: true, loopBreak: false, anchors: false });
  assert.doesNotMatch(l1, /默认中文/);
  assert.doesNotMatch(l1, /I'll start/);
  assert.doesNotMatch(l1, /Let me/);
  assert.equal(L2_BREAK, '【环打断】你已连续重复相近步骤。换攻击面或脚本化；用 record_observation 记已排除路径。');
  assert.equal(L3_ANCHORS, '【锚】回顾：上一工具结果一句话。收敛：本步唯一动作。反跑题：不写讲义。');
});

test('loop detector trips after N similar fingerprints', () => {
  const n = 3;
  const fp = fingerprintText('curl http://10.0.0.8/login -d a=1', 't');
  let history = [];
  for (let i = 0; i < n - 1; i += 1) {
    const observed = observeFingerprint(history, fp, n);
    history = observed.history;
    assert.equal(observed.looping, false, `should not break at ${i + 1}`);
  }
  const tripped = observeFingerprint(history, fp, n);
  assert.equal(tripped.looping, true);
  assert.equal(shouldBreak(tripped.history, n), true);
  const changed = observeFingerprint(tripped.history, fingerprintText('nmap -sV 10.0.0.8', 't'), n);
  assert.equal(changed.looping, false);
});

test('similarFingerprints treats near-duplicate assistant prose as a loop', () => {
  const a = fingerprintText('I will curl the login form again to check the cookie.', 't');
  const b = fingerprintText('I will curl the login form again to check cookies.', 't');
  assert.equal(similarFingerprints(a, b), true);
  const c = fingerprintText('switching to sqlmap on the search endpoint', 't');
  assert.equal(similarFingerprints(a, c), false);
});

test('CONTEST_LIGHT_CONSTRAINT=0 does not register pre-step inject', async () => {
  const ctx = makeBus();
  const dispose = applyLightConstraint(ctx, { env: { CONTEST_LIGHT_CONSTRAINT: '0' } });
  assert.equal(ctx.events.size, 0);
  const cwd = tmpDir('light-off-');
  const decision = await preStep(ctx, fakeAgent(cwd));
  assert.equal(decision, undefined);
  dispose();
});

test('pre-step injects a plugin-sourced 轻约束 message into the enter batch', async () => {
  const ctx = makeBus();
  applyLightConstraint(ctx, {
    env: {
      CONTEST_LIGHT_CONSTRAINT: '1',
      CONTEST_LIGHT_NOTES: '1',
      CONTEST_LIGHT_LOOP_BREAK: '0',
      CONTEST_LIGHT_ANCHORS: '1',
    },
  });
  const cwd = tmpDir('light-on-');
  fs.writeFileSync(path.join(cwd, 'NOTES.md'), '上一轮：8000 是登录页\n');
  const claimed = [{
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text: '开始解题' }],
    source: { kind: 'user' },
  }];
  const decision = await preStep(ctx, fakeAgent(cwd), claimed);
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 2);
  const injected = decision.messages[1];
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, 'plugin');
  assert.equal(injected.source.plugin, PLUGIN_ID);
  const text = injected.content.map((block) => block.text).join('');
  assert.match(text, /【轻约束】/);
  assert.match(text, /≤2/);
  assert.match(text, /【锚】/);
  assert.match(text, /【NOTES】/);
  assert.match(text, /8000 是登录页/);
  assert.doesNotMatch(text, /【环打断】/);
});

test('N similar assistant texts make the next inject include 环打断', async () => {
  const ctx = makeBus();
  applyLightConstraint(ctx, {
    env: {
      CONTEST_LIGHT_CONSTRAINT: '1',
      CONTEST_LIGHT_NOTES: '1',
      CONTEST_LIGHT_LOOP_BREAK: '1',
      CONTEST_LIGHT_LOOP_N: '3',
      CONTEST_LIGHT_ANCHORS: '0',
    },
  });
  const cwd = tmpDir('light-loop-');
  const same = 'curl -v http://10.0.0.8/login again';
  const texts = [];
  let sawBreak = false;
  for (let step = 0; step < 4; step += 1) {
    const agent = fakeAgent(cwd, texts);
    const decision = await preStep(ctx, agent);
    const injected = decision.messages.at(-1);
    const text = injected?.content?.map((block) => block.text).join('') || '';
    if (text.includes('【环打断】')) {
      sawBreak = true;
      assert.match(text, /换攻击面/);
    }
    texts.push(same);
  }
  assert.equal(sawBreak, true);
  const observations = fs.readFileSync(path.join(cwd, '.fgs', 'observations.jsonl'), 'utf8');
  assert.match(observations, /环打断/);
  const state = JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'light_constraint_state.json'), 'utf8'));
  assert.ok(state.assistant.length >= 3);
});

test('repeated bash fingerprints arm 环打断 on the next pre-step', async () => {
  const ctx = makeBus();
  applyLightConstraint(ctx, {
    env: {
      CONTEST_LIGHT_CONSTRAINT: '1',
      CONTEST_LIGHT_NOTES: '0',
      CONTEST_LIGHT_LOOP_BREAK: '1',
      CONTEST_LIGHT_LOOP_N: '3',
      CONTEST_LIGHT_ANCHORS: '0',
    },
  });
  const cwd = tmpDir('light-bash-');
  const agent = fakeAgent(cwd);
  for (let i = 0; i < 3; i += 1) {
    await ctx.emit('tools/post-execute', {
      name: 'bash',
      arguments: { command: 'curl -s http://10.0.0.8/login' },
      agent,
      cwd,
    }, async () => ({ kind: 'accept' }));
  }
  const decision = await preStep(ctx, agent);
  const text = decision.messages.at(-1).content.map((block) => block.text).join('');
  assert.match(text, /【环打断】/);
});

test('createPluginUserMessage is sourced as plugin and apply still registers the three tools', async () => {
  const message = createPluginUserMessage(L1_CONTRACT);
  assert.equal(message.source.kind, 'plugin');
  assert.equal(message.source.plugin, PLUGIN_ID);
  assert.match(message.content[0].text, /轻约束/);

  const registered = [];
  const hooks = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition.name);
        return () => {};
      },
    },
    on(event) {
      hooks.push(event);
      return () => {};
    },
  };
  const prev = process.env.CONTEST_LIGHT_CONSTRAINT;
  process.env.CONTEST_LIGHT_CONSTRAINT = '1';
  try {
    const { apply } = await import('../contest-benchmark-tools/index.js');
    const dispose = apply(ctx);
    assert.deepEqual(registered, [
      'benchmark_get_progress',
      'benchmark_submit_flag',
      'record_observation',
    ]);
    assert.ok(hooks.includes('agent/pre-step'));
    assert.ok(hooks.includes('tools/post-execute'));
    dispose();
  } finally {
    if (prev === undefined) delete process.env.CONTEST_LIGHT_CONSTRAINT;
    else process.env.CONTEST_LIGHT_CONSTRAINT = prev;
  }
});

test('baseline profile still has no FGS bundle after light-constraint landing', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(repoRoot, 'profiles', 'contest-baseline', 'package.json'), 'utf8'));
  const contest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'profiles', 'contest', 'package.json'), 'utf8'));
  assert.deepEqual(baseline.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-headless',
    '@local/contest-benchmark-tools',
  ]);
  assert.equal(baseline.dependencies['@local/fgs-deepseek-dsh'], undefined);
  assert.ok(contest.dsh.profile.bundles.includes('@local/contest-benchmark-tools'));
  const patch = fs.readFileSync(path.join(repoRoot, 'profiles', 'contest-baseline', 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /thinking: disabled/);
  assert.doesNotMatch(patch, /dsh-routing-suite|fgs-deepseek-dsh|graded|super-injector/);
});
