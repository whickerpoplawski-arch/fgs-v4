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
