/**
 * Baseline 轻约束：每步 pre-step 注入短契约（L1）、环打断（L2）、可选三锚（L3）。
 *
 * 不是新 tool。保证口径：Cordis `agent/pre-step` 在 next() 之后把 sourced
 * user message append 进 enter batch，因此必进本步 admitted request。
 * 不 inject `agents`：事件在 Context 上，agent 来自 payload；保持
 * `inject: ['tools']`，避免和 FGS contest profile 抢 agents 依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { recordObservation } from './api.js';

export const PLUGIN_ID = 'contest-benchmark-tools';
/** Format v4 producer-owned kind. Literal `plugin` is rejected at admission. */
export const PLUGIN_SOURCE_KIND = `plugin:${PLUGIN_ID}`;
export const STATE_FILE = '.fgs/light_constraint_state.json';

export const L1_CONTRACT =
  '【轻约束】工具前可见文字≤2句（假设+下一步）。第2句后立刻 tool_call，或无文字直接工具。禁止复述同一结论/writeup。收尾或「本题结束」除外。';
export const L2_BREAK =
  '【环打断】你已连续重复相近步骤。换攻击面或脚本化；用 record_observation 记已排除路径。';
export const L3_ANCHORS =
  '【锚】回顾：上一工具结果一句话。收敛：本步唯一动作。反跑题：不写讲义。';

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);
const TITLE_HINT = /generate the session title/i;
const NOTES_BUDGET = 400;
const TEXT_BUDGET = 200;
const SIMILARITY = 0.8;
const SKIP_TOOL_FPS = new Set(['record_observation']);

export function envFlag(name, defaultValue = true, env = process.env) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return defaultValue;
  const text = String(raw).trim().toLowerCase();
  if (TRUE.has(text)) return true;
  if (FALSE.has(text)) return false;
  return defaultValue;
}

export function envInt(name, defaultValue, env = process.env, { min = 1 } = {}) {
  const raw = String(env[name] ?? '').trim();
  if (!raw) return defaultValue;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return defaultValue;
  return Math.max(min, value);
}

export function readLightConstraintConfig(env = process.env) {
  const enabled = envFlag('CONTEST_LIGHT_CONSTRAINT', true, env);
  return {
    enabled,
    notes: enabled && envFlag('CONTEST_LIGHT_NOTES', true, env),
    loopBreak: enabled && envFlag('CONTEST_LIGHT_LOOP_BREAK', true, env),
    loopN: envInt('CONTEST_LIGHT_LOOP_N', 3, env, { min: 2 }),
    anchors: enabled && envFlag('CONTEST_LIGHT_ANCHORS', true, env),
  };
}

export function normalizeText(value, budget = TEXT_BUDGET) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, budget)
    .toLowerCase();
}

export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block && block.type === 'text') return block.text || '';
      return '';
    })
    .join('');
}

export function fingerprintText(value, kind = 't') {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  return `${kind}:${normalized}`;
}

