/**
 * Host bundle: bash stays in dsh-base. These three names are the Solver brief.
 * benchmark_submit_flag posts straight at Challenges. It does not call
 * fgs_satisfy_goal or the satisfy hook.
 */
import {
  getProgress,
  recordObservation,
  resolveUniqueCode,
  submitFlag,
} from './api.js';

export const name = 'contest-benchmark-tools';
export const inject = ['tools'];

function text(value) {
  return [{ type: 'text', text: String(value) }];
}

function jsonResult(payload) {
  return { text: JSON.stringify(payload) };
}

function defineTool({ toolName, description, parameters, run }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        additionalProperties: true,
      },
      render: (_args, value) => text(value?.text ?? ''),
    },
    async execute(args, exec) {
      return run(args ?? {}, exec);
    },
  };
}

function cwdOf(exec) {
  return exec?.cwd
    || exec?.agent?.cwd
    || exec?.session?.cwd
    || process.cwd();
}

export function apply(ctx) {
  const disposers = [];
  const register = (definition) => {
    const dispose = ctx.tools.register(definition);
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  register(defineTool({
    toolName: 'benchmark_get_progress',
    description: '读取本题平台进度。返回 unique_code、difficulty、total_score、flag_count、total_flag_count、correct_flag_count、container_addr、is_completed。默认本题，不要拿它查别的题。',
    parameters: {
      type: 'object',
      properties: {
        unique_code: { type: 'string', description: '省略则用本题 FGS_UNIQUE_CODE。' },
      },
      additionalProperties: false,
    },
    run: async (args, exec) => {
      const cwd = cwdOf(exec);
      const bound = resolveUniqueCode({ explicit: args.unique_code, cwd });
      const payload = await getProgress({ uniqueCode: bound.uniqueCode, cwd });
      return jsonResult({ ...payload, source: bound.source || undefined });
    },
  }));

  register(defineTool({
    toolName: 'benchmark_submit_flag',
    description: '把刚刚命令输出里逐字看到的 flag 提交到平台。返回 JSON 含 correct: true/false。不要猜 flag。这是一跳提交，不经过 fgs_satisfy_goal。',
    parameters: {
      type: 'object',
      properties: {
        flag: { type: 'string', description: '命令输出中的 flag 原文。' },
        unique_code: { type: 'string', description: '省略则用本题 FGS_UNIQUE_CODE。' },
      },
      required: ['flag'],
      additionalProperties: false,
    },
    run: async (args, exec) => {
      const cwd = cwdOf(exec);
      const bound = resolveUniqueCode({ explicit: args.unique_code, cwd });
      const payload = await submitFlag({
        flag: args.flag,
        uniqueCode: bound.uniqueCode,
        cwd,
      });
      const line = `[submit] ${payload.unique_code || bound.uniqueCode || '?'} ${args.flag} -> ${payload.correct ? 'ACCEPT' : 'REJECT'}`;
      process.stderr.write(`${line}\n`);
      return jsonResult({ ...payload, source: bound.source || undefined });
    },
  }));

  register(defineTool({
    toolName: 'record_observation',
    description: '把关键发现、失败尝试或 flag 证据追加到工作目录 .fgs/observations.jsonl。',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '短记录。' },
      },
      required: ['note'],
      additionalProperties: false,
    },
    run: async (args, exec) => jsonResult(recordObservation({ cwd: cwdOf(exec), note: args.note })),
  }));

  return () => {
    for (const dispose of disposers) dispose();
  };
}
