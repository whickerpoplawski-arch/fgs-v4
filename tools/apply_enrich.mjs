#!/usr/bin/env node
/**
 * 把 fail_graph 的补图载荷写进已经种过的 FGS 图。
 *
 * 只走 Controller：open_step + submit_fact 记下 baseline 事实，再留一条未认领的
 * open step 给 Execute。不新造图格式。重复调用看标题和 open step，不叠第二份。
 *
 *   node tools/apply_enrich.mjs --cwd <dir> --problem-id <id> --payload <file>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Controller, GraphStore } from '../controller/index.js';
import { openStepOp, submitFactOp } from '../controller/ops.js';
import { ProjectRegistry } from '../controller/projects.js';

export class EnrichError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnrichError';
  }
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function readPayload(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new EnrichError(`无法读取 enrich payload ${filePath}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EnrichError('enrich payload 必须是对象');
  }
  return parsed;
}

/**
 * @param {{ cwd: string, problemId: string, payload: object, stateDir?: string }} options
 */
export function applyEnrich(options = {}) {
  const cwd = options.cwd;
  if (!hasText(cwd)) throw new EnrichError('缺 cwd');
  const root = path.resolve(cwd);
  const payload = options.payload;
  if (!payload || typeof payload !== 'object') throw new EnrichError('缺 payload');
  if (payload.empty || !Array.isArray(payload.facts) || payload.facts.length === 0) {
    return { ok: true, status: 'empty', facts: 0, intent: false, cwd: root };
  }

  const stateDir = options.stateDir ?? '.fgs';
  const registry = new ProjectRegistry(path.join(root, stateDir));
  const problemId = registry.normalizeId(options.problemId);
  if (!registry.isValidId(problemId)) throw new EnrichError(`problemId 非法: ${options.problemId}`);
  if (!registry.exists(problemId)) throw new EnrichError(`尚未种题: ${problemId}`);

  const store = new GraphStore(registry.projectRoot(problemId));
  const controller = new Controller(store);
  let graph;
  try {
    graph = store.load();
  } catch (error) {
    throw new EnrichError(`无法读取图: ${error.message}`);
  }
  if (!(graph.facts ?? []).some((fact) => fact.id === 'fact_origin')) {
    throw new EnrichError('图上没有 fact_origin，拒绝补图');
  }

  const markerPath = path.join(root, stateDir, 'enrich-applied.json');
  if (fs.existsSync(markerPath)) {
    return {
      ok: true,
      status: 'already-enriched',
      facts: (payload.facts ?? []).length,
      intent: Boolean(payload.intent?.action),
      cwd: root,
      graphPath: store.graphPath,
    };
  }

  let cursor = 'fact_origin';
  let wrote = 0;
  for (const fact of payload.facts) {
    const title = hasText(fact?.title) ? String(fact.title).trim() : '';
    const content = fact?.content == null ? '' : String(fact.content);
    if (!title) continue;
    const existing = (graph.facts ?? []).find((item) => item.title === title);
    if (existing) {
      cursor = existing.id;
      continue;
    }
    const kind = fact.kind === 'excluded' ? 'excluded' : (fact.kind === 'verified' ? 'verified' : null);
    graph = controller.apply(openStepOp({
      action: `记录 baseline：${title}`.slice(0, 180),
      from: [cursor],
      actor: 'agent',
      priority: 'normal',
    }), graph);
    const step = graph.steps[graph.steps.length - 1];
    graph = controller.apply(submitFactOp({
      title,
      content,
      producedBy: step.id,
      ...(kind ? { findingType: kind } : {}),
    }), graph);
    cursor = graph.facts[graph.facts.length - 1].id;
    wrote += 1;
  }

  const action = hasText(payload.intent?.action) ? String(payload.intent.action).trim() : '';
  let intent = false;
  if (action) {
    const priority = payload.intent?.priority === 'low' || payload.intent?.priority === 'normal'
      ? payload.intent.priority
      : 'high';
    const already = (graph.steps ?? []).some((step) => step.state === 'open' && step.action === action);
    if (!already) {
      graph = controller.apply(openStepOp({
        action,
        from: [cursor],
        actor: 'agent',
        priority,
      }), graph);
      intent = true;
    }
  }

  if (wrote > 0 || intent) {
    controller.commit(graph);
  }
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify({
    at: new Date().toISOString(),
    facts: wrote,
    intent,
  })}\n`);
  return {
    ok: true,
    status: wrote > 0 || intent ? 'enriched' : 'empty',
    facts: wrote,
    intent,
    cwd: root,
    graphPath: store.graphPath,
  };
}

function parseArgs(argv) {
  const out = {};
  const args = argv.slice(2);
  const take = (flag, index) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new EnrichError(`缺少参数值: ${flag}`);
    }
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--cwd':
        out.cwd = take(arg, i);
        i += 1;
        break;
      case '--problem-id':
      case '--problemId':
        out.problemId = take(arg, i);
        i += 1;
        break;
      case '--payload':
        out.payload = take(arg, i);
        i += 1;
        break;
      default:
        throw new EnrichError(`未知参数: ${arg}`);
    }
  }
  return out;
}

function main() {
  try {
    const args = parseArgs(process.argv);
    if (args.help) {
      process.stdout.write('apply_enrich — 把 baseline 补图载荷写入已种的 FGS 图\n');
      return;
    }
    if (!args.payload) throw new EnrichError('缺 --payload');
    const result = applyEnrich({
      cwd: args.cwd,
      problemId: args.problemId,
      payload: readPayload(args.payload),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error?.message ?? String(error);
    process.stderr.write(`apply_enrich: ${message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exit(1);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();
