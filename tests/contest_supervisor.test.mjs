/**
 * Contest supervisor：reap / retire / 双护栏 / 开关。无平台、无 LLM。
 * 决策在 contest/supervisor/core.py；driver 是唯一托管调度器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { tmpDir } from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driver = path.join(repoRoot, 'contest', 'driver.py');
const entrypoint = path.join(repoRoot, 'contest', 'entrypoint.sh');
const supervisorDir = path.join(repoRoot, 'contest', 'supervisor');
const reapSh = path.join(supervisorDir, 'reap.sh');
const retireSh = path.join(supervisorDir, 'retire.sh');
const autosupSh = path.join(supervisorDir, 'autosup.sh');
const cli = path.join(supervisorDir, 'cli.py');

function run(bin, args, env) {
  return spawnSync(bin, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
}

function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    'RUN',
    'CONTEST_FIXTURE',
    'CONTEST_WORKDIR',
    'CONTEST_WORKER_CMD',
    'CONTEST_SUPERVISOR',
    'CONTEST_SUPERVISOR_NOW',
    'CONTEST_SUPERVISOR_ONCE',
    'CONTEST_SUPERVISOR_INTERVAL',
    'CONTEST_HTTP_TIMEOUT',
    'CONTEST_RETIRE_GRACE',
    'CONTEST_RETIRE_GRACE_SOLVED',
    'CONTEST_MAX_ACTIVE',
    'CONTEST_MAX_CONCURRENCY',
    'CONTEST_FGS_MODE',
    'CONTEST_FGS_AFTER_SEC',
    'CONTEST_FGS_RETRY_LAST',
    'CONTEST_FGS_MAX_ACTIVE',
    'CONTEST_FGS_MAX_RETRIES',
    'CONTEST_FAIL_ON_BUDGET',
    'GRACE',
    'GRACE_SOLVED',
  ]) {
    delete env[key];
  }
  env.BENCHMARK_TOKEN = 'test-token';
  env.BENCHMARK_BASE_URL = 'http://benchmark.invalid';
  env.CONTEST_DSH_LAUNCH = '0';
  return { ...env, ...extra };
}

function writeFixture(dir, challenges) {
  const file = path.join(dir, 'challenges.json');
  fs.writeFileSync(file, JSON.stringify({ challenges }));
  return file;
}

function writeMeta(workerDir, problemId, meta) {
  const dir = path.join(workerDir, '.fgs', 'projects', problemId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
}

function startSleep() {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  return child;
}

function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function exited(child, timeoutMs = 1500) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function closeNotes(run) {
  const file = path.join(run, 'monitor', 'closes.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function py(code, env = {}) {
  return run('python3', ['-c', code], {
    ...baseEnv(),
    PYTHONPATH: path.join(repoRoot, 'contest'),
    ...env,
  });
}

function writeDeferredSleeper(dir, deferredAt) {
  const script = path.join(dir, 'worker.sh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(script, `#!/bin/sh
id=$(basename "$PWD")
mkdir -p ".fgs/projects/$id"
printf '%s\\n' '{"state":"deferred","deferredAt":"${deferredAt}"}' > ".fgs/projects/$id/meta.json"
exec sleep 120
`);
  fs.chmodSync(script, 0o755);
  return script;
}

function killPid(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

function runUntilMatch(bin, args, env, pattern, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: repoRoot,
      env: { ...env, PYTHONUNBUFFERED: '1' },
    });
    let stdout = '';
    let stderr = '';
    let matched = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (!matched && pattern.test(stderr)) {
        matched = true;
        clearTimeout(timer);
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const result = { stdout, stderr, code, signal };
      if (matched) resolve(result);
      else {
        reject(new Error(
          `exited ${code}/${signal} before ${pattern}\nstderr:\n${stderr}\nstdout:\n${stdout}`,
        ));
      }
    });
  });
}

test('reap：死 pid / 无 pid 且容器 available → close 一次；存活 pid 不 close', () => {
  const probed = py(`
import json
from supervisor.core import plan_reap
challenges = [{"unique_code": "a-1", "container_status": "available"}]
dead = [{"code": "a-1", "alive": False, "pid": None, "launched": True, "meta_state": "deferred"}]
living = [{"code": "a-1", "alive": True, "pid": 1, "launched": True}]
idle = [{"unique_code": "a-1", "container_status": "stopped"}]
print(json.dumps({
  "dead": plan_reap(challenges, dead),
  "missing": plan_reap(challenges, []),
  "alive": plan_reap(challenges, living),
  "again_active": plan_reap(challenges, dead, already_closed=["a-1"]),
  "again_idle": plan_reap(idle, dead, already_closed=["a-1"]),
  "alive_closed": plan_reap(challenges, living, already_closed=["a-1"]),
}))
`);
  assert.equal(probed.status, 0, probed.stderr);
  const body = JSON.parse(probed.stdout);
  assert.deepEqual(body.dead, [{ op: 'close', code: 'a-1' }]);
  assert.deepEqual(body.missing, [{ op: 'close', code: 'a-1' }]);
  assert.deepEqual(body.alive, [{ op: 'keep', code: 'a-1' }]);
  assert.deepEqual(body.again_active, [{ op: 'close', code: 'a-1', retry: true }]);
  assert.deepEqual(body.again_idle, []);
  assert.deepEqual(body.alive_closed, [{ op: 'keep', code: 'a-1' }]);

  const scratch = tmpDir('fgs-reap-');
  const runDir = path.join(scratch, 'run');
  const worker = path.join(runDir, 'workers', 'w1_a-1');
  fs.mkdirSync(worker, { recursive: true });
  fs.writeFileSync(path.join(worker, 'pid'), '999999\n');
  const fixture = writeFixture(scratch, [
    { unique_code: 'a-1', container_status: 'available', is_completed: false },
  ]);
  const env = baseEnv({ RUN: runDir, CONTEST_FIXTURE: fixture });
  const first = run(reapSh, [], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /close a-1/);
  assert.equal(closeNotes(runDir).length, 1);

  const second = run(reapSh, [], env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /close a-1 retry \(still active after closed\.txt\)/);
  assert.equal(closeNotes(runDir).length, 2);
  const closedText = fs.readFileSync(path.join(runDir, 'attempted', 'closed.txt'), 'utf8');
  assert.equal(closedText.trim().split('\n').filter((line) => line.trim() === 'a-1').length, 1);

  const idleFixture = writeFixture(scratch, [
    { unique_code: 'a-1', container_status: 'stopped', is_completed: false },
  ]);
  const third = run(reapSh, [], baseEnv({
    RUN: runDir,
    CONTEST_FIXTURE: idleFixture,
  }));
  assert.equal(third.status, 0, third.stderr);
  assert.doesNotMatch(third.stdout, /close a-1/);
  assert.equal(closeNotes(runDir).length, 2);

  const kept = startSleep();
  try {
    const keepDir = path.join(runDir, 'workers', 'w2_a-2');
    fs.mkdirSync(keepDir, { recursive: true });
    fs.writeFileSync(path.join(keepDir, 'pid'), `${kept.pid}\n`);
    fs.appendFileSync(path.join(runDir, 'attempted', 'closed.txt'), 'a-2\n');
    const keepFixture = writeFixture(scratch, [
      { unique_code: 'a-2', container_status: 'available', is_completed: false },
    ]);
    const keepRun = run(reapSh, [], baseEnv({
      RUN: runDir,
      CONTEST_FIXTURE: keepFixture,
    }));
    assert.equal(keepRun.status, 0, keepRun.stderr);
    assert.match(keepRun.stdout, /keep\s+a-2/);
    assert.equal(closeNotes(runDir).some((item) => item.code === 'a-2'), false);
    assert.equal(alive(kept.pid), true);
  } finally {
    stop(kept);
  }
});

test('driver：closed.txt 且仍 ACTIVE、无活 worker 时重关；传输失败不改 closed.txt', () => {
  const scratch = tmpDir('fgs-reap-retry-');
  const runDir = path.join(scratch, 'run');
  fs.mkdirSync(path.join(runDir, 'attempted'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'attempted', 'closed.txt'), 'a-1\n');
  const fixture = writeFixture(scratch, [
    { unique_code: 'a-1', container_status: 'available', is_completed: false, description: 'stuck' },
  ]);
  const probed = py(`
import os
from pathlib import Path
import driver

def fake_sleep(_seconds):
    raise SystemExit(0)

driver.time.sleep = fake_sleep
run = Path(os.environ["RUN"])
work = Path(os.environ["CONTEST_WORKDIR"])
driver.supervisor_loop(run, work, os.environ["BENCHMARK_TOKEN"], os.environ["BENCHMARK_BASE_URL"], os.environ["CONTEST_FIXTURE"])
`, {
    RUN: runDir,
    CONTEST_WORKDIR: path.join(scratch, 'work'),
    CONTEST_FIXTURE: fixture,
    CONTEST_MAX_ACTIVE: '1',
    CONTEST_SUPERVISOR_INTERVAL: '0',
    CONTEST_FGS_MODE: 'after_sec',
    PYTHONUNBUFFERED: '1',
  });
  assert.equal(probed.status, 0, probed.stderr);
  assert.match(probed.stderr, /close a-1 retry \(still active after closed\.txt\)/);
  assert.equal(closeNotes(runDir).filter((item) => item.code === 'a-1').length, 1);
  assert.equal(
    fs.readFileSync(path.join(runDir, 'attempted', 'closed.txt'), 'utf8').trim().split('\n')
      .filter((line) => line.trim() === 'a-1').length,
    1,
  );

  const transport = py(`
import json
from pathlib import Path
from supervisor import core

run = Path(${JSON.stringify(runDir)})
code = "a-1"
before = (run / "attempted" / "closed.txt").read_text(encoding="utf-8")
notes_before = len((run / "monitor" / "closes.jsonl").read_text(encoding="utf-8").splitlines())

def boom(*_args, **_kwargs):
    raise core.PlatformTransportError("timed out")

core.close_challenge = boom
already = core.load_closed_set(run)
try:
    core.perform_close(run, code, base="http://benchmark.invalid", token="t", fixture=None, already=already, retry=True)
    raise SystemExit("transport must raise")
except core.PlatformTransportError as exc:
    print(json.dumps({
        "err": str(exc),
        "closed": (run / "attempted" / "closed.txt").read_text(encoding="utf-8"),
        "before": before,
        "notes": len((run / "monitor" / "closes.jsonl").read_text(encoding="utf-8").splitlines()),
        "notes_before": notes_before,
    }))
`);
  assert.equal(transport.status, 0, transport.stderr);
  const body = JSON.parse(transport.stdout);
  assert.match(body.err, /timed out/);
  assert.equal(body.closed, body.before);
  assert.equal(body.notes, body.notes_before);
});

test('retire：deferred 且超过 GRACE → kill+close；宽限内 hold', async () => {
  const scratch = tmpDir('fgs-retire-');
  const overdue = startSleep();
  const holding = startSleep();
  try {
    const runDir = path.join(scratch, 'overdue');
    const worker = path.join(runDir, 'workers', 'w1_b-2');
    fs.mkdirSync(worker, { recursive: true });
    fs.writeFileSync(path.join(worker, 'pid'), `${overdue.pid}\n`);
    writeMeta(worker, 'b-2', { state: 'deferred', deferredAt: '2000-01-01T00:00:00Z' });
    const fixture = writeFixture(scratch, [
      { unique_code: 'b-2', is_completed: false, container_status: 'available' },
    ]);
    const killed = run(retireSh, [], baseEnv({
      RUN: runDir,
      CONTEST_FIXTURE: fixture,
      CONTEST_SUPERVISOR_NOW: '2026-01-01T00:00:00Z',
      CONTEST_RETIRE_GRACE: '180',
    }));
    assert.equal(killed.status, 0, killed.stderr);
    assert.match(killed.stdout, /retire b-2 \(deferred\)/);
    assert.equal(await exited(overdue), true);
    assert.equal(closeNotes(runDir).filter((item) => item.code === 'b-2').length, 1);
    assert.match(fs.readFileSync(path.join(runDir, 'attempted', 'retired.txt'), 'utf8'), /b-2/);
    assert.equal(fs.existsSync(worker), true);

    const holdRoot = path.join(scratch, 'hold');
    const holdWorker = path.join(holdRoot, 'workers', 'w1_b-3');
    fs.mkdirSync(holdWorker, { recursive: true });
    fs.writeFileSync(path.join(holdWorker, 'pid'), `${holding.pid}\n`);
    writeMeta(holdWorker, 'b-3', { state: 'deferred', deferredAt: '2026-01-01T00:00:00Z' });
    const holdFixture = writeFixture(scratch, [
      { unique_code: 'b-3', is_completed: false },
    ]);
    const held = run(retireSh, [], baseEnv({
      RUN: holdRoot,
      CONTEST_FIXTURE: holdFixture,
      CONTEST_SUPERVISOR_NOW: '2026-01-01T00:00:30Z',
      CONTEST_RETIRE_GRACE: '180',
    }));
    assert.equal(held.status, 0, held.stderr);
    assert.match(held.stdout, /hold b-3/);
    assert.equal(alive(holding.pid), true);
    assert.equal(closeNotes(holdRoot).length, 0);
  } finally {
    stop(overdue);
    stop(holding);
  }
});

test('retire 平台对账：meta running 且 is_completed → 短宽限；已 solved 仍用长宽限', async () => {
  const probed = py(`
import json
from datetime import datetime, timezone
from supervisor.core import plan_retire
now = datetime(2026, 1, 1, 0, 2, 0, tzinfo=timezone.utc)
short = plan_retire(
    [{"code": "c-1", "alive": True, "pid": 5, "dir": "/tmp/w", "meta_state": "running", "meta_at": "2026-01-01T00:00:00Z", "meta_present": True}],
    [{"unique_code": "c-1", "is_completed": True}],
    now=now, grace=180, grace_solved=60,
)
hold = plan_retire(
    [{"code": "c-1", "alive": True, "pid": 5, "dir": "/tmp/w", "meta_state": "running", "meta_at": "2026-01-01T00:01:40Z", "meta_present": True}],
    [{"unique_code": "c-1", "is_completed": True}],
    now=now, grace=180, grace_solved=60,
)
long = plan_retire(
    [{"code": "c-1", "alive": True, "pid": 5, "dir": "/tmp/w", "meta_state": "solved", "meta_at": "2026-01-01T00:00:30Z", "meta_present": True}],
    [{"unique_code": "c-1", "is_completed": True}],
    now=now, grace=180, grace_solved=60,
)
print(json.dumps({"short": short, "hold": hold, "long": long}))
`);
  assert.equal(probed.status, 0, probed.stderr);
  const body = JSON.parse(probed.stdout);
  assert.equal(body.short[0].op, 'retire');
  assert.equal(body.short[0].state, 'solved');
  assert.equal(body.short[0].grace, 60);
  assert.equal(body.short[0].archive, true);
  assert.equal(body.hold[0].op, 'hold');
  assert.equal(body.hold[0].grace, 60);
  assert.equal(body.long[0].op, 'hold');
  assert.equal(body.long[0].grace, 180);

  const scratch = tmpDir('fgs-plat-');
  const child = startSleep();
  try {
    const runDir = path.join(scratch, 'run');
    const worker = path.join(runDir, 'workers', 'w1_c-8');
    fs.mkdirSync(worker, { recursive: true });
    fs.writeFileSync(path.join(worker, 'pid'), `${child.pid}\n`);
    writeMeta(worker, 'c-8', { state: 'running', updatedAt: '2026-01-01T00:00:00Z' });
    const fixture = writeFixture(scratch, [
      { unique_code: 'c-8', is_completed: true, container_status: 'available' },
    ]);
    const result = run(retireSh, [], baseEnv({
      RUN: runDir,
      CONTEST_FIXTURE: fixture,
      CONTEST_SUPERVISOR_NOW: '2026-01-01T00:02:00Z',
      CONTEST_RETIRE_GRACE: '180',
      CONTEST_RETIRE_GRACE_SOLVED: '60',
    }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /retire c-8 \(solved\)/);
    assert.equal(await exited(child), true);
    assert.equal(closeNotes(runDir).some((item) => item.code === 'c-8'), true);
    assert.equal(fs.existsSync(path.join(runDir, 'workers', '_done_w1_c-8')), true);
  } finally {
    stop(child);
  }
});

test('双护栏：alive=3 或 active=3 不补派；两者都小于 MAX 才补派', () => {
  const probed = py(`
import json
from supervisor.core import dispatch_budget, count_active
print(json.dumps({
  "alive_full": dispatch_budget(3, 0, 3, 4),
  "active_full": dispatch_budget(0, 3, 3, 4),
  "both_under": dispatch_budget(1, 1, 3, 10),
  "empty_queue": dispatch_budget(0, 0, 3, 0),
  "unknown": count_active([], unknown=True),
}))
`);
  assert.equal(probed.status, 0, probed.stderr);
  const body = JSON.parse(probed.stdout);
  assert.equal(body.alive_full, 0);
  assert.equal(body.active_full, 0);
  assert.equal(body.both_under, 2);
  assert.equal(body.empty_queue, 0);
  assert.equal(body.unknown, 99);

  const scratch = tmpDir('fgs-guard-');

  const fullAlive = path.join(scratch, 'alive');
  const sleeps = [startSleep(), startSleep(), startSleep()];
  try {
    sleeps.forEach((child, index) => {
      const dir = path.join(fullAlive, 'workers', `w${index + 1}_p-${index}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'pid'), `${child.pid}\n`);
    });
    const queue = path.join(fullAlive, 'queue.txt');
    fs.mkdirSync(fullAlive, { recursive: true });
    fs.writeFileSync(queue, 'n-1\tone\nn-2\ttwo\n');
    const fixture = writeFixture(scratch, []);
    const blocked = run(cli, ['tick'], baseEnv({
      RUN: fullAlive,
      CONTEST_FIXTURE: fixture,
      CONTEST_MAX_ACTIVE: '3',
    }));
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.match(blocked.stdout, /budget=0/);
    assert.equal(fs.readFileSync(queue, 'utf8'), 'n-1\tone\nn-2\ttwo\n');
  } finally {
    sleeps.forEach(stop);
  }

  const fullActive = path.join(scratch, 'active');
  fs.mkdirSync(fullActive, { recursive: true });
  const activeQueue = path.join(fullActive, 'queue.txt');
  fs.writeFileSync(activeQueue, 'n-9\tkeep\n');
  const activeFixture = writeFixture(scratch, [
    { unique_code: 's-1', container_status: 'available', is_completed: false },
    { unique_code: 's-2', container_status: 'pending', is_completed: false },
    { unique_code: 's-3', container_status: 'stop_pending', is_completed: false },
  ]);
  const activeBlocked = run(cli, ['tick'], baseEnv({
    RUN: fullActive,
    CONTEST_FIXTURE: activeFixture,
    CONTEST_MAX_ACTIVE: '3',
  }));
  assert.equal(activeBlocked.status, 0, activeBlocked.stderr);
  assert.match(activeBlocked.stdout, /budget=0/);
  assert.equal(fs.readFileSync(activeQueue, 'utf8'), 'n-9\tkeep\n');

  const open = path.join(scratch, 'open');
  fs.mkdirSync(open, { recursive: true });
  const openQueue = path.join(open, 'queue.txt');
  fs.writeFileSync(openQueue, 'd-1\tfirst\nd-2\tsecond\n');
  const openFixture = writeFixture(scratch, [
    { unique_code: 'idle', container_status: 'stopped', is_completed: false },
  ]);
  const dispatched = run(autosupSh, [], baseEnv({
    RUN: open,
    CONTEST_FIXTURE: openFixture,
    CONTEST_MAX_ACTIVE: '3',
    CONTEST_SUPERVISOR_ONCE: '1',
    CONTEST_SUPERVISOR_INTERVAL: '0',
  }));
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.match(dispatched.stdout, /dispatch d-1/);
  assert.match(dispatched.stdout, /dispatch d-2/);
  assert.equal(fs.readFileSync(openQueue, 'utf8'), '');
  assert.equal(fs.existsSync(path.join(open, 'workers', 'w1_d-1')), true);
  assert.equal(fs.existsSync(path.join(open, 'workers', 'w1_d-2')), true);
});

test('与 D-002 正交：meta 已 deferred、进程已死时仍然 close', () => {
  const probed = py(`
import json
from datetime import datetime, timezone
from supervisor.core import plan_reap, plan_retire
workers = [{
    "code": "a-14",
    "alive": False,
    "pid": None,
    "launched": True,
    "meta_state": "deferred",
    "meta_at": "2000-01-01T00:00:00Z",
    "meta_present": True,
}]
challenges = [{"unique_code": "a-14", "container_status": "available", "is_completed": False}]
now = datetime(2026, 1, 1, tzinfo=timezone.utc)
print(json.dumps({
  "reap": plan_reap(challenges, workers),
  "retire": plan_retire(workers, challenges, now=now, grace=180, grace_solved=60),
}))
`);
  assert.equal(probed.status, 0, probed.stderr);
  const body = JSON.parse(probed.stdout);
  assert.deepEqual(body.reap, [{ op: 'close', code: 'a-14' }]);
  assert.deepEqual(body.retire, []);

  const scratch = tmpDir('fgs-d002-');
  const runDir = path.join(scratch, 'run');
  const worker = path.join(runDir, 'workers', 'w1_a-14');
  fs.mkdirSync(worker, { recursive: true });
  fs.writeFileSync(path.join(worker, 'pid'), '999999\n');
  writeMeta(worker, 'a-14', {
    state: 'deferred',
    deferredAt: '2026-01-01T00:00:00Z',
    deferredReason: 'execute_timeout',
  });
  const fixture = writeFixture(scratch, [
    { unique_code: 'a-14', container_status: 'available', is_completed: false },
  ]);
  const result = run(reapSh, [], baseEnv({ RUN: runDir, CONTEST_FIXTURE: fixture }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /close a-14/);
  assert.equal(closeNotes(runDir).length, 1);
});

test('CONTEST_SUPERVISOR=0 不启循环；默认开启且 entrypoint 不拉起 autosup', () => {
  const scratch = tmpDir('fgs-switch-');
  const workdir = path.join(scratch, 'work');
  const fixture = writeFixture(scratch, [
    {
      unique_code: 'a-10',
      description: '示例',
      is_completed: false,
      container_addr: ['http://10.0.0.8:8080'],
    },
  ]);
  const off = run('python3', [driver], baseEnv({
    CONTEST_FIXTURE: fixture,
    CONTEST_WORKDIR: workdir,
    CONTEST_SUPERVISOR: '0',
    RUN: path.join(scratch, 'run-off'),
  }));
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stderr, /supervisor off/);
  assert.doesNotMatch(off.stderr, /supervisor tick/);
  assert.equal(fs.existsSync(path.join(workdir, 'a-10', 'prompt.txt')), true);
  assert.equal(fs.existsSync(path.join(workdir, 'a-10', '.fgs', 'projects', 'a-10', 'graph.yaml')), false);

  const onDir = path.join(scratch, 'work-on');
  const on = run('python3', [driver], baseEnv({
    CONTEST_FIXTURE: fixture,
    CONTEST_WORKDIR: onDir,
    RUN: path.join(scratch, 'run-on'),
  }));
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stderr, /supervisor on/);
  assert.match(on.stderr, /supervisor tick/);
  assert.match(fs.readFileSync(path.join(scratch, 'run-on', 'monitor', 'autosup.log'), 'utf8'), /alive_workers=/);
  assert.equal(fs.existsSync(path.join(scratch, 'run-on', 'monitor', 'scheduler.lock')), false);

  const entry = fs.readFileSync(entrypoint, 'utf8');
  assert.doesNotMatch(entry, /\b(sh|exec|python3|nohup)\b[^\n]*autosup\.sh/);
  const viaEntry = run(entrypoint, [], baseEnv({
    CONTEST_FIXTURE: fixture,
    CONTEST_WORKDIR: path.join(scratch, 'work-entry'),
    CONTEST_SUPERVISOR: '0',
  }));
  assert.equal(viaEntry.status, 0, viaEntry.stderr);
  assert.match(viaEntry.stderr, /supervisor off/);
  assert.doesNotMatch(viaEntry.stderr, /supervisor tick/);

  const ps = spawnSync('ps', ['-ef'], { encoding: 'utf8' });
  assert.doesNotMatch(ps.stdout, /contest\/supervisor\/autosup\.sh/);
});

test('脚本没有 run4 硬编码路径；缺 RUN / BENCHMARK_* 则失败', () => {
  const files = [
    driver,
    entrypoint,
    path.join(repoRoot, 'contest', 'SUPERVISOR.md'),
    ...fs.readdirSync(supervisorDir)
      .map((name) => path.join(supervisorDir, name))
      .filter((file) => fs.statSync(file).isFile()),
  ];
  const blob = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(blob, /tsecbench-run\/run4/);
  assert.doesNotMatch(blob, /\.tsec-run4\.env/);
  assert.doesNotMatch(blob, /\/home\/ubuntu\/ws/);

  const missingRun = run(reapSh, [], baseEnv());
  assert.notEqual(missingRun.status, 0);
  assert.match(missingRun.stderr, /missing RUN/);

  const missingToken = run(retireSh, [], baseEnv({
    RUN: tmpDir('fgs-missing-'),
    BENCHMARK_TOKEN: '',
  }));
  assert.notEqual(missingToken.status, 0);
  assert.match(missingToken.stderr, /BENCHMARK_TOKEN/);
});

test('已有调度锁时 autosup 拒绝第二套补派', () => {
  const scratch = tmpDir('fgs-lock-');
  const holder = startSleep();
  try {
    fs.mkdirSync(path.join(scratch, 'monitor'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'monitor', 'scheduler.lock'), `${holder.pid}\n`);
    fs.writeFileSync(path.join(scratch, 'queue.txt'), 'z-1\tbrief\n');
    const fixture = writeFixture(os.tmpdir(), []);
    const result = run(autosupSh, [], baseEnv({
      RUN: scratch,
      CONTEST_FIXTURE: fixture,
      CONTEST_SUPERVISOR_ONCE: '1',
    }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /second dispatcher/);
    assert.equal(fs.readFileSync(path.join(scratch, 'queue.txt'), 'utf8'), 'z-1\tbrief\n');
    assert.equal(fs.existsSync(path.join(scratch, 'workers', 'w1_z-1')), false);
  } finally {
    stop(holder);
  }
});

test('driver 循环：worker 进程退出后 close 一次；deferred 超宽限则退休', () => {
  const scratch = tmpDir('fgs-driver-sup-');
  const deadWork = path.join(scratch, 'dead');
  const deadFixture = writeFixture(scratch, [
    {
      unique_code: 'gone-1',
      description: '进程马上退出',
      is_completed: false,
      container_addr: ['http://10.2.0.1'],
    },
  ]);
  const dead = run('python3', [driver], baseEnv({
    CONTEST_FIXTURE: deadFixture,
    CONTEST_WORKDIR: deadWork,
    RUN: path.join(scratch, 'dead-run'),
    CONTEST_SUPERVISOR: '1',
    CONTEST_WORKER_CMD: 'true',
    CONTEST_SUPERVISOR_INTERVAL: '0',
    CONTEST_FGS_MODE: 'after_sec',
  }));
  assert.equal(dead.status, 0, dead.stderr);
  const notes = closeNotes(path.join(scratch, 'dead-run'));
  assert.equal(notes.filter((item) => item.code === 'gone-1').length, 1);
  assert.equal(fs.existsSync(path.join(scratch, 'dead-run', 'queue', 'failed')), false);
  const prompt = fs.readFileSync(path.join(deadWork, 'gone-1', 'prompt.txt'), 'utf8');
  assert.match(prompt, /自主渗透 Solver/);
  assert.match(prompt, /benchmark_get_progress/);
  assert.doesNotMatch(prompt, /fgs_project|reap|retire|autosup/);

  const script = path.join(scratch, 'worker.sh');
  fs.writeFileSync(script, `#!/bin/sh
id=$(basename "$PWD")
mkdir -p ".fgs/projects/$id"
printf '%s\\n' '{"state":"deferred","deferredAt":"2000-01-01T00:00:00Z"}' > ".fgs/projects/$id/meta.json"
exec sleep 120
`);
  fs.chmodSync(script, 0o755);
  const liveWork = path.join(scratch, 'live');
  const liveFixture = writeFixture(scratch, [
    {
      unique_code: 'slow-1',
      description: 'deferred 后应退休',
      is_completed: false,
      container_addr: ['http://10.2.0.2'],
    },
  ]);
  const live = run('python3', [driver], baseEnv({
    CONTEST_FIXTURE: liveFixture,
    CONTEST_WORKDIR: liveWork,
    RUN: path.join(scratch, 'live-run'),
    CONTEST_SUPERVISOR: '1',
    CONTEST_WORKER_CMD: script,
    CONTEST_SUPERVISOR_INTERVAL: '0',
    CONTEST_SUPERVISOR_NOW: '2026-01-01T00:00:00Z',
    CONTEST_RETIRE_GRACE: '180',
    CONTEST_FGS_MODE: 'after_sec',
  }));
  assert.equal(live.status, 0, `${live.stderr}\n${live.stdout}`);
  assert.match(live.stderr, /retire slow-1/);
  assert.match(fs.readFileSync(path.join(scratch, 'live-run', 'attempted', 'retired.txt'), 'utf8'), /slow-1/);
  assert.equal(closeNotes(path.join(scratch, 'live-run')).filter((item) => item.code === 'slow-1').length, 1);
  const launch = JSON.parse(fs.readFileSync(path.join(liveWork, 'slow-1', '.fgs', 'dsh-launch.json'), 'utf8'));
  assert.equal(alive(launch.pid), false);
});

test('默认快照：未设 env 时 GRACE=60、GRACE_SOLVED=30、INTERVAL=20；显式覆盖仍优先', () => {
  const probed = py(`
import json
import driver
from supervisor.core import grace_settings
print(json.dumps({
  "grace": list(grace_settings()),
  "interval": driver.supervisor_interval(),
  "enabled": driver.supervisor_enabled(),
}))
`);
  assert.equal(probed.status, 0, probed.stderr);
  const body = JSON.parse(probed.stdout);
  assert.deepEqual(body.grace, [60, 30]);
  assert.equal(body.interval, 20);
  assert.equal(body.enabled, true);

  const overridden = py(`
from supervisor.core import grace_settings
print(grace_settings()[0])
`, { CONTEST_RETIRE_GRACE: '180' });
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(overridden.stdout.trim(), '180');

  const alias = py(`
from supervisor.core import grace_settings
print("%s %s" % grace_settings())
`, { GRACE: '180', GRACE_SOLVED: '45' });
  assert.equal(alias.status, 0, alias.stderr);
  assert.equal(alias.stdout.trim(), '180 45');

  const paused = py(`
import driver
print(driver.supervisor_interval())
`, { CONTEST_SUPERVISOR_INTERVAL: '0' });
  assert.equal(paused.status, 0, paused.stderr);
  assert.equal(paused.stdout.trim(), '0.0');

  const cliText = fs.readFileSync(cli, 'utf8');
  assert.match(cliText, /os\.environ\.get\("CONTEST_SUPERVISOR_INTERVAL", "20"\) or "20"/);
});

test('G1：concludeTurn 被忽略时活 sleep 子进程过默认宽限仍被 driver 退休；10 秒内 hold', async () => {
  // Runner view: the worker is still alive, so a host that ignored concludeTurn
  // did not stop the process. Do not call helpers concludeTurn (that marks concluded).
  const scratch = tmpDir('fgs-g1-');
  const liveScript = writeDeferredSleeper(path.join(scratch, 'bin-live'), '2000-01-01T00:00:00Z');
  const liveWork = path.join(scratch, 'live');
  const liveRun = path.join(scratch, 'live-run');
  const liveFixture = writeFixture(scratch, [
    {
      unique_code: 'g1-live',
      description: '宿主忽略 conclude，进程仍活，过默认宽限应退休',
      is_completed: false,
      container_addr: ['http://10.2.0.3'],
    },
  ]);
  const retired = run('python3', ['-u', driver], baseEnv({
    CONTEST_FIXTURE: liveFixture,
    CONTEST_WORKDIR: liveWork,
    RUN: liveRun,
    CONTEST_SUPERVISOR: '1',
    CONTEST_WORKER_CMD: liveScript,
    CONTEST_SUPERVISOR_INTERVAL: '0',
    CONTEST_SUPERVISOR_NOW: '2026-01-01T00:00:00Z',
    CONTEST_FGS_MODE: 'after_sec',
  }));
  assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
  assert.match(retired.stderr, /retire g1-live/);
  assert.doesNotMatch(retired.stderr, /hold g1-live/);
  assert.match(fs.readFileSync(path.join(liveRun, 'attempted', 'retired.txt'), 'utf8'), /g1-live/);
  assert.equal(closeNotes(liveRun).filter((item) => item.code === 'g1-live').length, 1);
  const liveLaunch = JSON.parse(fs.readFileSync(path.join(liveWork, 'g1-live', '.fgs', 'dsh-launch.json'), 'utf8'));
  assert.equal(alive(liveLaunch.pid), false);

  const holdScript = writeDeferredSleeper(path.join(scratch, 'bin-hold'), '2026-01-01T00:00:00Z');
  const holdWork = path.join(scratch, 'hold');
  const holdRun = path.join(scratch, 'hold-run');
  const holdFix = path.join(scratch, 'hold-fix');
  fs.mkdirSync(holdFix, { recursive: true });
  const holdFixture = writeFixture(holdFix, [
    {
      unique_code: 'g1-hold',
      description: '默认宽限内应 hold，进程继续活',
      is_completed: false,
      container_addr: ['http://10.2.0.4'],
    },
  ]);
  const marker = path.join(holdWork, 'g1-hold', '.fgs', 'dsh-launch.json');
  try {
    const held = await runUntilMatch('python3', ['-u', driver], baseEnv({
      CONTEST_FIXTURE: holdFixture,
      CONTEST_WORKDIR: holdWork,
      RUN: holdRun,
      CONTEST_SUPERVISOR: '1',
      CONTEST_WORKER_CMD: holdScript,
      CONTEST_SUPERVISOR_INTERVAL: '0',
      CONTEST_SUPERVISOR_NOW: '2026-01-01T00:00:10Z',
    }), /hold g1-hold/);
    assert.match(held.stderr, /hold g1-hold/);
    assert.doesNotMatch(held.stderr, /retire g1-hold/);
    const holdLaunch = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(alive(holdLaunch.pid), true);
    assert.equal(closeNotes(holdRun).length, 0);
    assert.equal(fs.existsSync(path.join(holdRun, 'attempted', 'retired.txt')), false);
  } finally {
    if (fs.existsSync(marker)) {
      killPid(JSON.parse(fs.readFileSync(marker, 'utf8')).pid);
    }
  }
});

test('sampler GC 只杀掉不属于存活 worker 的 monitor_sampler', () => {
  const probed = py(`
import json
from supervisor.core import plan_gc_samplers
doomed = plan_gc_samplers(
    ["keep-sid"],
    [
        {"pid": 11, "session_id": "keep-sid"},
        {"pid": 12, "session_id": "orphan"},
        {"pid": 13, "session_id": ""},
    ],
)
print(json.dumps(doomed))
`);
  assert.equal(probed.status, 0, probed.stderr);
  const doomed = JSON.parse(probed.stdout);
  assert.deepEqual(doomed.map((item) => item.pid), [12, 13]);
});

test('dispatch_worker 子进程 environ 含本题 FGS_UNIQUE_CODE，且不改写 BENCHMARK_*', () => {
  const scratch = tmpDir('fgs-dispatch-env-');
  const dump = path.join(scratch, 'env.json');
  const worker = path.join(scratch, 'dump_env.py');
  fs.writeFileSync(worker, [
    'import json, os',
    `open(${JSON.stringify(dump)}, "w", encoding="utf-8").write(json.dumps({`,
    '  "code": os.environ.get("FGS_UNIQUE_CODE"),',
    '  "bench": os.environ.get("BENCHMARK_BASE_URL"),',
    '  "token": os.environ.get("BENCHMARK_TOKEN"),',
    '}))',
    '',
  ].join('\n'));
  const probed = py(`
import json, os, pathlib, time
from supervisor.core import dispatch_worker
os.environ["BENCHMARK_BASE_URL"] = "http://tsecbench.zc.tencent.com.tsecbench.gw"
os.environ["BENCHMARK_TOKEN"] = "secret-token"
os.environ["FGS_UNIQUE_CODE"] = "stale-global"
run = pathlib.Path(${JSON.stringify(scratch)})
result = dispatch_worker(run, "e2-04", "brief", ["python3", ${JSON.stringify(worker)}])
dump = pathlib.Path(${JSON.stringify(dump)})
for _ in range(50):
    if dump.is_file():
        break
    time.sleep(0.05)
child = json.loads(dump.read_text(encoding="utf-8"))
print(json.dumps({"parent": os.environ.get("FGS_UNIQUE_CODE"), "pid": result["pid"], "child": child}))
`);
  assert.equal(probed.status, 0, probed.stderr);
  const out = JSON.parse(probed.stdout);
  assert.equal(out.parent, 'stale-global');
  assert.equal(out.child.code, 'e2-04');
  assert.equal(out.child.bench, 'http://tsecbench.zc.tencent.com.tsecbench.gw');
  assert.equal(out.child.token, 'secret-token');
});

test('CONTEST_HTTP_TIMEOUT 覆盖 list/start/close，非法值直接失败', () => {
  const probed = py(`
import os
from supervisor.core import SupervisorError, http_timeout
os.environ["CONTEST_HTTP_TIMEOUT"] = "8.5"
print("override", http_timeout(20), http_timeout(30))
os.environ["CONTEST_HTTP_TIMEOUT"] = "0"
try:
    http_timeout(20)
    print("zero-ok")
except SupervisorError as exc:
    print("zero", exc)
os.environ["CONTEST_HTTP_TIMEOUT"] = "nope"
try:
    http_timeout(20)
    print("bad-ok")
except SupervisorError as exc:
    print("bad", exc)
os.environ.pop("CONTEST_HTTP_TIMEOUT", None)
print("default", http_timeout(20), http_timeout(30))
`);
  assert.equal(probed.status, 0, probed.stderr);
  assert.match(probed.stdout, /override 8\.5 8\.5/);
  assert.match(probed.stdout, /zero CONTEST_HTTP_TIMEOUT must be a positive/);
  assert.match(probed.stdout, /bad CONTEST_HTTP_TIMEOUT is not a number: nope/);
  assert.match(probed.stdout, /default 20\.0 30\.0/);
  assert.doesNotMatch(probed.stdout, /zero-ok|bad-ok/);
});

test('urlopen 的 TimeoutError 变成可重试的传输错误，HTTP 状态不算传输失败', () => {
  const probed = py(`
import io, json
from email.message import Message
import urllib.error
import urllib.request
from supervisor.core import PlatformTransportError, SupervisorError, request_json

class Resp:
    def __init__(self, body):
        self.status = 200
        self._body = body.encode()
    def read(self):
        return self._body
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False

seen = {"timeouts": []}

def fake_urlopen(req, timeout=None):
    seen["timeouts"].append(timeout)
    url = req.full_url
    if url.endswith("/timeout"):
        raise TimeoutError("timed out")
    if url.endswith("/status"):
        raise urllib.error.HTTPError(url, 404, "missing", Message(), io.BytesIO(b"missing"))
    return Resp("{}")

urllib.request.urlopen = fake_urlopen
os_timeout = ""
try:
    request_json("POST", "http://benchmark.invalid/api/v1/challenges/close?unique_code=a-16/timeout", "tok", {})
except PlatformTransportError as exc:
    os_timeout = str(exc)
except SupervisorError as exc:
    os_timeout = "supervisor " + str(exc)
http_status = ""
status_type = ""
try:
    request_json("POST", "http://benchmark.invalid/api/v1/challenges/close?unique_code=a-16/status", "tok", {})
except PlatformTransportError as exc:
    http_status = "transport " + str(exc)
    status_type = "transport"
except SupervisorError as exc:
    http_status = str(exc)
    status_type = "http"
print(json.dumps({
    "timeout": os_timeout,
    "statusType": status_type,
    "status": http_status,
    "timeouts": seen["timeouts"],
}))
`);
  assert.equal(probed.status, 0, probed.stderr);
  const body = JSON.parse(probed.stdout);
  assert.match(body.timeout, /TimeoutError: timed out/);
  assert.equal(body.statusType, 'http');
  assert.match(body.status, /HTTP 404/);
  assert.doesNotMatch(body.status, /^transport /);
  assert.deepEqual(body.timeouts, [20, 20]);
});

test('真实 urlopen 读超时是 TimeoutError，request_json 收成传输错误', () => {
  const probed = py(`
import os, socket, threading, time
os.environ["CONTEST_HTTP_TIMEOUT"] = "0.3"
from supervisor.core import PlatformTransportError, SupervisorError, request_json
sock = socket.socket()
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", 0))
sock.listen(1)
port = sock.getsockname()[1]

def hold():
    conn, _ = sock.accept()
    time.sleep(2)
    try:
        conn.close()
    except OSError:
        pass

threading.Thread(target=hold, daemon=True).start()
started = time.time()
try:
    request_json(
        "POST",
        "http://127.0.0.1:%s/api/v1/challenges/close?unique_code=a-16" % port,
        "tok",
        {},
    )
    print("NO-ERROR")
except PlatformTransportError as exc:
    print("TRANSPORT %.2f %s" % (time.time() - started, exc))
except SupervisorError as exc:
    print("SUPERVISOR %.2f %s" % (time.time() - started, exc))
finally:
    sock.close()
`);
  assert.equal(probed.status, 0, probed.stderr);
  assert.match(probed.stdout, /TRANSPORT \d+(\.\d+)? request failed POST http:\/\/127\.0\.0\.1:\d+\/api\/v1\/challenges\/close\?unique_code=a-16: TimeoutError: timed out/);
  assert.doesNotMatch(probed.stdout, /NO-ERROR|SUPERVISOR|Traceback/);
});

test('close TimeoutError 不退出 driver，下一 tick 重试并关掉', () => {
  const scratch = tmpDir('fgs-close-to-');
  const runDir = path.join(scratch, 'run');
  const probed = py(`
import json, os, urllib.request
from pathlib import Path
import driver

class Resp:
    def __init__(self, body):
        self.status = 200
        self._body = body.encode()
    def read(self):
        return self._body
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False

challenges = {"challenges": [
    {"unique_code": "a-16", "is_completed": False, "container_status": "available", "description": "ssrf"},
    {"unique_code": "a-17", "is_completed": False, "container_status": "available", "description": "diag"},
    {"unique_code": "a-18", "is_completed": False, "container_status": "available", "description": "jwt"},
]}
state = {"closes": 0, "timeouts": []}

def fake_urlopen(req, timeout=None):
    state["timeouts"].append(timeout)
    url = req.full_url
    if "/challenges/close" in url:
        state["closes"] += 1
        if state["closes"] == 1:
            raise TimeoutError("timed out")
        return Resp("{}")
    if req.get_method() == "GET":
        return Resp(json.dumps(challenges))
    raise AssertionError(url)

urllib.request.urlopen = fake_urlopen
sleeps = {"n": 0}
probe = Path(os.environ["RUN"]) / "probe.json"

def fake_sleep(_seconds):
    sleeps["n"] += 1
    probe.parent.mkdir(parents=True, exist_ok=True)
    probe.write_text(json.dumps({"sleeps": sleeps["n"], "closes": state["closes"], "timeouts": state["timeouts"]}), encoding="utf-8")
    if sleeps["n"] >= 2:
        raise SystemExit(0)

driver.time.sleep = fake_sleep
run = Path(os.environ["RUN"])
work = Path(os.environ["CONTEST_WORKDIR"])
driver.supervisor_loop(run, work, os.environ["BENCHMARK_TOKEN"], os.environ["BENCHMARK_BASE_URL"], "")
`, {
    RUN: runDir,
    CONTEST_WORKDIR: path.join(scratch, 'work'),
    CONTEST_HTTP_TIMEOUT: '8',
    CONTEST_SUPERVISOR_INTERVAL: '0',
    BENCHMARK_API_PREFIX: '/api/v1',
    PYTHONUNBUFFERED: '1',
  });
  assert.equal(probed.status, 0, probed.stderr);
  assert.doesNotMatch(probed.stderr, /Traceback/);
  assert.match(probed.stderr, /close a-16 failed:.*TimeoutError: timed out/);
  assert.match(probed.stderr, /pending retry/);
  assert.match(probed.stderr, /close a-16 failed:[\s\S]*contest: close a-16\n/);
  const ticks = probed.stderr.split('supervisor tick').length - 1;
  assert.ok(ticks >= 2, probed.stderr);
  const probe = JSON.parse(fs.readFileSync(path.join(runDir, 'probe.json'), 'utf8'));
  assert.equal(probe.sleeps, 2);
  assert.ok(probe.closes >= 2);
  assert.ok(probe.timeouts.length >= 2);
  assert.ok(probe.timeouts.every((value) => value === 8));
  const closed = fs.readFileSync(path.join(runDir, 'attempted', 'closed.txt'), 'utf8');
  assert.match(closed, /^a-16$/m);
  assert.match(closed, /^a-17$/m);
  assert.match(closed, /^a-18$/m);
});

test('list TimeoutError 不退出 driver，按未知列表失败关闭并继续 tick', () => {
  const scratch = tmpDir('fgs-list-to-');
  const runDir = path.join(scratch, 'run');
  const probed = py(`
import json, os, urllib.request
from pathlib import Path
import driver

def fake_urlopen(req, timeout=None):
    raise TimeoutError("timed out")

urllib.request.urlopen = fake_urlopen
sleeps = {"n": 0}
probe = Path(os.environ["RUN"]) / "probe.json"

def fake_sleep(_seconds):
    sleeps["n"] += 1
    probe.parent.mkdir(parents=True, exist_ok=True)
    probe.write_text(json.dumps({"sleeps": sleeps["n"]}), encoding="utf-8")
    if sleeps["n"] >= 2:
        raise SystemExit(0)

driver.time.sleep = fake_sleep
run = Path(os.environ["RUN"])
work = Path(os.environ["CONTEST_WORKDIR"])
driver.supervisor_loop(run, work, os.environ["BENCHMARK_TOKEN"], os.environ["BENCHMARK_BASE_URL"], "")
`, {
    RUN: runDir,
    CONTEST_WORKDIR: path.join(scratch, 'work'),
    CONTEST_HTTP_TIMEOUT: '8',
    CONTEST_SUPERVISOR_INTERVAL: '0',
    BENCHMARK_API_PREFIX: '/api/v1',
    PYTHONUNBUFFERED: '1',
  });
  assert.equal(probed.status, 0, probed.stderr);
  assert.doesNotMatch(probed.stderr, /Traceback/);
  assert.doesNotMatch(probed.stderr, /no pending challenges/);
  assert.match(probed.stderr, /list challenges failed:.*TimeoutError: timed out/);
  const ticks = probed.stderr.split('supervisor tick').length - 1;
  assert.ok(ticks >= 2, probed.stderr);
  assert.match(probed.stderr, /active=99/);
  const probe = JSON.parse(fs.readFileSync(path.join(runDir, 'probe.json'), 'utf8'));
  assert.equal(probe.sleeps, 2);
});

test('start TimeoutError 记成 visit 失败，driver 跑完主循环', () => {
  const scratch = tmpDir('fgs-start-to-');
  const probed = py(`
import json, os, urllib.request
from pathlib import Path
import driver

class Resp:
    def __init__(self, body):
        self.status = 200
        self._body = body.encode()
    def read(self):
        return self._body
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False

body = json.dumps({"challenges": [{
    "unique_code": "a-18",
    "is_completed": False,
    "container_status": "stopped",
    "description": "jwt",
}]})

def fake_urlopen(req, timeout=None):
    url = req.full_url
    if "/challenges/start" in url:
        raise TimeoutError("timed out")
    if req.get_method() == "GET":
        return Resp(body)
    raise AssertionError(url)

urllib.request.urlopen = fake_urlopen
run = Path(os.environ["RUN"])
work = Path(os.environ["CONTEST_WORKDIR"])
raise SystemExit(driver.supervisor_loop(
    run, work, os.environ["BENCHMARK_TOKEN"], os.environ["BENCHMARK_BASE_URL"], "",
))
`, {
    RUN: path.join(scratch, 'run'),
    CONTEST_WORKDIR: path.join(scratch, 'work'),
    CONTEST_SUPERVISOR_INTERVAL: '0',
    BENCHMARK_API_PREFIX: '/api/v1',
    PYTHONUNBUFFERED: '1',
  });
  assert.equal(probed.status, 1, probed.stderr);
  assert.doesNotMatch(probed.stderr, /Traceback/);
  assert.match(probed.stderr, /visit a-18 failed:.*TimeoutError: timed out/);
  assert.match(probed.stderr, /done ok=0 failed=1/);
});

test('supervisor tick：close TimeoutError 后下一 tick 仍能关掉', () => {
  const scratch = tmpDir('fgs-cli-close-to-');
  const runDir = path.join(scratch, 'run');
  const probed = py(`
import json, os, sys, urllib.request
sys.path.insert(0, os.path.join(os.environ["PYTHONPATH"], "supervisor"))
import cli

class Resp:
    def __init__(self, body):
        self.status = 200
        self._body = body.encode()
    def read(self):
        return self._body
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False

challenges = {"challenges": [
    {"unique_code": "a-16", "is_completed": False, "container_status": "available"},
    {"unique_code": "a-17", "is_completed": False, "container_status": "available"},
    {"unique_code": "a-18", "is_completed": False, "container_status": "available"},
]}
state = {"closes": 0}

def fake_urlopen(req, timeout=None):
    url = req.full_url
    if "/challenges/close" in url:
        state["closes"] += 1
        if state["closes"] == 1:
            raise TimeoutError("timed out")
        return Resp("{}")
    if req.get_method() == "GET":
        return Resp(json.dumps(challenges))
    raise AssertionError(url)

urllib.request.urlopen = fake_urlopen
first = cli.cmd_tick([])
second = cli.cmd_tick([])
print(json.dumps({"first": first, "second": second, "closes": state["closes"]}))
`, {
    RUN: runDir,
    CONTEST_HTTP_TIMEOUT: '8',
    BENCHMARK_API_PREFIX: '/api/v1',
    PYTHONUNBUFFERED: '1',
  });
  assert.equal(probed.status, 0, probed.stderr);
  assert.doesNotMatch(probed.stderr, /Traceback/);
  assert.match(probed.stderr, /contest: close a-16 failed:.*TimeoutError: timed out/);
  assert.match(probed.stderr, /pending retry/);
  assert.match(probed.stdout, /close a-16 ->/);
  const body = JSON.parse(probed.stdout.trim().split('\n').filter((line) => line.startsWith('{')).at(-1));
  assert.equal(body.first, 0);
  assert.equal(body.second, 0);
  assert.ok(body.closes >= 2);
  const closed = fs.readFileSync(path.join(runDir, 'attempted', 'closed.txt'), 'utf8');
  assert.match(closed, /^a-16$/m);
});
