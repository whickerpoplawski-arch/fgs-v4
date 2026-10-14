/**
 * contest driver：fixture 下走 list→start→mkdir→bootstrap→dsh stub，无平台、无 LLM。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { GraphStore } from '../controller/index.js';
import { tmpDir } from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driver = path.join(repoRoot, 'contest', 'driver.py');
const entrypoint = path.join(repoRoot, 'contest', 'entrypoint.sh');

function runPython(args, env) {
  return spawnSync('python3', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function writeFixture(dir, challenges) {
  const file = path.join(dir, 'challenges.json');
  fs.writeFileSync(file, JSON.stringify({ challenges }));
  return file;
}

test('SOLVER_GATEWAY=1 把模型基址改写成 *.tsecbench.gw 且 https→http', () => {
  const script = [
    'import json, os, driver',
    'os.environ["SOLVER_GATEWAY"] = "1"',
    'cases = {',
    '  "deepseek": driver.rewrite_model_base("https://api.deepseek.com/v1"),',
    '  "already": driver.rewrite_model_base("http://api.deepseek.com.tsecbench.gw/v1"),',
    '  "port": driver.rewrite_model_base("https://api.deepseek.com:8443/v1?x=1"),',
    '  "off": None,',
    '}',
    'os.environ["SOLVER_GATEWAY"] = "0"',
    'cases["off"] = driver.rewrite_model_base("https://api.deepseek.com/v1")',
    'print(json.dumps(cases))',
  ].join('\n');
  const result = runPython(['-c', script], { PYTHONPATH: path.join(repoRoot, 'contest') });
  assert.equal(result.status, 0, result.stderr);
  const cases = JSON.parse(result.stdout);
  assert.equal(cases.deepseek, 'http://api.deepseek.com.tsecbench.gw/v1');
  assert.equal(cases.already, 'http://api.deepseek.com.tsecbench.gw/v1');
  assert.equal(cases.port, 'http://api.deepseek.com.tsecbench.gw:8443/v1?x=1');
  assert.equal(cases.off, 'https://api.deepseek.com/v1');
});

test('fixture 队列预种后图存在，第二次 driver 不改 graph.yaml', () => {
  const scratch = tmpDir('fgs-contest-');
  const workdir = path.join(scratch, 'work');
  const fixture = writeFixture(scratch, [
    {
      unique_code: 'A-10',
      description: '示例题面：找 flag',
      is_completed: false,
      container_addr: ['http://10.0.0.8:8080'],
    },
    {
      unique_code: 'done-1',
      description: '已通关',
      is_completed: true,
      container_addr: ['http://10.0.0.9'],
    },
  ]);
  const env = {
    BENCHMARK_TOKEN: 'test-token',
    BENCHMARK_BASE_URL: 'http://benchmark.invalid',
    CONTEST_FIXTURE: fixture,
    CONTEST_WORKDIR: workdir,
    CONTEST_DSH_LAUNCH: '0',
    SOLVER_GATEWAY: '1',
    OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
    CONTEST_MAX_CONCURRENCY: '3',
  };
  const first = runPython([driver], env);
  assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
  assert.match(first.stderr, /rewrote OPENAI_BASE_URL/);
  assert.match(first.stderr, /max concurrency/);
  assert.equal(fs.existsSync(path.join(workdir, 'done-1')), false);

  const cwd = path.join(workdir, 'a-10');
  const graphPath = path.join(cwd, '.fgs', 'projects', 'a-10', 'graph.yaml');
  const index = JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'competition.json'), 'utf8'));
  assert.equal(index.activeProblemId, 'a-10');
  const graph = new GraphStore(path.join(cwd, '.fgs', 'projects', 'a-10')).load();
  assert.equal(graph.facts[0].id, 'fact_origin');
  assert.equal(graph.goals[0].id, 'goal_final');
  assert.match(graph.goals[0].criterion, /correct=true/);
  const origin = JSON.parse(graph.facts[0].content);
  assert.equal(origin.target, 'http://10.0.0.8:8080');
  assert.match(origin.brief, /示例题面/);
  assert.match(origin.brief, /container_addr: http:\/\/10\.0\.0\.8:8080/);
  const launch = JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'dsh-launch.json'), 'utf8'));
  assert.equal(launch.stub, true);
  assert.equal(launch.provider, 'openai-completions');
  assert.match(fs.readFileSync(path.join(cwd, 'prompt.txt'), 'utf8'), /不要调用 fgs_project/);

  const bytes = fs.readFileSync(graphPath);
  const second = spawnSync(entrypoint, [], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /already-seeded/);
  assert.deepEqual(fs.readFileSync(graphPath), bytes);
});

test('start 没有 container_addr 时不写 .fgs，entrypoint 缺 token/base 则失败', () => {
  const scratch = tmpDir('fgs-contest-empty-');
  const workdir = path.join(scratch, 'work');
  const fixture = writeFixture(scratch, [
    {
      unique_code: 'no-addr',
      description: 'start 失败',
      is_completed: false,
      container_addr: [],
    },
  ]);
  const failed = runPython([driver], {
    BENCHMARK_TOKEN: 'test-token',
    BENCHMARK_BASE_URL: 'http://benchmark.invalid',
    CONTEST_FIXTURE: fixture,
    CONTEST_WORKDIR: workdir,
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /container_addr/);
  assert.equal(fs.existsSync(path.join(workdir, 'no-addr', '.fgs')), false);

  const noToken = spawnSync(entrypoint, [], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, BENCHMARK_TOKEN: '', BENCHMARK_BASE_URL: 'http://benchmark.invalid' },
  });
  assert.notEqual(noToken.status, 0);
  assert.match(noToken.stderr, /BENCHMARK_TOKEN/);

  const noBase = spawnSync(entrypoint, [], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, BENCHMARK_TOKEN: 't', BENCHMARK_BASE_URL: '' },
  });
  assert.notEqual(noBase.status, 0);
  assert.match(noBase.stderr, /BENCHMARK_BASE_URL/);
});