function tokens(normalized) {
  const body = String(normalized).replace(/^[tb]:/, '');
  return new Set(body.split(/[\s/\\=:,;|+'"`()._-]+/).filter((part) => part.length > 1));
}

function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let inter = 0;
  for (const item of left) {
    if (right.has(item)) inter += 1;
  }
  const union = left.size + right.size - inter;
  return union === 0 ? 1 : inter / union;
}

function levenshteinRatio(a, b) {
  if (a === b) return 1;
  const left = a.slice(0, TEXT_BUDGET);
  const right = b.slice(0, TEXT_BUDGET);
  if (!left.length && !right.length) return 1;
  const rows = left.length + 1;
  const cols = right.length + 1;
  const prev = new Array(cols);
  const cur = new Array(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i < rows; i += 1) {
    cur[0] = i;
    const ca = left.charCodeAt(i - 1);
    for (let j = 1; j < cols; j += 1) {
      const cost = ca === right.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < cols; j += 1) prev[j] = cur[j];
  }
  const dist = prev[cols - 1];
  return 1 - dist / Math.max(left.length, right.length);
}

export function similarFingerprints(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a[0] !== b[0]) return false;
  const bodyA = a.slice(2);
  const bodyB = b.slice(2);
  if (!bodyA || !bodyB) return false;
  if (jaccard(tokens(bodyA), tokens(bodyB)) >= SIMILARITY) return true;
  return levenshteinRatio(bodyA, bodyB) >= SIMILARITY;
}

export function shouldBreak(history, n = 3) {
  const window = Array.isArray(history) ? history.slice(-n) : [];
  if (window.length < n) return false;
  const first = window[0];
  return window.every((fp) => similarFingerprints(fp, first));
}

export function observeFingerprint(history, fingerprint, n = 3) {
  const next = Array.isArray(history) ? [...history] : [];
  if (fingerprint) next.push(fingerprint);
  return {
    history: next.slice(-(n + 2)),
    looping: shouldBreak(next, n),
  };
}

export function readNotesExcerpt(cwd, budget = NOTES_BUDGET) {
  if (!cwd) return '';
  const candidates = [
    path.join(cwd, 'NOTES.md'),
    path.join(cwd, '.fgs', 'notes.md'),
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw) return raw.slice(-budget);
    } catch {
      /* missing is fine */
    }
  }
  try {
    const raw = fs.readFileSync(path.join(cwd, '.fgs', 'observations.jsonl'), 'utf8').trim();
    if (!raw) return '';
    const notes = raw
      .split('\n')
      .slice(-5)
      .map((line) => {
        try {
          return String(JSON.parse(line).note || '').trim();
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    return notes.join('；').slice(-budget);
  } catch {
    return '';
  }
}

export function buildInjectText({
  notes = true,
  loopBreak = false,
  anchors = true,
  notesExcerpt = '',
} = {}) {
  const lines = [];
  if (notes) lines.push(L1_CONTRACT);
  if (loopBreak) lines.push(L2_BREAK);
  if (anchors) lines.push(L3_ANCHORS);
  if (notes && notesExcerpt) {
    const excerpt = String(notesExcerpt).replace(/\s+/g, ' ').trim().slice(-NOTES_BUDGET);
    if (excerpt) lines.push(`【NOTES】${excerpt}`);
  }
  return lines.join('\n');
}

export function createPluginUserMessage(text, { summary } = {}) {
  const body = String(text || '');
  const source = {
    kind: PLUGIN_SOURCE_KIND,
    form: 'notice',
    summary: String(summary || '轻约束').slice(0, 120),
  };
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: body }],
    source,
  };
}

export function cwdOfAgent(agent, fallback = process.cwd()) {
  return agent?.cwd
    || agent?.session?.header?.cwd
    || agent?.session?.cwd
    || fallback;
}

function sessionEvents(agent) {
  const session = agent?.session;
  if (!session) return [];
  if (typeof session.snapshotEvents === 'function') {
    try {
      return [...(session.snapshotEvents() || [])];
    } catch {
      return [];
    }
  }
  if (Array.isArray(session.events)) return session.events;
  return [];
}

export function lastAssistantText(agent) {
  const events = sessionEvents(agent);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const type = event?.type || event?.kind;
    if (type !== 'assistant/message' && type !== 'assistant/attempt') continue;
    const data = event.data || event;
    const content = data.content
      || data.message?.content
      || data.payload?.content
      || [];
    const text = extractText(content);
    if (text.trim()) return text;
  }
  return '';
}

function emptyState() {
  return {
    assistant: [],
    bash: [],
    pendingBreak: false,
    recordedBreak: false,
  };
}

export function statePath(cwd) {
  return path.join(cwd, STATE_FILE);
}

export function loadState(cwd) {
  if (!cwd) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(cwd), 'utf8'));
    return {
      ...emptyState(),
      ...parsed,
      assistant: Array.isArray(parsed.assistant) ? parsed.assistant : [],
      bash: Array.isArray(parsed.bash) ? parsed.bash : [],
    };
  } catch {
    return emptyState();
  }
}

