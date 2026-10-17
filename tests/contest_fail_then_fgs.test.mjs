/**
 * Fail-then-FGS: new work stays on contest-baseline. Only a narrow fail
 * enters the FIFO, and FGS runs after new work is exhausted.
 * No platform and no LLM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { GraphStore } from '../controller/index.js';
import { bootstrapProject } from '../tools/bootstrap_project.mjs';
import { applyEnrich } from '../tools/apply_enrich.mjs';
import { tmpDir } from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driver = path.join(repoRoot, 'contest', 'driver.py');

function runPython(args, env) {
  return spawnSync('python3', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env, PYTHONPATH: path.join(repoRoot, 'contest') },
  });
}

function writeFixture(dir, challenges) {
  const file = path.join(dir, 'challenges.json');
  fs.writeFileSync(file, JSON.stringify({ challenges }));
  return file;
}

function pidGone(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.split(')').pop().trim().split(/\s+/)[0];
    return state === 'Z' || state === 'X';
  } catch {
    return true;
  }
}

function pyJson(script, env = {}) {
  const result = runPython(['-c', script], env);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return { body: JSON.parse(result.stdout), stderr: result.stderr };
}

test('on_fail ignores CONTEST_FGS_AFTER_SEC for a first pass', () => {
  const script = [
    'import json, os, driver',
    'os.environ["CONTEST_FGS_MODE"] = "on_fail"',
    'os.environ["CONTEST_FGS_AFTER_SEC"] = "0"',
    'os.environ.pop("CONTEST_DSH_PROFILE", None)',
    'os.environ.pop("CONTEST_DSH_PROFILE_FGS", None)',
    'selected = driver.profile_for_visit("first", elapsed=99999)',
    'wall = driver.profile_for_now(elapsed=99999)',
    'print(json.dumps({"visit": selected, "wall": wall, "fgs": driver.profile_has_fgs(selected)}))',
  ].join('\n');
  const { body, stderr } = pyJson(script);
  assert.equal(body.visit, 'contest-baseline');
  assert.equal(body.wall, 'contest-baseline');
  assert.equal(body.fgs, false);
  assert.match(stderr, /pass=first/);
  assert.match(stderr, /FGS_AFTER=ignored mode=on_fail/);
  assert.match(stderr, /contest-baseline \(FGS off\)/);
  assert.doesNotMatch(stderr, /→ contest \(FGS on\)/);
});

test('FGS pass selects contest even when the wall clock would stay on baseline', () => {
  const script = [
    'import json, os, driver',
    'os.environ["CONTEST_FGS_MODE"] = "on_fail"',
    'os.environ["CONTEST_FGS_AFTER_SEC"] = "7200"',
    'selected = driver.profile_for_visit("fgs", elapsed=1)',
    'print(json.dumps({"profile": selected, "fgs": driver.profile_has_fgs(selected)}))',
  ].join('\n');
  const { body, stderr } = pyJson(script);
  assert.equal(body.profile, 'contest');
  assert.equal(body.fgs, true);
  assert.match(stderr, /pass=fgs mode=on_fail → contest \(FGS on\)/);
});

test('mode=off never selects the FGS profile; mode=after_sec still uses the wall clock', () => {
  const off = pyJson([
    'import json, os, driver',
    'os.environ["CONTEST_FGS_MODE"] = "off"',
    'os.environ["CONTEST_FGS_AFTER_SEC"] = "0"',
    'print(json.dumps({"first": driver.profile_for_visit("first", elapsed=0), "fgs": driver.profile_for_visit("fgs", elapsed=0)}))',
  ].join('\n'));
  assert.equal(off.body.first, 'contest-baseline');
  assert.equal(off.body.fgs, 'contest-baseline');

  const legacy = pyJson([
    'import json, os, driver',
    'os.environ["CONTEST_FGS_MODE"] = "after_sec"',
    'os.environ["CONTEST_FGS_AFTER_SEC"] = "7200"',
    'print(json.dumps({"early": driver.profile_for_now(elapsed=100), "late": driver.profile_for_now(elapsed=7200)}))',
  ].join('\n'));
  assert.equal(legacy.body.early, 'contest-baseline');
  assert.equal(legacy.body.late, 'contest');
  assert.match(legacy.stderr, /elapsed=7200\.0 FGS_AFTER=7200 → contest \(FGS on\)/);
});

test('fail rule, FIFO, retry-last, max active, and solved exclusion', () => {
  const scratch = tmpDir('fgs-fail-queue-');
  const script = `
import json, os
from datetime import datetime, timezone
from pathlib import Path
import driver
from fail_queue import (
    failure_reason, register_fail, list_fails, note_fgs_dispatch,
    select_dispatch, plan_budget_retire, fgs_done,
)
from supervisor.core import plan_retire

os.environ["CONTEST_FGS_MODE"] = "on_fail"
run = Path(${JSON.stringify(scratch)})
now = datetime(2026, 1, 1, tzinfo=timezone.utc)

reasons = {
  "reap": failure_reason(completed=False, alive=False, launched=True, meta_state=None, deferred_past_grace=False, budget_past=False, fail_on_budget=False, transport_glitch=False),
  "live": failure_reason(completed=False, alive=True, launched=True, meta_state="running", deferred_past_grace=False, budget_past=False, fail_on_budget=False, transport_glitch=False),
  "solved": failure_reason(completed=True, alive=False, launched=True, meta_state="solved", deferred_past_grace=False, budget_past=False, fail_on_budget=False, transport_glitch=False),
  "meta_solved": failure_reason(completed=False, alive=False, launched=True, meta_state="solved", deferred_past_grace=False, budget_past=False, fail_on_budget=False, transport_glitch=False),
  "deferred": failure_reason(completed=False, alive=True, launched=True, meta_state="deferred", deferred_past_grace=True, budget_past=False, fail_on_budget=False, transport_glitch=False),
  "glitch": failure_reason(completed=False, alive=False, launched=True, meta_state=None, deferred_past_grace=False, budget_past=False, fail_on_budget=False, transport_glitch=True),
  "stub": failure_reason(completed=False, alive=False, launched=False, meta_state=None, deferred_past_grace=False, budget_past=False, fail_on_budget=False, transport_glitch=False),
  "budget_off": failure_reason(completed=False, alive=True, launched=True, meta_state="running", deferred_past_grace=False, budget_past=True, fail_on_budget=False, transport_glitch=False),
  "budget_on": failure_reason(completed=False, alive=True, launched=True, meta_state="running", deferred_past_grace=False, budget_past=True, fail_on_budget=True, transport_glitch=False),
}

register_fail(run, unique_code="late-1", reason="reap", artifact_dir="/tmp/late", now=datetime(2026, 1, 2, tzinfo=timezone.utc))
register_fail(run, unique_code="early-1", reason="deferred", artifact_dir="/tmp/early", now=datetime(2026, 1, 1, tzinfo=timezone.utc))
again = register_fail(run, unique_code="early-1", reason="reap", artifact_dir="/tmp/other", now=datetime(2026, 6, 1, tzinfo=timezone.utc))
order = [item["unique_code"] for item in list_fails(run)]

challenges = [
    {"unique_code": "new-1", "is_completed": False, "description": "fresh"},
    {"unique_code": "early-1", "is_completed": False, "description": "old fail"},
    {"unique_code": "late-1", "is_completed": False, "description": "newer fail"},
    {"unique_code": "done-1", "is_completed": True, "description": "solved"},
]
common = dict(run=run, inflight=set(), blocked=set(), fgs_inflight=0, alive=0, active=0, cap=3, fgs_max_active=1, max_retries=1, list_failed=False)
prefer_new = [item["code"] + ":" + item["pass_kind"] for item in select_dispatch(challenges, retry_last=True, **common)]
only_fgs = [item["code"] for item in select_dispatch(
    [item for item in challenges if item["unique_code"] != "new-1"],
    retry_last=True, **common,
)]
parallel = [item["pass_kind"] for item in select_dispatch(challenges, retry_last=False, **common)]
capped = select_dispatch(
    [item for item in challenges if item["unique_code"] != "new-1"],
    retry_last=True, **{**common, "fgs_inflight": 1},
)
note_fgs_dispatch(run, "early-1", 1)
after_cap = select_dispatch(
    [item for item in challenges if item["unique_code"] != "new-1"],
    retry_last=True, **common,
)
driver._note_retire_fail(
    run,
    {"code": "done-1", "state": "solved", "dir": "/tmp/done"},
    {"pass_kind": "first"},
    [{"unique_code": "done-1", "is_completed": True}],
    list_failed=False,
)
running = [{
    "code": "hold-1", "alive": True, "pid": 42, "dir": "/tmp/hold",
    "meta_state": "running", "meta_at": "2026-01-01T00:00:00Z", "meta_present": True,
    "started_at": "2026-01-01T00:00:00Z", "budget_min": "60",
}]
held = plan_retire(running, challenges, now=now, grace=60, grace_solved=30)
budget_off = plan_budget_retire(running, challenges, now=datetime(2026, 1, 1, 3, tzinfo=timezone.utc), enabled=False)
budget_on = plan_budget_retire(running, challenges, now=datetime(2026, 1, 1, 3, tzinfo=timezone.utc), enabled=True)
print(json.dumps({
  "reasons": reasons,
  "order": order,
  "kept_at": again["failed_at"],
  "kept_reason": again["reason"],
  "prefer_new": prefer_new,
  "only_fgs": only_fgs,
  "parallel": parallel,
  "capped": len(capped),
  "after_cap": [item["code"] for item in after_cap],
  "early_done": fgs_done(run, "early-1"),
  "solved_file": (run / "queue" / "failed" / "done-1.json").exists(),
  "hold_ops": [item["op"] for item in held],
  "budget_off": len(budget_off),
  "budget_state": [item["state"] for item in budget_on],
}))
`;
  const { body } = pyJson(script);
  assert.equal(body.reasons.reap, 'reap');
  assert.equal(body.reasons.live, null);
  assert.equal(body.reasons.solved, null);
  assert.equal(body.reasons.meta_solved, null);
  assert.equal(body.reasons.deferred, 'deferred');
  assert.equal(body.reasons.glitch, null);
  assert.equal(body.reasons.stub, null);
  assert.equal(body.reasons.budget_off, null);
  assert.equal(body.reasons.budget_on, 'budget');
  assert.deepEqual(body.order, ['early-1', 'late-1']);
  assert.equal(body.kept_at, '2026-01-01T00:00:00Z');
  assert.equal(body.kept_reason, 'deferred');
  assert.deepEqual(body.prefer_new, ['new-1:first']);
  assert.deepEqual(body.only_fgs, ['early-1']);
  assert.deepEqual(body.parallel, ['first', 'fgs']);
  assert.equal(body.capped, 0);
  assert.deepEqual(body.after_cap, ['late-1']);
  assert.equal(body.early_done, true);
  assert.equal(body.solved_file, false);
  assert.deepEqual(body.hold_ops, []);
  assert.equal(body.budget_off, 0);
  assert.deepEqual(body.budget_state, ['budget']);
});

test('enrich payload redacts flags and apply_enrich writes Fact plus an open Intent', () => {
  const scratch = tmpDir('fgs-enrich-');
  const artifact = path.join(scratch, 'artifacts');
  fs.mkdirSync(path.join(artifact, '.fgs'), { recursive: true });
  fs.writeFileSync(path.join(artifact, 'note.txt'), 'baseline probed /login and wrote BASELINE_NOTE_TOKEN flag{should-not-leak}\n');
  fs.writeFileSync(
    path.join(artifact, '.fgs', 'observations.jsonl'),
    `${JSON.stringify({ at: '2026-01-01T00:00:00Z', note: 'excluded EXCLUDED_OLD_PATH 404' })}\n`
    + `${JSON.stringify({ at: '2026-01-01T00:00:01Z', note: 'found OBS_SQLI_LOGIN on /login' })}\n`,
  );
  const script = [
    'import json',
    'from fail_graph import collect_enrich',
    `payload = collect_enrich(${JSON.stringify(artifact)}, reason="reap")`,
    'print(json.dumps(payload))',
  ].join('\n');
  const { body: payload } = pyJson(script);
  assert.equal(payload.empty, false);
  assert.ok(payload.facts.some((fact) => fact.title === 'baseline 做过什么'));
  assert.ok(payload.facts.some((fact) => fact.title.includes('已排除') && fact.content.includes('EXCLUDED_OLD_PATH')));
  assert.ok(payload.facts.some((fact) => fact.title.includes('已验证') && fact.content.includes('OBS_SQLI_LOGIN')));
  assert.match(payload.intent.action, /基于已有原语继续利用并提交 flag/);
  const flat = JSON.stringify(payload);
  assert.match(flat, /BASELINE_NOTE_TOKEN/);
  assert.doesNotMatch(flat, /flag\{should-not-leak\}/);
  assert.match(flat, /\[redacted\]/);

  const cwd = path.join(scratch, 'work');
  fs.mkdirSync(cwd);
  bootstrapProject({
    cwd,
    problemId: 'p-1',
    brief: '题面',
    target: '10.0.0.1:80',
    uniqueCode: 'p-1',
  });
  const applied = applyEnrich({ cwd, problemId: 'p-1', payload });
  assert.equal(applied.status, 'enriched');
  assert.ok(applied.facts >= 3);
  assert.equal(applied.intent, true);
  const graph = new GraphStore(path.join(cwd, '.fgs', 'projects', 'p-1')).load();
  const titles = graph.facts.map((fact) => fact.title);
  assert.ok(titles.includes('baseline 做过什么'));
  assert.ok(titles.some((title) => title.includes('EXCLUDED_OLD_PATH') || graph.facts.some((fact) => String(fact.content).includes('EXCLUDED_OLD_PATH'))));
  assert.ok(graph.facts.some((fact) => String(fact.content).includes('OBS_SQLI_LOGIN')));
  assert.ok(graph.facts.some((fact) => String(fact.content).includes('BASELINE_NOTE_TOKEN')));
  const open = graph.steps.filter((step) => step.state === 'open');
  assert.equal(open.length, 1);
  assert.match(open[0].action, /基于已有原语/);
  const dumped = fs.readFileSync(path.join(cwd, '.fgs', 'projects', 'p-1', 'graph.yaml'), 'utf8');
  assert.doesNotMatch(dumped, /flag\{should-not-leak\}/);
  const again = applyEnrich({ cwd, problemId: 'p-1', payload });
  assert.equal(again.status, 'already-enriched');
  const reread = new GraphStore(path.join(cwd, '.fgs', 'projects', 'p-1')).load();
  assert.equal(reread.facts.length, graph.facts.length);
  assert.equal(reread.steps.length, graph.steps.length);
});

test('empty artifacts still seed and log enrich=empty', () => {
  const scratch = tmpDir('fgs-enrich-empty-');
  const workdir = path.join(scratch, 'work');
  const run = path.join(scratch, 'run');
  fs.mkdirSync(path.join(run, 'queue', 'artifacts', 'empty-1'), { recursive: true });
  fs.mkdirSync(path.join(run, 'queue', 'failed'), { recursive: true });
  fs.writeFileSync(
    path.join(run, 'queue', 'failed', 'empty-1.json'),
    `${JSON.stringify({
      unique_code: 'empty-1',
      failed_at: '2026-01-01T00:00:00Z',
      reason: 'reap',
      artifact_dir: path.join(run, 'queue', 'artifacts', 'empty-1'),
      attempt: 1,
      fgs_attempts: 0,
    })}\n`,
  );
  fs.mkdirSync(path.join(run, 'queue', 'first_pass_done'), { recursive: true });
  fs.writeFileSync(path.join(run, 'queue', 'first_pass_done', 'empty-1'), 'empty-1\n');
  const fixture = writeFixture(scratch, [{
    unique_code: 'empty-1',
    description: 'nothing left behind',
    is_completed: false,
    container_addr: ['http://10.9.0.1'],
  }]);
  const result = runPython([driver], {
    BENCHMARK_TOKEN: 'test-token',
    BENCHMARK_BASE_URL: 'http://benchmark.invalid',
    CONTEST_FIXTURE: fixture,
    CONTEST_WORKDIR: workdir,
    RUN: run,
    CONTEST_DSH_LAUNCH: '0',
    CONTEST_SUPERVISOR: '1',
    CONTEST_SUPERVISOR_INTERVAL: '0',
    CONTEST_FGS_MODE: 'on_fail',
    CONTEST_FGS_AFTER_SEC: '0',
    CONTEST_FGS_RETRY_LAST: '1',
    SOLVER_GATEWAY: '0',
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /pass=fgs/);
  assert.match(result.stderr, /enrich=empty/);
  const graph = fs.readFileSync(path.join(workdir, 'empty-1', '.fgs', 'projects', 'empty-1', 'graph.yaml'), 'utf8');
  assert.match(graph, /fact_origin/);
  assert.match(graph, /goal_final/);
  assert.equal(fs.existsSync(path.join(run, 'queue', 'fgs_done', 'empty-1')), true);
});

test('a dead baseline worker is retried once with FGS after new work is gone', () => {
  const scratch = tmpDir('fgs-fail-retry-');
  const script = path.join(scratch, 'worker.sh');
  fs.writeFileSync(script, `#!/bin/sh
mkdir -p .fgs
printf '%s\\n' '{"at":"2026-01-01T00:00:00Z","note":"found OBS_SQLI_LOGIN on /login"}' >> .fgs/observations.jsonl
printf '%s\\n' 'baseline probed /login BASELINE_NOTE_TOKEN flag{should-not-leak}' > note.txt
exit 0
`);
  fs.chmodSync(script, 0o755);
  const workdir = path.join(scratch, 'work');
  const run = path.join(scratch, 'run');
  const fixture = writeFixture(scratch, [{
    unique_code: 'retry-1',
    description: 'fail then fgs',
    is_completed: false,
    container_addr: ['http://10.8.0.2'],
  }]);
  const result = runPython([driver], {
    BENCHMARK_TOKEN: 'test-token',
    BENCHMARK_BASE_URL: 'http://benchmark.invalid',
    CONTEST_FIXTURE: fixture,
    CONTEST_WORKDIR: workdir,
    RUN: run,
    CONTEST_DSH_LAUNCH: '0',
    CONTEST_SUPERVISOR: '1',
    CONTEST_SUPERVISOR_INTERVAL: '0',
    CONTEST_WORKER_CMD: script,
    CONTEST_FGS_MODE: 'on_fail',
    CONTEST_FGS_AFTER_SEC: '0',
    CONTEST_FGS_RETRY_LAST: '1',
    CONTEST_FGS_MAX_RETRIES: '1',
    SOLVER_GATEWAY: '0',
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal((result.stderr.match(/pass=first elapsed=/g) || []).length, 1);
  assert.equal((result.stderr.match(/visit retry-1 .* pass=first/g) || []).length, 1);
  assert.equal((result.stderr.match(/pass=fgs mode=on_fail/g) || []).length, 1);
  assert.equal((result.stderr.match(/visit retry-1 .* pass=fgs/g) || []).length, 1);
  assert.match(result.stderr, /contest-baseline \(FGS off\)/);
  assert.match(result.stderr, /enrich=facts:/);
  assert.doesNotMatch(result.stderr, /FGS_AFTER=0 → contest/);
  const fail = JSON.parse(fs.readFileSync(path.join(run, 'queue', 'failed', 'retry-1.json'), 'utf8'));
  assert.equal(fail.unique_code, 'retry-1');
  assert.equal(fail.reason, 'reap');
  assert.equal(fail.attempt, 1);
  assert.ok(fail.failed_at);
  assert.equal(fail.fgs_attempts, 1);
  assert.equal(fs.existsSync(path.join(run, 'queue', 'fgs_done', 'retry-1')), true);
  const passes = fs.readFileSync(path.join(workdir, 'retry-1', '.contest', 'passes.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(passes.map((item) => item.pass), ['first', 'fgs']);
  assert.equal(passes[0].profile, 'contest-baseline');
  assert.equal(passes[0].fgs, false);
  assert.equal(passes[1].profile, 'contest');
  assert.equal(passes[1].fgs, true);
  const graphText = fs.readFileSync(path.join(workdir, 'retry-1', '.fgs', 'projects', 'retry-1', 'graph.yaml'), 'utf8');
  assert.match(graphText, /OBS_SQLI_LOGIN/);
  assert.match(graphText, /BASELINE_NOTE_TOKEN/);
  assert.match(graphText, /基于已有原语/);
  assert.doesNotMatch(graphText, /flag\{should-not-leak\}/);
  const launch = JSON.parse(fs.readFileSync(path.join(workdir, 'retry-1', '.fgs', 'dsh-launch.json'), 'utf8'));
  assert.equal(launch.profile, 'contest');
  assert.equal(launch.pass, 'fgs');
});

test('deferred past grace is a fail and gets one FGS pass', () => {
  const scratch = tmpDir('fgs-deferred-fail-');
  const script = path.join(scratch, 'worker.sh');
  fs.writeFileSync(script, `#!/bin/sh
id=$(basename "$PWD")
mkdir -p ".fgs/projects/$id"
printf '%s\\n' '{"state":"deferred","deferredAt":"2000-01-01T00:00:00Z"}' > ".fgs/projects/$id/meta.json"
exec sleep 120
`);
  fs.chmodSync(script, 0o755);
  const workdir = path.join(scratch, 'work');
  const run = path.join(scratch, 'run');
  const fixture = writeFixture(scratch, [{
    unique_code: 'def-1',
    description: 'deferred',
    is_completed: false,
    container_addr: ['http://10.8.0.9'],
  }]);
  const result = runPython([driver], {
    BENCHMARK_TOKEN: 'test-token',
    BENCHMARK_BASE_URL: 'http://benchmark.invalid',
    CONTEST_FIXTURE: fixture,
    CONTEST_WORKDIR: workdir,
    RUN: run,
    CONTEST_DSH_LAUNCH: '0',
    CONTEST_SUPERVISOR: '1',
    CONTEST_SUPERVISOR_INTERVAL: '0',
    CONTEST_SUPERVISOR_NOW: '2026-01-01T00:00:00Z',
    CONTEST_RETIRE_GRACE: '180',
    CONTEST_WORKER_CMD: script,
    CONTEST_FGS_MODE: 'on_fail',
    CONTEST_FGS_AFTER_SEC: '0',
    CONTEST_FGS_RETRY_LAST: '1',
    SOLVER_GATEWAY: '0',
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /retire def-1/);
  assert.match(result.stderr, /pass=fgs/);
  const fail = JSON.parse(fs.readFileSync(path.join(run, 'queue', 'failed', 'def-1.json'), 'utf8'));
  assert.equal(fail.reason, 'deferred');
  assert.equal(fail.attempt, 1);
  assert.equal(fs.existsSync(path.join(run, 'queue', 'fgs_done', 'def-1')), true);
  const passes = fs.readFileSync(path.join(workdir, 'def-1', '.contest', 'passes.jsonl'), 'utf8');
  assert.match(passes, /contest-baseline/);
  assert.match(passes, /"pass": "fgs"/);
  const launch = JSON.parse(fs.readFileSync(path.join(workdir, 'def-1', '.fgs', 'dsh-launch.json'), 'utf8'));
  assert.equal(launch.profile, 'contest');
  assert.equal(launch.pass, 'fgs');
});

test('an in-flight baseline worker keeps its profile while another challenge takes FGS', async () => {
  const scratch = tmpDir('fgs-isolate-');
  const script = path.join(scratch, 'worker.sh');
  fs.writeFileSync(script, `#!/bin/sh
id=$(basename "$PWD")
if [ "$id" = "hold-1" ]; then
  exec sleep 120
fi
mkdir -p .fgs
printf '%s\\n' '{"note":"excluded EXCLUDED_OLD_PATH 404"}' >> .fgs/observations.jsonl
printf '%s\\n' 'baseline wrote BASELINE_NOTE_TOKEN' > note.txt
exit 0
`);
  fs.chmodSync(script, 0o755);
  const workdir = path.join(scratch, 'work');
  const run = path.join(scratch, 'run');
  const fixture = writeFixture(scratch, [
    {
      unique_code: 'hold-1',
      description: 'still running',
      is_completed: false,
      container_addr: ['http://10.8.0.3'],
    },
    {
      unique_code: 'fail-1',
      description: 'dies',
      is_completed: false,
      container_addr: ['http://10.8.0.4'],
    },
  ]);
  const child = spawn('python3', [driver], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(repoRoot, 'contest'),
      PYTHONUNBUFFERED: '1',
      BENCHMARK_TOKEN: 'test-token',
      BENCHMARK_BASE_URL: 'http://benchmark.invalid',
      CONTEST_FIXTURE: fixture,
      CONTEST_WORKDIR: workdir,
      RUN: run,
      CONTEST_DSH_LAUNCH: '0',
      CONTEST_SUPERVISOR: '1',
      CONTEST_SUPERVISOR_INTERVAL: '0',
      CONTEST_MAX_ACTIVE: '2',
      CONTEST_WORKER_CMD: script,
      CONTEST_FGS_MODE: 'on_fail',
      CONTEST_FGS_AFTER_SEC: '0',
      CONTEST_FGS_RETRY_LAST: '1',
      SOLVER_GATEWAY: '0',
    },
  });
  let stderr = '';
  const matched = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for pass=fgs\n${stderr}`));
    }, 15000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (/pass=fgs/.test(stderr)) {
        clearTimeout(timer);
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        resolve();
      }
    });
    child.on('error', reject);
    child.on('exit', () => {
      if (!/pass=fgs/.test(stderr)) {
        clearTimeout(timer);
        reject(new Error(`driver exited before pass=fgs\n${stderr}`));
      }
    });
  });
  let holdPid = 0;
  try {
    await matched;
    const launchPath = path.join(workdir, 'hold-1', '.fgs', 'dsh-launch.json');
    const launch = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
    holdPid = launch.pid;
    assert.equal(launch.profile, 'contest-baseline');
    assert.equal(launch.fgs, false);
    assert.equal(launch.pass, 'first');
    process.kill(holdPid, 0);
    const fail = JSON.parse(fs.readFileSync(path.join(run, 'queue', 'failed', 'fail-1.json'), 'utf8'));
    assert.equal(fail.reason, 'reap');
    assert.equal(fs.existsSync(path.join(run, 'queue', 'failed', 'hold-1.json')), false);
    const passes = fs.readFileSync(path.join(workdir, 'hold-1', '.contest', 'passes.jsonl'), 'utf8');
    assert.match(passes, /contest-baseline/);
    assert.doesNotMatch(passes, /"pass": "fgs"/);
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    if (holdPid) {
      try {
        process.kill(-holdPid, 'SIGKILL');
      } catch {
        try {
          process.kill(holdPid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }
});

test('step cap exempts from_fail_queue, keeps failed_at, and parks on a list glitch', () => {
  const scratch = tmpDir('fgs-steps-unit-');
  const work = path.join(scratch, 'over');
  fs.mkdirSync(path.join(work, '.fgs'), { recursive: true });
  fs.writeFileSync(path.join(work, '.fgs', 'dsh_step_count'), '101\n');
  const script = `
import json, os
from datetime import datetime, timezone
from pathlib import Path
import driver
from fail_queue import (
    challenge_max_steps, failure_reason, plan_steps_retire, plan_budget_retire,
    read_step_count, register_fail,
)

os.environ.pop("CONTEST_CHALLENGE_MAX_STEPS", None)
default_limit = challenge_max_steps()
os.environ["CONTEST_CHALLENGE_MAX_STEPS"] = "100"
limit = challenge_max_steps()
run = Path(${JSON.stringify(scratch)})
work = Path(${JSON.stringify(work)})

def worker(code, **extra):
    base = {
        "code": code, "alive": True, "pid": 7, "dir": str(work),
        "meta_state": "running", "pass_kind": "first", "step_count": 101,
        "started_at": "2026-01-01T00:00:00Z", "budget_min": "1",
    }
    base.update(extra)
    return base

challenges = [
    {"unique_code": "over-1", "is_completed": False},
    {"unique_code": "exact-1", "is_completed": False},
    {"unique_code": "done-1", "is_completed": True},
    {"unique_code": "fgs-1", "is_completed": False},
    {"unique_code": "miss-1", "is_completed": False},
    {"unique_code": "def-1", "is_completed": False},
]
workers = [
    worker("over-1", step_count=101),
    worker("exact-1", step_count=100),
    worker("done-1", step_count=400),
    worker("fgs-1", pass_kind="fgs", from_fail_queue=True, step_count=900),
    worker("miss-1", step_count=None),
    worker("dead-1", alive=False, step_count=500),
    worker("def-1", meta_state="deferred", step_count=500),
]
steps = [item["code"] for item in plan_steps_retire(workers, challenges, limit=limit)]
off = plan_steps_retire(workers, challenges, limit=0)
budget = [
    item["code"] for item in plan_budget_retire(
        workers, challenges, now=datetime(2026, 1, 1, 3, tzinfo=timezone.utc), enabled=True,
    )
]
common = dict(
    completed=False, alive=True, launched=True, meta_state="running",
    deferred_past_grace=False, budget_past=False, fail_on_budget=False, transport_glitch=False,
)
reasons = {
    "steps": failure_reason(**common, steps_past=True),
    "steps_done": failure_reason(**{**common, "completed": True}, steps_past=True),
    "steps_solved": failure_reason(**{**common, "meta_state": "solved"}, steps_past=True),
    "glitch": failure_reason(**{**common, "transport_glitch": True}, steps_past=True),
    "under": failure_reason(**common, steps_past=False),
}
driver._note_retire_fail(
    run,
    {"code": "over-1", "state": "steps", "dir": str(work), "step_count": 101},
    {"pass_kind": "first"},
    [{"unique_code": "over-1", "is_completed": False}],
    list_failed=False,
)
first = register_fail(run, unique_code="over-1", reason="reap", artifact_dir="/tmp/other", now=datetime(2026, 6, 1, tzinfo=timezone.utc))
driver._note_retire_fail(
    run,
    {"code": "done-1", "state": "steps", "dir": str(work), "step_count": 400},
    {"pass_kind": "first"},
    [{"unique_code": "done-1", "is_completed": True}],
    list_failed=False,
)
driver._note_retire_fail(
    run,
    {"code": "fgs-1", "state": "steps", "dir": str(work), "step_count": 900},
    {"pass_kind": "fgs", "from_fail_queue": True},
    [{"unique_code": "fgs-1", "is_completed": False}],
    list_failed=False,
)
driver._note_retire_fail(
    run,
    {"code": "park-1", "state": "steps", "dir": str(work), "step_count": 150},
    {"pass_kind": "first"},
    [{"unique_code": "park-1", "is_completed": False}],
    list_failed=True,
)
print(json.dumps({
    "default_limit": default_limit,
    "limit": limit,
    "read": read_step_count(work),
    "missing": read_step_count(run / "nope"),
    "steps": steps,
    "off": len(off),
    "budget": budget,
    "reasons": reasons,
    "kept_at": first["failed_at"],
    "kept_reason": first["reason"],
    "done_file": (run / "queue" / "failed" / "done-1.json").exists(),
    "fgs_file": (run / "queue" / "failed" / "fgs-1.json").exists(),
    "park_file": (run / "queue" / "failed" / "park-1.json").exists(),
    "parked": (run / "queue" / "pending_classify" / "park-1.json").exists(),
}))
`;
  const { body, stderr } = pyJson(script);
  assert.equal(body.default_limit, 0);
  assert.equal(body.limit, 100);
  assert.equal(body.read, 101);
  assert.equal(body.missing, null);
  assert.deepEqual(body.steps, ['over-1']);
  assert.equal(body.off, 0);
  assert.deepEqual(body.budget, ['over-1', 'exact-1', 'miss-1']);
  assert.equal(body.reasons.steps, 'steps');
  assert.equal(body.reasons.steps_done, null);
  assert.equal(body.reasons.steps_solved, null);
  assert.equal(body.reasons.glitch, null);
  assert.equal(body.reasons.under, null);
  assert.equal(body.kept_at, JSON.parse(fs.readFileSync(path.join(scratch, 'queue', 'failed', 'over-1.json'), 'utf8')).failed_at);
  assert.notEqual(body.kept_at, '2026-06-01T00:00:00Z');
  assert.equal(body.kept_reason, 'steps');
  assert.equal(body.done_file, false);
  assert.equal(body.fgs_file, false);
  assert.equal(body.park_file, false);
  assert.equal(body.parked, true);
  assert.match(stderr, /retire over-1 \(steps\)|fail_queue steps code=over-1 n=101/);
  assert.match(stderr, /fail_queue steps code=over-1 n=101/);
  assert.doesNotMatch(stderr, /fail_queue steps code=park-1/);
  assert.doesNotMatch(stderr, /fail_queue steps code=done-1/);
  assert.doesNotMatch(stderr, /fail_queue steps code=fgs-1/);
});

test('a baseline past 125 steps with a free FGS slot fails as steps and does not promote', async () => {
  const scratch = tmpDir('fgs-steps-live-');
  const script = path.join(scratch, 'worker.sh');
  fs.writeFileSync(script, `#!/bin/sh
id=$(basename "$PWD")
if [ "$id" = "over-1" ]; then
  mkdir -p .fgs
  printf '%s\\n' 126 > .fgs/dsh_step_count
fi
exec sleep 120
`);
  fs.chmodSync(script, 0o755);
  const workdir = path.join(scratch, 'work');
  const run = path.join(scratch, 'run');
  const fixture = writeFixture(scratch, [
    {
      unique_code: 'over-1',
      description: 'too many steps',
      is_completed: false,
      container_addr: ['http://10.8.0.11'],
    },
    {
      unique_code: 'fresh-1',
      description: 'still new',
      is_completed: false,
      container_addr: ['http://10.8.0.12'],
    },
  ]);
  const child = spawn('python3', [driver], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(repoRoot, 'contest'),
      PYTHONUNBUFFERED: '1',
      BENCHMARK_TOKEN: 'test-token',
      BENCHMARK_BASE_URL: 'http://benchmark.invalid',
      CONTEST_FIXTURE: fixture,
      CONTEST_WORKDIR: workdir,
      RUN: run,
      CONTEST_DSH_LAUNCH: '0',
      CONTEST_SUPERVISOR: '1',
      CONTEST_SUPERVISOR_INTERVAL: '0',
      CONTEST_MAX_ACTIVE: '1',
      CONTEST_WORKER_CMD: script,
      CONTEST_FGS_MODE: 'on_fail',
      CONTEST_FGS_RETRY_LAST: '1',
      CONTEST_CHALLENGE_MAX_STEPS: '125',
      CONTEST_CHALLENGE_FGS_AFTER_STEPS: '75',
      CONTEST_FGS_MAX_ACTIVE: '1',
      CONTEST_FAIL_ON_BUDGET: '0',
      SOLVER_GATEWAY: '0',
    },
  });
  let stderr = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for fresh-1\n${stderr}`));
      }, 15000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (/visit fresh-1 /.test(stderr) && /retire over-1 \(steps\)/.test(stderr)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', () => {
        if (!/visit fresh-1 /.test(stderr)) {
          clearTimeout(timer);
          reject(new Error(`driver exited before fresh-1\n${stderr}`));
        }
      });
    });
    assert.match(stderr, /contest: retire over-1 \(steps\)/);
    assert.match(stderr, /contest: fail_queue steps code=over-1 n=126/);
    assert.match(stderr, /visit fresh-1 .* pass=first/);
    assert.doesNotMatch(stderr, /pass=fgs/);
    assert.doesNotMatch(stderr, /promote /);
    const fail = JSON.parse(fs.readFileSync(path.join(run, 'queue', 'failed', 'over-1.json'), 'utf8'));
    assert.equal(fail.reason, 'steps');
    assert.ok(fail.failed_at);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'failed', 'fresh-1.json')), false);
    const passes = fs.readFileSync(path.join(workdir, 'fresh-1', '.contest', 'passes.jsonl'), 'utf8');
    assert.match(passes, /"pass": "first"/);
    assert.doesNotMatch(passes, /"pass": "fgs"/);
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    for (const code of ['over-1', 'fresh-1']) {
      try {
        const launch = JSON.parse(fs.readFileSync(path.join(workdir, code, '.fgs', 'dsh-launch.json'), 'utf8'));
        if (launch.pid) process.kill(-launch.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
});

test('last-round FGS ignores the step cap and the wall-clock budget', async () => {
  const scratch = tmpDir('fgs-steps-exempt-');
  const script = path.join(scratch, 'worker.sh');
  fs.writeFileSync(script, `#!/bin/sh
mkdir -p .fgs
printf '%s\\n' 900 > .fgs/dsh_step_count
exec sleep 120
`);
  fs.chmodSync(script, 0o755);
  const workdir = path.join(scratch, 'work');
  const run = path.join(scratch, 'run');
  fs.mkdirSync(path.join(run, 'queue', 'failed'), { recursive: true });
  fs.mkdirSync(path.join(run, 'queue', 'first_pass_done'), { recursive: true });
  fs.writeFileSync(path.join(run, 'queue', 'failed', 'redo-1.json'), `${JSON.stringify({
    unique_code: 'redo-1',
    failed_at: '2026-01-01T00:00:00Z',
    reason: 'reap',
    artifact_dir: '',
    attempt: 1,
    problem_id: '',
    fgs_attempts: 0,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(run, 'queue', 'first_pass_done', 'redo-1'), 'redo-1\n');
  const fixture = writeFixture(scratch, [{
    unique_code: 'redo-1',
    description: 'retry without a cap',
    is_completed: false,
    time_budget_min: 0.01,
    container_addr: ['http://10.8.0.13'],
  }]);
  const child = spawn('python3', [driver], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(repoRoot, 'contest'),
      PYTHONUNBUFFERED: '1',
      BENCHMARK_TOKEN: 'test-token',
      BENCHMARK_BASE_URL: 'http://benchmark.invalid',
      CONTEST_FIXTURE: fixture,
      CONTEST_WORKDIR: workdir,
      RUN: run,
      CONTEST_DSH_LAUNCH: '0',
      CONTEST_SUPERVISOR: '1',
      CONTEST_SUPERVISOR_INTERVAL: '0',
      CONTEST_MAX_ACTIVE: '1',
      CONTEST_WORKER_CMD: script,
      CONTEST_FGS_MODE: 'on_fail',
      CONTEST_FGS_RETRY_LAST: '1',
      CONTEST_CHALLENGE_MAX_STEPS: '125',
      CONTEST_CHALLENGE_FGS_AFTER_STEPS: '75',
      CONTEST_FAIL_ON_BUDGET: '1',
      CONTEST_SKIP_FGS_SEED: '1',
      SOLVER_GATEWAY: '0',
    },
  });
  let stderr = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for pass=fgs\n${stderr}`));
      }, 15000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (/pass=fgs/.test(stderr)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', () => {
        if (!/pass=fgs/.test(stderr)) {
          clearTimeout(timer);
          reject(new Error(`driver exited before pass=fgs\n${stderr}`));
        }
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.match(stderr, /pass=fgs/);
    assert.doesNotMatch(stderr, /retire redo-1/);
    assert.doesNotMatch(stderr, /fail_queue steps/);
    assert.doesNotMatch(stderr, /promote /);
    const fail = JSON.parse(fs.readFileSync(path.join(run, 'queue', 'failed', 'redo-1.json'), 'utf8'));
    assert.equal(fail.reason, 'reap');
    assert.equal(fail.failed_at, '2026-01-01T00:00:00Z');
    assert.equal(fail.fgs_attempts, 1);
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    try {
      const launch = JSON.parse(fs.readFileSync(path.join(workdir, 'redo-1', '.fgs', 'dsh-launch.json'), 'utf8'));
      if (launch.pid) process.kill(-launch.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

test('promote threshold is strict >, loses to the step cap, and only from_fail_queue is exempt', () => {
  const scratch = tmpDir('fgs-promote-unit-');
  const work = path.join(scratch, 'mid');
  fs.mkdirSync(path.join(work, '.fgs'), { recursive: true });
  fs.writeFileSync(path.join(work, '.fgs', 'note.txt'), 'kept\n');
  const script = `
import json, os
from pathlib import Path
import driver
from fail_queue import plan_budget_retire, plan_promote, plan_steps_retire, promote_after_steps
from datetime import datetime, timezone

def gate(max_steps, after):
    os.environ["CONTEST_CHALLENGE_MAX_STEPS"] = str(max_steps)
    os.environ["CONTEST_CHALLENGE_FGS_AFTER_STEPS"] = str(after)
    return promote_after_steps()

gates = {
    "50_100": gate(100, 50),
    "off": gate(100, 0),
    "equal": gate(100, 100),
    "above": gate(100, 150),
    "no_max": gate(0, 50),
}
os.environ["CONTEST_CHALLENGE_MAX_STEPS"] = "100"
os.environ["CONTEST_CHALLENGE_FGS_AFTER_STEPS"] = "50"

def worker(code, **extra):
    base = {
        "code": code, "alive": True, "pid": 7, "dir": ${JSON.stringify(work)},
        "meta_state": "running", "pass_kind": "first", "step_count": 60,
        "started_at": "2026-01-01T00:00:00Z", "budget_min": "1",
    }
    base.update(extra)
    return base

challenges = [
    {"unique_code": code, "is_completed": code == "done"}
    for code in ("hi", "exact50", "exact100", "over", "mid", "mid-over", "last", "done")
]
workers = [
    worker("hi", step_count=51),
    worker("exact50", step_count=50),
    worker("exact100", step_count=100),
    worker("over", step_count=101),
    worker("mid", pass_kind="fgs", from_fail_queue=False, step_count=80),
    worker("mid-over", pass_kind="fgs", from_fail_queue=False, step_count=150),
    worker("last", pass_kind="fgs", from_fail_queue=True, step_count=900),
    worker("done", step_count=80),
]
steps = [item["code"] for item in plan_steps_retire(workers, challenges, limit=100)]
promoted = [item["code"] for item in plan_promote(workers, challenges, after=50, limit=100, skip_codes=set(steps))]
promoted_open = [item["code"] for item in plan_promote(workers, challenges, after=50, limit=100)]
budget = [
    item["code"] for item in plan_budget_retire(
        workers, challenges, now=datetime(2026, 1, 1, 3, tzinfo=timezone.utc), enabled=True,
    )
]
run = Path(${JSON.stringify(scratch)})
driver._note_retire_fail(
    run,
    {"code": "mid-over", "state": "steps", "dir": ${JSON.stringify(work)}, "step_count": 150},
    {"pass_kind": "fgs", "from_fail_queue": False},
    [{"unique_code": "mid-over", "is_completed": False}],
    list_failed=False,
)
first = json.loads((run / "queue" / "failed" / "mid-over.json").read_text())
driver._classify_dead_slot(
    run,
    {"code": "mid-over", "proc": None, "launched": True, "dir": ${JSON.stringify(work)}, "pass_kind": "fgs", "from_fail_queue": False},
    [{"unique_code": "mid-over", "is_completed": False}],
    transport_glitch=False,
)
second = json.loads((run / "queue" / "failed" / "mid-over.json").read_text())
driver._note_retire_fail(
    run,
    {"code": "def-mid", "state": "deferred", "dir": ${JSON.stringify(work)}},
    {"pass_kind": "fgs", "from_fail_queue": False},
    [{"unique_code": "def-mid", "is_completed": False}],
    list_failed=False,
)
driver._note_retire_fail(
    run,
    {"code": "last-steps", "state": "steps", "dir": ${JSON.stringify(work)}, "step_count": 900},
    {"pass_kind": "fgs", "from_fail_queue": True},
    [{"unique_code": "last-steps", "is_completed": False}],
    list_failed=False,
)
driver._classify_dead_slot(
    run,
    {"code": "last-reap", "proc": None, "launched": True, "dir": ${JSON.stringify(work)}, "pass_kind": "fgs", "from_fail_queue": True},
    [{"unique_code": "last-reap", "is_completed": False}],
    transport_glitch=False,
)
driver.note_promote_launch_failure(
    run,
    {"promote": True, "code": "boom-1", "dir": ${JSON.stringify(work)}},
    {"ok": False, "code": "boom-1"},
)
boom = json.loads((run / "queue" / "failed" / "boom-1.json").read_text())
driver.note_promote_launch_failure(
    run,
    {"promote": True, "code": "boom-1", "dir": ${JSON.stringify(work)}},
    {"ok": False, "code": "boom-1"},
)
boom2 = json.loads((run / "queue" / "failed" / "boom-1.json").read_text())
print(json.dumps({
    "gates": gates,
    "steps": steps,
    "promoted": promoted,
    "promoted_open": promoted_open,
    "budget_has_mid": "mid" in budget and "mid-over" in budget,
    "budget_has_last": "last" in budget,
    "mid_reason": first["reason"],
    "mid_attempts": first["fgs_attempts"],
    "mid_at_held": first["failed_at"] == second["failed_at"],
    "mid_reason_held": second["reason"],
    "deferred": json.loads((run / "queue" / "failed" / "def-mid.json").read_text())["reason"],
    "last_steps": (run / "queue" / "failed" / "last-steps.json").exists(),
    "last_reap": (run / "queue" / "failed" / "last-reap.json").exists(),
    "boom_reason": boom["reason"],
    "boom_attempts": boom["fgs_attempts"],
    "boom_at_held": boom["failed_at"] == boom2["failed_at"],
    "fgs_done": (run / "queue" / "fgs_done" / "boom-1").exists() or (run / "queue" / "fgs_done" / "mid-over").exists(),
}))
`;
  const { body } = pyJson(script);
  assert.equal(body.gates['50_100'], 50);
  assert.equal(body.gates.off, 0);
  assert.equal(body.gates.equal, 0);
  assert.equal(body.gates.above, 0);
  assert.equal(body.gates.no_max, 0);
  assert.deepEqual(body.steps, ['over', 'mid-over']);
  assert.deepEqual(body.promoted, ['exact100', 'hi']);
  assert.deepEqual(body.promoted_open, ['exact100', 'hi']);
  assert.equal(body.budget_has_mid, true);
  assert.equal(body.budget_has_last, false);
  assert.equal(body.mid_reason, 'steps');
  assert.equal(body.mid_attempts, 0);
  assert.equal(body.mid_at_held, true);
  assert.equal(body.mid_reason_held, 'steps');
  assert.equal(body.deferred, 'deferred');
  assert.equal(body.last_steps, false);
  assert.equal(body.last_reap, false);
  assert.equal(body.boom_reason, 'promote');
  assert.equal(body.boom_attempts, 0);
  assert.equal(body.boom_at_held, true);
  assert.equal(body.fgs_done, false);
});

test('promote at 76 keeps the step file; a full slot at 76 is fgs_slot_busy; 126 is steps', () => {
  const scratch = tmpDir('fgs-promote-kill-');
  const script = `
import json, os, signal, subprocess
from datetime import datetime, timezone
from pathlib import Path
import driver
from fail_queue import (
    challenge_fgs_after_steps, challenge_max_steps, plan_promote, plan_slot_busy,
    plan_steps_retire, register_fail,
)

os.environ.pop("CONTEST_CHALLENGE_MAX_STEPS", None)
os.environ.pop("CONTEST_CHALLENGE_FGS_AFTER_STEPS", None)
default_max = challenge_max_steps()
default_after = challenge_fgs_after_steps()
os.environ["CONTEST_CHALLENGE_MAX_STEPS"] = "125"
os.environ["CONTEST_CHALLENGE_FGS_AFTER_STEPS"] = "75"
scratch = Path(${JSON.stringify(scratch)})
run = scratch / "run"
pids = []
closed = []

def note_close(code):
    closed.append(code)

def launch_slot(code, steps):
    work = scratch / code
    (work / ".fgs").mkdir(parents=True)
    (work / ".fgs" / "dsh_step_count").write_text(str(steps) + "\\n")
    (work / ".fgs" / "baseline_marker").write_text("yes\\n")
    proc = subprocess.Popen(["sleep", "60"], start_new_session=True)
    pids.append(proc.pid)
    slot = {
        "code": code, "pid": proc.pid, "proc": proc, "dir": str(work),
        "launched": True, "pass_kind": "first", "from_fail_queue": False,
    }
    challenge = {"unique_code": code, "is_completed": False, "container_addr": ["http://10.8.0.20"]}
    return work, proc, slot, challenge

def view(code, steps, **extra):
    base = {
        "code": code, "alive": True, "pid": 7, "dir": str(scratch / code),
        "meta_state": "running", "pass_kind": "first", "step_count": steps,
    }
    base.update(extra)
    return base

try:
    challenges = [
        {"unique_code": code, "is_completed": False}
        for code in ("at75", "at76", "at125", "at126", "mid126", "last900")
    ]
    workers = [
        view("at75", 75),
        view("at76", 76),
        view("at125", 125),
        view("at126", 126),
        view("mid126", 126, pass_kind="fgs", from_fail_queue=False),
        view("last900", 900, pass_kind="fgs", from_fail_queue=True),
    ]
    step_codes = [item["code"] for item in plan_steps_retire(workers, challenges, limit=125)]
    promoted = [item["code"] for item in plan_promote(workers, challenges, after=75, limit=125, skip_codes=set(step_codes))]
    busy = plan_slot_busy(workers, challenges, after=75, limit=125, skip_codes=set(step_codes))
    work, proc, slot, challenge = launch_slot("p-1", 76)
    held_slots = [slot]
    plans = driver.apply_promotes(run, held_slots, [challenge], room=1, skip_codes=set(), close=note_close)
    exact_work, exact_proc, exact_slot, exact_challenge = launch_slot("exact-75", 75)
    exact_plans = driver.apply_promotes(run, [exact_slot], [exact_challenge], room=1, skip_codes=set(), close=note_close)
    low_work, low_proc, low_slot, low_challenge = launch_slot("low-51", 51)
    low_plans = driver.apply_promotes(run, [low_slot], [low_challenge], room=1, skip_codes=set(), close=note_close)
    full_work, full_proc, full_slot, full_challenge = launch_slot("full-1", 76)
    full_held = [full_slot]
    full_plans = driver.apply_promotes(run, full_held, [full_challenge], room=0, skip_codes=set(), close=note_close)
    full_record = json.loads((run / "queue" / "failed" / "full-1.json").read_text())
    again = register_fail(
        run, unique_code="full-1", reason="steps", artifact_dir="/tmp/other",
        now=datetime(2026, 6, 1, tzinfo=timezone.utc),
    )
    over_work, over_proc, over_slot, over_challenge = launch_slot("over-126", 126)
    over_plans = driver.apply_promotes(run, [over_slot], [over_challenge], room=1, skip_codes=set(), close=note_close)
    skip_work, skip_proc, skip_slot, skip_challenge = launch_slot("skip-1", 100)
    skip_plans = driver.apply_promotes(run, [skip_slot], [skip_challenge], room=1, skip_codes={"skip-1"}, close=note_close)
    hi_work, hi_proc, hi_slot, hi_challenge = launch_slot("hi-90", 90)
    lo_work, lo_proc, lo_slot, lo_challenge = launch_slot("lo-76", 76)
    pair_slots = [hi_slot, lo_slot]
    pair_plans = driver.apply_promotes(
        run, pair_slots, [hi_challenge, lo_challenge], room=1, skip_codes=set(), close=note_close,
    )
    real_kill = driver.terminate_pid
    driver.terminate_pid = lambda *args, **kwargs: None
    stuck_work, stuck_proc, stuck_slot, stuck_challenge = launch_slot("stuck-1", 76)
    stuck_plans = driver.apply_promotes(run, [stuck_slot], [stuck_challenge], room=1, skip_codes=set(), close=note_close)
    busy_stuck_work, busy_stuck_proc, busy_stuck_slot, busy_stuck_challenge = launch_slot("busy-stuck", 76)
    busy_stuck_plans = driver.apply_promotes(run, [busy_stuck_slot], [busy_stuck_challenge], room=0, skip_codes=set(), close=note_close)
    driver.terminate_pid = real_kill
    enrich = driver.promote_enrich_dir(run, "p-1")
    print(json.dumps({
        "default_max": default_max,
        "default_after": default_after,
        "step_codes": step_codes,
        "promoted": promoted,
        "busy_codes": [item["code"] for item in busy],
        "busy_reasons": sorted({item["reason"] for item in busy}),
        "busy_tail": [item["code"] for item in busy[1:]],
        "plans": len(plans),
        "kind": plans[0]["pass_kind"],
        "promote": plans[0]["promote"],
        "from_fail": plans[0]["from_fail_queue"],
        "reuse": plans[0]["reuse_ok"],
        "dead": proc.poll() is not None,
        "removed": len(held_slots) == 0,
        "step_kept": (work / ".fgs" / "dsh_step_count").read_text().strip(),
        "marker": (enrich / ".fgs" / "baseline_marker").is_file(),
        "artifacts": (run / "queue" / "artifacts" / "p-1").exists(),
        "failed": (run / "queue" / "failed" / "p-1.json").exists(),
        "exact75": len(exact_plans) == 0 and exact_proc.poll() is None,
        "low51": len(low_plans) == 0 and low_proc.poll() is None,
        "full_plans": len(full_plans),
        "full_dead": full_proc.poll() is not None,
        "full_removed": len(full_held) == 0,
        "full_reason": full_record["reason"],
        "full_attempts": full_record["fgs_attempts"],
        "full_at": full_record["failed_at"],
        "full_again_at": again["failed_at"],
        "full_again_reason": again["reason"],
        "full_done": (run / "queue" / "first_pass_done" / "full-1").is_file(),
        "full_marker": (run / "queue" / "artifacts" / "full-1" / ".fgs" / "baseline_marker").is_file(),
        "full_enrich": driver.promote_enrich_dir(run, "full-1").exists(),
        "full_fgs_done": (run / "queue" / "fgs_done" / "full-1").exists(),
        "over": len(over_plans) == 0 and over_proc.poll() is None and not (run / "queue" / "failed" / "over-126.json").exists(),
        "skip": len(skip_plans) == 0 and skip_proc.poll() is None,
        "pair_code": pair_plans[0]["code"],
        "pair_kept": (hi_work / ".fgs" / "dsh_step_count").read_text().strip(),
        "pair_failed": not (run / "queue" / "failed" / "hi-90.json").exists(),
        "lo_dead": lo_proc.poll() is not None,
        "lo_reason": json.loads((run / "queue" / "failed" / "lo-76.json").read_text())["reason"],
        "lo_enrich": driver.promote_enrich_dir(run, "lo-76").exists(),
        "lo_marker": (run / "queue" / "artifacts" / "lo-76" / ".fgs" / "baseline_marker").is_file(),
        "pair_left": [item.get("code") for item in pair_slots],
        "stuck": len(stuck_plans) == 0 and stuck_proc.poll() is None and not driver.promote_enrich_dir(run, "stuck-1").exists() and not (run / "queue" / "failed" / "stuck-1.json").exists(),
        "busy_stuck": len(busy_stuck_plans) == 0 and busy_stuck_proc.poll() is None and not (run / "queue" / "artifacts" / "busy-stuck").exists() and not (run / "queue" / "failed" / "busy-stuck.json").exists(),
        "closed": closed,
    }))
finally:
    driver.terminate_pid = real_kill if "real_kill" in dir() else driver.terminate_pid
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
`;
  const { body, stderr } = pyJson(script);
  assert.equal(body.default_max, 0);
  assert.equal(body.default_after, 0);
  assert.deepEqual(body.step_codes, ['at126', 'mid126']);
  assert.deepEqual(body.promoted, ['at125', 'at76']);
  assert.deepEqual(body.busy_codes, ['at125', 'at76']);
  assert.deepEqual(body.busy_reasons, ['fgs_slot_busy']);
  assert.deepEqual(body.busy_tail, ['at76']);
  assert.equal(body.plans, 1);
  assert.equal(body.kind, 'fgs');
  assert.equal(body.promote, true);
  assert.equal(body.from_fail, false);
  assert.equal(body.reuse, true);
  assert.equal(body.dead, true);
  assert.equal(body.removed, true);
  assert.equal(body.step_kept, '76');
  assert.equal(body.marker, true);
  assert.equal(body.artifacts, false);
  assert.equal(body.failed, false);
  assert.equal(body.exact75, true);
  assert.equal(body.low51, true);
  assert.equal(body.full_plans, 0);
  assert.equal(body.full_dead, true);
  assert.equal(body.full_removed, true);
  assert.equal(body.full_reason, 'fgs_slot_busy');
  assert.equal(body.full_attempts, 0);
  assert.equal(body.full_at, body.full_again_at);
  assert.equal(body.full_again_reason, 'fgs_slot_busy');
  assert.notEqual(body.full_at, '2026-06-01T00:00:00Z');
  assert.equal(body.full_done, true);
  assert.equal(body.full_marker, true);
  assert.equal(body.full_enrich, false);
  assert.equal(body.full_fgs_done, false);
  assert.equal(body.over, true);
  assert.equal(body.skip, true);
  assert.equal(body.pair_code, 'hi-90');
  assert.equal(body.pair_kept, '90');
  assert.equal(body.pair_failed, true);
  assert.equal(body.lo_dead, true);
  assert.equal(body.lo_reason, 'fgs_slot_busy');
  assert.equal(body.lo_enrich, false);
  assert.equal(body.lo_marker, true);
  assert.deepEqual(body.pair_left, []);
  assert.equal(body.stuck, true);
  assert.equal(body.busy_stuck, true);
  assert.deepEqual(body.closed, ['full-1', 'lo-76']);
  assert.match(stderr, /contest: promote p-1 n=76/);
  assert.match(stderr, /contest: promote hi-90 n=90/);
  assert.match(stderr, /contest: fail_queue fgs_slot_busy code=full-1 n=76/);
  assert.match(stderr, /contest: retire full-1 \(fgs_slot_busy\)/);
  assert.match(stderr, /contest: retire lo-76 \(fgs_slot_busy\)/);
  assert.doesNotMatch(stderr, /fail_queue steps code=p-1/);
  assert.doesNotMatch(stderr, /promote full-1/);
  assert.doesNotMatch(stderr, /promote over-126/);
  assert.doesNotMatch(stderr, /promote exact-75/);
  assert.doesNotMatch(stderr, /promote low-51/);
});

test('promote at 76 keeps the step file, then the mid-round FGS fails at 126', async () => {
  const scratch = tmpDir('fgs-promote-live-');
  const script = path.join(scratch, 'worker.sh');
  fs.writeFileSync(script, `#!/bin/sh
id=$(basename "$PWD")
if [ "$id" != "slow-1" ]; then
  exec sleep 120
fi
mkdir -p .fgs
if [ ! -f .fgs/pass_marker ]; then
  echo first > .fgs/pass_marker
  echo yes > .fgs/baseline_marker
  printf '%s\\n' 76 > .fgs/dsh_step_count
else
  echo second > .fgs/pass_marker
  echo yes > .fgs/mid_marker
  if [ -f .fgs/dsh_step_count ]; then
    echo step_still_present > .fgs/step_state
  else
    echo step_cleared > .fgs/step_state
  fi
  printf '%s\\n' 126 > .fgs/dsh_step_count
fi
exec sleep 120
`);
  fs.chmodSync(script, 0o755);
  const workdir = path.join(scratch, 'work');
  const run = path.join(scratch, 'run');
  const fixture = writeFixture(scratch, [
    {
      unique_code: 'slow-1',
      description: 'promote then fail',
      is_completed: false,
      container_addr: ['http://10.8.0.21'],
    },
    {
      unique_code: 'fresh-1',
      description: 'waits for the slot',
      is_completed: false,
      container_addr: ['http://10.8.0.22'],
    },
  ]);
  const child = spawn('python3', [driver], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(repoRoot, 'contest'),
      PYTHONUNBUFFERED: '1',
      BENCHMARK_TOKEN: 'test-token',
      BENCHMARK_BASE_URL: 'http://benchmark.invalid',
      CONTEST_FIXTURE: fixture,
      CONTEST_WORKDIR: workdir,
      RUN: run,
      CONTEST_DSH_LAUNCH: '0',
      CONTEST_SUPERVISOR: '1',
      CONTEST_SUPERVISOR_INTERVAL: '0',
      CONTEST_MAX_ACTIVE: '1',
      CONTEST_WORKER_CMD: script,
      CONTEST_FGS_MODE: 'on_fail',
      CONTEST_FGS_RETRY_LAST: '1',
      CONTEST_FGS_MAX_ACTIVE: '1',
      CONTEST_CHALLENGE_MAX_STEPS: '125',
      CONTEST_CHALLENGE_FGS_AFTER_STEPS: '75',
      CONTEST_FAIL_ON_BUDGET: '0',
      CONTEST_SKIP_FGS_SEED: '1',
      SOLVER_GATEWAY: '0',
    },
  });
  let stderr = '';
  const killTree = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    for (const code of ['slow-1', 'fresh-1']) {
      try {
        const launch = JSON.parse(fs.readFileSync(path.join(workdir, code, '.fgs', 'dsh-launch.json'), 'utf8'));
        if (launch.pid) process.kill(-launch.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for promote then steps\n${stderr}`));
      }, 15000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (
          /promote slow-1 n=76/.test(stderr)
          && /retire slow-1 \(steps\)/.test(stderr)
          && /visit fresh-1 /.test(stderr)
        ) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', () => {
        if (!/retire slow-1 \(steps\)/.test(stderr)) {
          clearTimeout(timer);
          reject(new Error(`driver exited before steps retire\n${stderr}`));
        }
      });
    });
    const fail = JSON.parse(fs.readFileSync(path.join(run, 'queue', 'failed', 'slow-1.json'), 'utf8'));
    assert.equal(fail.reason, 'steps');
    assert.equal(fail.fgs_attempts, 0);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'fgs_done', 'slow-1')), false);
    assert.equal(fs.readFileSync(path.join(workdir, 'slow-1', '.fgs', 'step_state'), 'utf8').trim(), 'step_still_present');
    assert.equal(fs.existsSync(path.join(run, 'queue', 'promote_enrich', 'slow-1', '.fgs', 'baseline_marker')), true);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'promote_enrich', 'slow-1', '.fgs', 'mid_marker')), false);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'artifacts', 'slow-1', '.fgs', 'mid_marker')), true);
    const passes = fs.readFileSync(path.join(workdir, 'slow-1', '.contest', 'passes.jsonl'), 'utf8');
    assert.match(passes, /"pass": "first"/);
    assert.match(passes, /"pass": "fgs"/);
    assert.equal((stderr.match(/promote slow-1 n=76/g) || []).length, 1);
    assert.match(stderr, /fail_queue steps code=slow-1 n=126/);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'failed', 'slow-1.json')), true);
    assert.doesNotMatch(stderr, /fgs_slot_busy/);
    assert.match(stderr, /visit fresh-1 .* pass=first/);
  } finally {
    killTree();
  }
});

test('a full FGS slot at 76 slot-busies the baseline instead of keeping it', async () => {
  const scratch = tmpDir('fgs-promote-full-');
  const script = path.join(scratch, 'worker.sh');
  fs.writeFileSync(script, `#!/bin/sh
id=$(basename "$PWD")
mkdir -p .fgs
if [ "$id" = "slow-1" ]; then
  echo yes > .fgs/baseline_marker
  printf '%s\\n' 76 > .fgs/dsh_step_count
fi
exec sleep 120
`);
  fs.chmodSync(script, 0o755);
  const workdir = path.join(scratch, 'work');
  const run = path.join(scratch, 'run');
  fs.mkdirSync(path.join(run, 'queue', 'failed'), { recursive: true });
  fs.mkdirSync(path.join(run, 'queue', 'first_pass_done'), { recursive: true });
  fs.writeFileSync(path.join(run, 'queue', 'failed', 'redo-1.json'), `${JSON.stringify({
    unique_code: 'redo-1',
    failed_at: '2026-01-01T00:00:00Z',
    reason: 'reap',
    artifact_dir: '',
    attempt: 1,
    problem_id: '',
    fgs_attempts: 0,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(run, 'queue', 'first_pass_done', 'redo-1'), 'redo-1\n');
  const fixture = writeFixture(scratch, [
    {
      unique_code: 'slow-1',
      description: 'baseline that loses the FGS slot',
      is_completed: false,
      container_addr: ['http://10.8.0.31'],
    },
    {
      unique_code: 'redo-1',
      description: 'occupies the only FGS slot',
      is_completed: false,
      container_addr: ['http://10.8.0.32'],
    },
  ]);
  const child = spawn('python3', [driver], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(repoRoot, 'contest'),
      PYTHONUNBUFFERED: '1',
      BENCHMARK_TOKEN: 'test-token',
      BENCHMARK_BASE_URL: 'http://benchmark.invalid',
      CONTEST_FIXTURE: fixture,
      CONTEST_WORKDIR: workdir,
      RUN: run,
      CONTEST_DSH_LAUNCH: '0',
      CONTEST_SUPERVISOR: '1',
      CONTEST_SUPERVISOR_INTERVAL: '0',
      CONTEST_MAX_ACTIVE: '2',
      CONTEST_WORKER_CMD: script,
      CONTEST_FGS_MODE: 'on_fail',
      CONTEST_FGS_RETRY_LAST: '0',
      CONTEST_FGS_MAX_ACTIVE: '1',
      CONTEST_CHALLENGE_MAX_STEPS: '125',
      CONTEST_CHALLENGE_FGS_AFTER_STEPS: '75',
      CONTEST_FAIL_ON_BUDGET: '0',
      CONTEST_SKIP_FGS_SEED: '1',
      SOLVER_GATEWAY: '0',
    },
  });
  let stderr = '';
  const killTree = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    for (const code of ['slow-1', 'redo-1']) {
      try {
        const launch = JSON.parse(fs.readFileSync(path.join(workdir, code, '.fgs', 'dsh-launch.json'), 'utf8'));
        if (launch.pid) process.kill(-launch.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for slot-busy retire+close\n${stderr}`));
      }, 15000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (
          /visit slow-1 /.test(stderr)
          && /visit redo-1 /.test(stderr)
          && /pass=fgs/.test(stderr)
          && /fail_queue fgs_slot_busy code=slow-1 n=76/.test(stderr)
          && /retire slow-1 \(fgs_slot_busy\)/.test(stderr)
          && /contest: close slow-1/.test(stderr)
        ) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', () => {
        clearTimeout(timer);
        reject(new Error(`driver exited before slot-busy\n${stderr}`));
      });
    });
    const fail = JSON.parse(fs.readFileSync(path.join(run, 'queue', 'failed', 'slow-1.json'), 'utf8'));
    assert.equal(fail.reason, 'fgs_slot_busy');
    assert.equal(fail.fgs_attempts, 0);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'first_pass_done', 'slow-1')), true);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'artifacts', 'slow-1', '.fgs', 'baseline_marker')), true);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'promote_enrich', 'slow-1')), false);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'fgs_done', 'slow-1')), false);
    assert.match(stderr, /contest: retire slow-1 \(fgs_slot_busy\)/);
    assert.match(stderr, /contest: close slow-1/);
    assert.doesNotMatch(stderr, /promote slow-1/);
    const launch = JSON.parse(fs.readFileSync(path.join(workdir, 'slow-1', '.fgs', 'dsh-launch.json'), 'utf8'));
    assert.equal(launch.pass, 'first');
    assert.equal(launch.profile, 'contest-baseline');
    assert.equal(pidGone(launch.pid), true);
    const redo = JSON.parse(fs.readFileSync(path.join(run, 'queue', 'failed', 'redo-1.json'), 'utf8'));
    assert.equal(redo.fgs_attempts, 1);
    assert.equal(redo.failed_at, '2026-01-01T00:00:00Z');
    assert.equal(redo.reason, 'reap');
  } finally {
    killTree();
  }
});

function spawnSupervisor(scratch, workerSource, challenges, envExtra) {
  const script = path.join(scratch, 'worker.sh');
  fs.writeFileSync(script, workerSource);
  fs.chmodSync(script, 0o755);
  const workdir = path.join(scratch, 'work');
  const run = path.join(scratch, 'run');
  const fixture = writeFixture(scratch, challenges);
  const child = spawn('python3', [driver], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(repoRoot, 'contest'),
      PYTHONUNBUFFERED: '1',
      BENCHMARK_TOKEN: 'test-token',
      BENCHMARK_BASE_URL: 'http://benchmark.invalid',
      CONTEST_FIXTURE: fixture,
      CONTEST_WORKDIR: workdir,
      RUN: run,
      CONTEST_DSH_LAUNCH: '0',
      CONTEST_SUPERVISOR: '1',
      CONTEST_SUPERVISOR_INTERVAL: '0',
      CONTEST_WORKER_CMD: script,
      CONTEST_FGS_MODE: 'on_fail',
      CONTEST_FGS_MAX_ACTIVE: '1',
      CONTEST_CHALLENGE_MAX_STEPS: '125',
      CONTEST_CHALLENGE_FGS_AFTER_STEPS: '75',
      CONTEST_FAIL_ON_BUDGET: '0',
      CONTEST_SKIP_FGS_SEED: '1',
      SOLVER_GATEWAY: '0',
      ...envExtra,
    },
  });
  return { child, workdir, run };
}

function killLaunches(child, workdir, codes) {
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
  for (const code of codes) {
    try {
      const launch = JSON.parse(fs.readFileSync(path.join(workdir, code, '.fgs', 'dsh-launch.json'), 'utf8'));
      if (launch.pid) process.kill(-launch.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

test('a solved mid-FGS frees the slot so the next baseline can promote', async () => {
  const scratch = tmpDir('fgs-solved-promote-');
  const { child, workdir, run } = spawnSupervisor(scratch, `#!/bin/sh
id=$(basename "$PWD")
mkdir -p .fgs
if [ "$id" = "mid-1" ]; then
  if [ ! -f .fgs/pass_marker ]; then
    echo first > .fgs/pass_marker
    printf '%s\\n' 76 > .fgs/dsh_step_count
  else
    mkdir -p .fgs/projects/mid-1
    printf '%s\\n' '{"state":"solved","updatedAt":"2000-01-01T00:00:00Z"}' > .fgs/projects/mid-1/meta.json
  fi
  exec sleep 120
fi
if [ ! -f .fgs/pass_marker ]; then
  echo first > .fgs/pass_marker
  printf '%s\\n' 76 > .fgs/dsh_step_count
fi
exec sleep 120
`, [
    {
      unique_code: 'mid-1',
      description: 'promote then solve',
      is_completed: false,
      container_addr: ['http://10.8.0.41'],
    },
    {
      unique_code: 'wait-1',
      description: 'promotes after the slot frees',
      is_completed: false,
      container_addr: ['http://10.8.0.42'],
    },
  ], {
    CONTEST_MAX_ACTIVE: '1',
    CONTEST_FGS_RETRY_LAST: '1',
  });
  let stderr = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for the next promote\n${stderr}`));
      }, 15000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (/promote mid-1 n=76/.test(stderr) && /retire mid-1 \(solved\)/.test(stderr) && /promote wait-1 n=76/.test(stderr)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', () => {
        if (!/promote wait-1 n=76/.test(stderr)) {
          clearTimeout(timer);
          reject(new Error(`driver exited before the next promote\n${stderr}`));
        }
      });
    });
    assert.equal(fs.existsSync(path.join(run, 'queue', 'failed', 'mid-1.json')), false);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'failed', 'wait-1.json')), false);
    assert.doesNotMatch(stderr, /fgs_slot_busy/);
    assert.equal((stderr.match(/promote mid-1 n=76/g) || []).length, 1);
    assert.equal((stderr.match(/promote wait-1 n=76/g) || []).length, 1);
  } finally {
    killLaunches(child, workdir, ['mid-1', 'wait-1']);
  }
});

test('a solved mid-FGS frees the slot for the fail queue when no new challenge remains', async () => {
  const scratch = tmpDir('fgs-solved-fifo-');
  const runDir = path.join(scratch, 'run');
  fs.mkdirSync(path.join(runDir, 'queue', 'failed'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'queue', 'first_pass_done'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'queue', 'failed', 'redo-1.json'), `${JSON.stringify({
    unique_code: 'redo-1',
    failed_at: '2026-01-01T00:00:00Z',
    reason: 'reap',
    artifact_dir: '',
    attempt: 1,
    problem_id: '',
    fgs_attempts: 0,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'queue', 'first_pass_done', 'redo-1'), 'redo-1\n');
  const { child, workdir, run } = spawnSupervisor(scratch, `#!/bin/sh
id=$(basename "$PWD")
mkdir -p .fgs
if [ "$id" != "mid-1" ]; then
  exec sleep 120
fi
if [ ! -f .fgs/pass_marker ]; then
  echo first > .fgs/pass_marker
  printf '%s\\n' 76 > .fgs/dsh_step_count
else
  mkdir -p .fgs/projects/mid-1
  printf '%s\\n' '{"state":"solved","updatedAt":"2000-01-01T00:00:00Z"}' > .fgs/projects/mid-1/meta.json
fi
exec sleep 120
`, [
    {
      unique_code: 'mid-1',
      description: 'promote then solve',
      is_completed: false,
      container_addr: ['http://10.8.0.51'],
    },
    {
      unique_code: 'redo-1',
      description: 'fail queue after the solve',
      is_completed: false,
      container_addr: ['http://10.8.0.52'],
    },
  ], {
    CONTEST_MAX_ACTIVE: '1',
    CONTEST_FGS_RETRY_LAST: '1',
  });
  let stderr = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for the fail-queue visit\n${stderr}`));
      }, 15000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (/promote mid-1 n=76/.test(stderr) && /retire mid-1 \(solved\)/.test(stderr) && /visit redo-1 /.test(stderr) && /pass=fgs/.test(stderr)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', () => {
        if (!/visit redo-1 /.test(stderr)) {
          clearTimeout(timer);
          reject(new Error(`driver exited before the fail-queue visit\n${stderr}`));
        }
      });
    });
    assert.equal(fs.existsSync(path.join(run, 'queue', 'failed', 'mid-1.json')), false);
    assert.doesNotMatch(stderr, /fgs_slot_busy/);
    const redo = JSON.parse(fs.readFileSync(path.join(run, 'queue', 'failed', 'redo-1.json'), 'utf8'));
    assert.equal(redo.reason, 'reap');
    assert.equal(redo.failed_at, '2026-01-01T00:00:00Z');
    assert.equal(redo.fgs_attempts, 1);
    const passes = fs.readFileSync(path.join(workdir, 'redo-1', '.contest', 'passes.jsonl'), 'utf8');
    assert.match(passes, /"pass": "fgs"/);
  } finally {
    killLaunches(child, workdir, ['mid-1', 'redo-1']);
  }
});

test('RETRY_LAST=1 still enqueues fgs_slot_busy while a new challenge is waiting', async () => {
  const scratch = tmpDir('fgs-retry-last-busy-');
  const { child, workdir, run } = spawnSupervisor(scratch, `#!/bin/sh
id=$(basename "$PWD")
mkdir -p .fgs
if [ "$id" = "mid-1" ]; then
  if [ ! -f .fgs/pass_marker ]; then
    echo first > .fgs/pass_marker
    printf '%s\\n' 90 > .fgs/dsh_step_count
  fi
  exec sleep 120
fi
if [ "$id" = "busy-1" ]; then
  sleep 1
  echo yes > .fgs/baseline_marker
  printf '%s\\n' 76 > .fgs/dsh_step_count
  exec sleep 120
fi
exec sleep 120
`, [
    {
      unique_code: 'mid-1',
      description: 'wins the only FGS slot',
      is_completed: false,
      container_addr: ['http://10.8.0.61'],
    },
    {
      unique_code: 'busy-1',
      description: 'past AFTER while the slot is taken',
      is_completed: false,
      container_addr: ['http://10.8.0.62'],
    },
    {
      unique_code: 'fresh-1',
      description: 'still a new challenge',
      is_completed: false,
      container_addr: ['http://10.8.0.63'],
    },
  ], {
    CONTEST_MAX_ACTIVE: '2',
    CONTEST_FGS_RETRY_LAST: '1',
  });
  let stderr = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for slot-busy beside a new challenge\n${stderr}`));
      }, 15000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (
          /promote mid-1 n=90/.test(stderr)
          && /fail_queue fgs_slot_busy code=busy-1 n=76/.test(stderr)
          && /visit fresh-1 /.test(stderr)
        ) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', () => {
        clearTimeout(timer);
        reject(new Error(`driver exited before slot-busy beside a new challenge\n${stderr}`));
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const fail = JSON.parse(fs.readFileSync(path.join(run, 'queue', 'failed', 'busy-1.json'), 'utf8'));
    assert.equal(fail.reason, 'fgs_slot_busy');
    assert.equal(fail.fgs_attempts, 0);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'artifacts', 'busy-1', '.fgs', 'baseline_marker')), true);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'promote_enrich', 'busy-1')), false);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'failed', 'mid-1.json')), false);
    assert.equal(fs.existsSync(path.join(run, 'queue', 'failed', 'fresh-1.json')), false);
    assert.match(stderr, /contest: close busy-1/);
    assert.doesNotMatch(stderr, /promote busy-1/);
    assert.doesNotMatch(stderr, /visit busy-1 .* pass=fgs/);
    const launch = JSON.parse(fs.readFileSync(path.join(workdir, 'busy-1', '.fgs', 'dsh-launch.json'), 'utf8'));
    assert.equal(launch.pass, 'first');
    assert.equal(pidGone(launch.pid), true);
    const fresh = fs.readFileSync(path.join(workdir, 'fresh-1', '.contest', 'passes.jsonl'), 'utf8');
    assert.match(fresh, /"pass": "first"/);
    assert.doesNotMatch(fresh, /"pass": "fgs"/);
  } finally {
    killLaunches(child, workdir, ['mid-1', 'busy-1', 'fresh-1']);
  }
});

test('upload docs cite absolute 75/125 and do not keep a full slot or clear the step file', () => {
  const files = ['contest/UPLOAD_ENV.md', 'contest/SUPERVISOR.md', 'README.md'].map((rel) => ({
    rel,
    text: fs.readFileSync(path.join(repoRoot, rel), 'utf8'),
  }));
  const joined = files.map((item) => item.text).join('\n');
  assert.match(joined, /CONTEST_CHALLENGE_FGS_AFTER_STEPS=75/);
  assert.match(joined, /CONTEST_CHALLENGE_MAX_STEPS=125/);
  for (const item of files) {
    assert.match(item.text, /75/, item.rel);
    assert.match(item.text, /125/, item.rel);
    assert.match(item.text, /fgs_slot_busy/, item.rel);
  }
  assert.doesNotMatch(joined, /FGS_AFTER_STEPS=50/);
  assert.doesNotMatch(joined, /MAX_STEPS=100/);
  assert.doesNotMatch(joined, /槽满则不杀|槽满不杀/);
  assert.doesNotMatch(joined, /清掉同一目录|删掉同一目录/);
  assert.doesNotMatch(joined, /slot-full runs to 100|promote deletes dsh_step_count|keep pid to 100/i);
});
