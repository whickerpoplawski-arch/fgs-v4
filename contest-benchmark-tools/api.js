/**
 * Challenges progress + submit used by benchmark_* tools.
 *
 * Submit matches tools/submit_flag.mjs: POST {prefix}/challenges/submit
 * with { unique_code, flag }. 200/201 and 409 (already correct) are correct.
 * BENCHMARK_BASE_URL is used as injected. This module does not rewrite it.
 *
 * unique_code resolution never reads BENCHMARK_UNIQUE_CODE. That name is a
 * global alias the upload page must not set. The driver binds FGS_UNIQUE_CODE
 * on the worker, and the workspace meta file is only a fallback.
 */

import fs from 'node:fs';
import path from 'node:path';

export const SUBMIT_SUFFIX = '/challenges/submit';

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function platformBase(env = process.env) {
  return trimSlash(env.BENCHMARK_BASE_URL || env.PLATFORM_BASE_URL || '');
}

export function platformToken(env = process.env) {
  return String(env.BENCHMARK_TOKEN || '').trim();
}

export function apiPrefixes(env = process.env) {
  const explicit = String(env.BENCHMARK_API_PREFIX || '').trim();
  if (explicit) {
    const withSlash = explicit.startsWith('/') ? explicit : `/${explicit}`;
    return [trimSlash(withSlash)];
  }
  return ['/api/v1', '/openapi/v1'];
}

export function readChallengeMeta(cwd) {
  if (!cwd) return null;
  const file = path.join(cwd, '.contest', 'challenge.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @returns {{ uniqueCode: string, source: string }}
 * source is argument | FGS_UNIQUE_CODE | workspace | ''
 */
export function resolveUniqueCode({ explicit, cwd, env = process.env } = {}) {
  const fromArg = String(explicit || '').trim();
  if (fromArg) return { uniqueCode: fromArg, source: 'argument' };
  const fromEnv = String(env.FGS_UNIQUE_CODE || '').trim();
  if (fromEnv) return { uniqueCode: fromEnv, source: 'FGS_UNIQUE_CODE' };
  const meta = readChallengeMeta(cwd);
  const fromMeta = String(meta?.unique_code || '').trim();
  if (fromMeta) return { uniqueCode: fromMeta, source: 'workspace' };
  return { uniqueCode: '', source: '' };
}

function prefixesFor(cwd, env) {
  const meta = readChallengeMeta(cwd);
  const pinned = String(meta?.api_prefix || '').trim();
  if (pinned) {
    const withSlash = pinned.startsWith('/') ? pinned : `/${pinned}`;
    return [trimSlash(withSlash)];
  }
  return apiPrefixes(env);
}

function authHeaders(token) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-benchmark-token': token,
    BENCHMARK_TOKEN: token,
  };
}

async function callJson(fetchImpl, url, token, method, body) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: authHeaders(token),
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { ok: false, status: 0, payload: null, error: error?.message || String(error) };
  }
  const text = await response.text().catch(() => '');
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 200) };
    }
  } else {
    payload = {};
  }
  return { ok: response.ok, status: response.status, payload, error: '' };
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['challenges', 'data', 'items', 'results']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    if (payload.unique_code || payload.challenge) {
      return [payload.challenge && typeof payload.challenge === 'object' ? payload.challenge : payload];
    }
  }
  return [];
}

function matchCode(item, uniqueCode) {
  if (!item || typeof item !== 'object') return false;
  const code = String(item.unique_code || item.code || '').trim();
  return code === uniqueCode || code.toLowerCase() === uniqueCode.toLowerCase();
}

export function normalizeProgress(raw, fallback = {}) {
  const wanted = String(fallback.unique_code || '').trim();
  const rows = asList(raw);
  const item = rows.find((row) => matchCode(row, wanted)) || (rows.length === 1 ? rows[0] : null) || {};
  const flagCount = item.total_flag_count ?? item.flag_count ?? fallback.flag_count ?? null;
  const addr = item.container_addr ?? item.containerAddr ?? fallback.container_addr ?? null;
  return {
    unique_code: item.unique_code || item.code || fallback.unique_code || '',
    difficulty: item.difficulty ?? fallback.difficulty ?? 'unknown',
    level: item.level ?? item.difficulty_level ?? fallback.level ?? 'unknown',
    total_score: item.total_score ?? item.score ?? fallback.total_score ?? null,
    flag_count: item.flag_count ?? flagCount,
    total_flag_count: item.total_flag_count ?? flagCount,
    correct_flag_count: item.correct_flag_count ?? 0,
    container_addr: addr,
    is_completed: Boolean(item.is_completed ?? item.completed ?? false),
  };
}