export function saveState(cwd, state) {
  if (!cwd) return;
  const dir = path.join(cwd, '.fgs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(cwd), `${JSON.stringify(state)}\n`, 'utf8');
}

function alreadyInjected(messages) {
  return (messages || []).some((message) => {
    const kind = message?.source?.kind;
    return kind === PLUGIN_SOURCE_KIND
      || message?.source?.plugin === PLUGIN_ID
      || (kind === 'plugin' && extractText(message.content).includes('【轻约束】'));
  });
}

function claimedLooksLikeTitle(messages) {
  const text = (messages || []).map((message) => extractText(message?.content)).join('\n');
  return TITLE_HINT.test(text);
}

function toolName(exec) {
  return String(exec?.name || exec?.toolName || exec?.tool || '').trim();
}

function toolCommand(exec) {
  const args = exec?.arguments || exec?.args || {};
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
  if (typeof args.script === 'string') return args.script;
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

function recordLoopObservation(cwd, note) {
  try {
    recordObservation({ cwd, note });
  } catch {
    /* never fail the agent loop */
  }
}

async function decide(next, fallback) {
  if (typeof next === 'function') return next();
  return fallback;
}

/**
 * Subscribe to pre-step / post-execute. No-op when the master kill switch is off
 * or the host has no event bus (unit tests that only register tools).
 */
export function applyLightConstraint(ctx, { env = process.env } = {}) {
  const cfg = readLightConstraintConfig(env);
  if (!cfg.enabled) return () => {};
  if (typeof ctx?.on !== 'function') return () => {};
  if (!cfg.notes && !cfg.loopBreak && !cfg.anchors) return () => {};

  const disposers = [];
  const hold = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  hold(ctx.on('agent/pre-step', async (payload, next) => {
    const fallback = { kind: 'enter', messages: payload?.messages || [] };
    let decision;
    try {
      decision = await decide(next, fallback);
    } catch (error) {
      throw error;
    }
    if (!decision || decision.kind === 'reject') return decision;
    try {
      const agent = payload?.agent;
      const messages = Array.isArray(decision.messages)
        ? decision.messages
        : (payload?.messages || []);
      if (claimedLooksLikeTitle(messages) || alreadyInjected(messages)) {
        return { kind: 'enter', messages };
      }
      const cwd = cwdOfAgent(agent);
      const state = loadState(cwd);
      if (cfg.loopBreak) {
        const assistantFp = fingerprintText(lastAssistantText(agent), 't');
        const observed = observeFingerprint(state.assistant, assistantFp, cfg.loopN);
        state.assistant = observed.history;
        const looping = observed.looping || shouldBreak(state.bash, cfg.loopN) || state.pendingBreak;
        state.pendingBreak = looping;
        if (looping && !state.recordedBreak) {
          recordLoopObservation(cwd, '轻约束环打断：连续重复相近步骤，已提示换攻击面。');
          state.recordedBreak = true;
        }
        if (!looping) state.recordedBreak = false;
      }
      const text = buildInjectText({
        notes: cfg.notes,
        loopBreak: cfg.loopBreak && state.pendingBreak,
        anchors: cfg.anchors,
        notesExcerpt: cfg.notes ? readNotesExcerpt(cwd) : '',
      });
      if (cfg.loopBreak) {
        state.pendingBreak = false;
        saveState(cwd, state);
      }
      if (!text) return { kind: 'enter', messages };
      const injected = createPluginUserMessage(text, {
        summary: text.includes('【环打断】') ? '环打断' : '轻约束',
      });
      return { kind: 'enter', messages: [...messages, injected] };
    } catch {
      return decision;
    }
  }));

  if (cfg.loopBreak) {
    hold(ctx.on('tools/post-execute', async (exec, result, next) => {
      const nextFn = typeof result === 'function' ? result : next;
      let decision;
      try {
        decision = await decide(nextFn, { kind: 'accept' });
      } catch (error) {
        throw error;
      }
      try {
        const call = exec && typeof exec === 'object' ? exec : {};
        const name = toolName(call);
        if (name && !SKIP_TOOL_FPS.has(name)) {
          const cwd = call.cwd || cwdOfAgent(call.agent);
          const state = loadState(cwd);
          const fp = fingerprintText(`${name} ${toolCommand(call)}`, 'b');
          const observed = observeFingerprint(state.bash, fp, cfg.loopN);
          state.bash = observed.history;
          if (observed.looping) state.pendingBreak = true;
          saveState(cwd, state);
        }
      } catch {
        /* fingerprinting must not block the tool waterfall */
      }
      return decision;
    }));
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}
