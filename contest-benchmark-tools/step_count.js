/**
 * Monotonic step sidecar for the contest supervisor.
 *
 * Each `agent/pre-step` writes `<cwd>/.fgs/dsh_step_count` as one integer.
 * The supervisor reads that file and does not inspect the DSH session.
 * Missing or unreadable file = no step retire (fail-open).
 *
 * `n` counts plugin pre-step calls in this cwd. It is not DSH session
 * `pagination.total` (that total also counts system, user, assistant, and
 * tool_result events). A solve near 40–50 session events is usually fewer
 * pre-steps; a long stall still crosses a pre-step cap later than the same
 * number of session events.
 */

import fs from 'node:fs';
import path from 'node:path';

export const STEP_COUNT_FILE = '.fgs/dsh_step_count';

export function stepCountPath(cwd) {
  return path.join(cwd, STEP_COUNT_FILE);
}

export function readStepCount(cwd) {
  if (!cwd) return null;
  try {
    const raw = fs.readFileSync(stepCountPath(cwd), 'utf8').trim().split(/\s+/)[0];
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  } catch {
    return null;
  }
}

export function bumpStepCount(cwd) {
  if (!cwd) return null;
  const file = stepCountPath(cwd);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = readStepCount(cwd);
    const next = (current == null ? 0 : current) + 1;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${next}\n`);
    fs.renameSync(tmp, file);
    return next;
  } catch {
    return null;
  }
}

function cwdOf(agent) {
  return agent?.cwd
    || agent?.session?.header?.cwd
    || agent?.session?.cwd
    || process.cwd();
}

export function applyStepCount(ctx) {
  if (typeof ctx?.on !== 'function') return () => {};
  const dispose = ctx.on('agent/pre-step', async (payload, next) => {
    try {
      bumpStepCount(cwdOf(payload?.agent));
    } catch {
      /* counting must not block the step */
    }
    if (typeof next === 'function') return next();
    return { kind: 'enter', messages: payload?.messages || [] };
  });
  return typeof dispose === 'function' ? dispose : () => {};
}