export async function getProgress({ uniqueCode, cwd, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = platformBase(env);
  const token = platformToken(env);
  if (!uniqueCode) {
    return { error: '缺 unique_code（本题 FGS_UNIQUE_CODE 或参数 unique_code）' };
  }
  if (!base) return { error: '缺 BENCHMARK_BASE_URL', unique_code: uniqueCode };
  if (!token) return { error: '缺 BENCHMARK_TOKEN', unique_code: uniqueCode };
  const meta = readChallengeMeta(cwd) || {};
  const fallback = {
    unique_code: uniqueCode,
    difficulty: meta.difficulty,
    level: meta.level,
    total_score: meta.total_score,
    flag_count: meta.flag_count ?? meta.total_flag_count,
    container_addr: meta.container_addr,
  };
  const errors = [];
  for (const prefix of prefixesFor(cwd, env)) {
    const progressUrl = `${base}${prefix}/challenges/progress?unique_code=${encodeURIComponent(uniqueCode)}`;
    const progress = await callJson(fetchImpl, progressUrl, token, 'GET');
    if (progress.status && progress.status !== 404 && progress.status !== 405) {
      if (!progress.ok) {
        return {
          error: `progress HTTP ${progress.status}`,
          unique_code: uniqueCode,
        };
      }
      return normalizeProgress(progress.payload, fallback);
    }
    if (progress.error) errors.push(`${prefix} progress: ${progress.error}`);
    const listUrl = `${base}${prefix}/challenges`;
    const listed = await callJson(fetchImpl, listUrl, token, 'GET');
    if (listed.ok) {
      const rows = asList(listed.payload);
      const hit = rows.find((row) => matchCode(row, uniqueCode));
      if (!hit) {
        return { error: `list 中没有 ${uniqueCode}`, unique_code: uniqueCode };
      }
      return normalizeProgress(hit, fallback);
    }
    if (listed.error) errors.push(`${prefix} list: ${listed.error}`);
    else errors.push(`${prefix} list HTTP ${listed.status}`);
  }
  return { error: errors.join(' | ') || 'progress 失败', unique_code: uniqueCode };
}

export async function submitFlag({ flag, uniqueCode, cwd, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const trimmed = String(flag || '').trim();
  if (!trimmed) {
    return { correct: false, error: '缺 flag', unique_code: uniqueCode || '' };
  }
  if (!uniqueCode) {
    return { correct: false, error: '缺 unique_code（不使用 BENCHMARK_UNIQUE_CODE）', flag: trimmed };
  }
  const base = platformBase(env);
  const token = platformToken(env);
  if (!base) return { correct: false, error: '缺 BENCHMARK_BASE_URL', unique_code: uniqueCode };
  if (!token) return { correct: false, error: '缺 BENCHMARK_TOKEN', unique_code: uniqueCode };
  const errors = [];
  for (const prefix of prefixesFor(cwd, env)) {
    const url = `${base}${prefix}${SUBMIT_SUFFIX}`;
    const result = await callJson(fetchImpl, url, token, 'POST', {
      unique_code: uniqueCode,
      flag: trimmed,
    });
    if (result.error && result.status === 0) {
      errors.push(`${url}: ${result.error}`);
      continue;
    }
    if (result.status === 404 || result.status === 405) {
      errors.push(`${url}: HTTP ${result.status}`);
      continue;
    }
    const correct = result.ok || result.status === 409;
    const note = result.status === 409 ? '409 duplicate' : `HTTP ${result.status}`;
    return {
      correct,
      status: result.status,
      unique_code: uniqueCode,
      note,
      url,
    };
  }
  return {
    correct: false,
    unique_code: uniqueCode,
    error: errors.join(' | ') || 'submit 失败',
  };
}

export function recordObservation({ cwd, note }) {
  const text = String(note || '').trim();
  if (!text) return { ok: false, error: 'note 为空' };
  const root = cwd || process.cwd();
  const dir = path.join(root, '.fgs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'observations.jsonl');
  const row = { at: new Date().toISOString(), note: text };
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return { ok: true, path: file };
}
