# TSecBench 上传页环境变量（托管 Agent）

**计分（推荐 `CONTEST_FGS_MODE=on_fail`）：**

- 新题一直用 profile `contest-baseline`：无 FGS，`benchmark_submit_flag` 一跳 `POST /openapi/v1/challenges/submit`（list 探到的前缀优先）。墙钟 `CONTEST_FGS_AFTER_SEC` **不**改变这一点。
- 只有该题被窄定义判定为失败后，才进入 FIFO 重试队列。新题吃完（`CONTEST_FGS_RETRY_LAST=1`）时，按失败时间从早到晚给它开 **第二遍** profile `contest`：挂 `@local/fgs-deepseek-dsh`，预种图，并用 baseline 产物补 Fact / Intent。插件仍是 `verifyMode: command`（`submit_flag.mjs`）。同一 profile 也有 `benchmark_*`。
- 已经在跑的 baseline worker **不会**热挂载 FGS，也 **不会**为了换 profile 被杀掉。FGS 只作用在新拉起的那一个失败题进程上。
- 二遍如果平台上该题容器还是 active 且地址还在，就复用；reap 已经 close 掉的话会再 `start`。
- regex 只认形态不计分，禁止上赛场。
- `CONTEST_FGS_MODE=after_sec` 是旧的墙钟兼容：到点后**新** worker 用 `contest`，失败题不重试。`off` 永不 FGS。上传不要用这两档，除非明确要退回 PR#12。

**稳定性：** tip 含 PR#11 —— Challenges `close`/`list`/`start` 超时或断连只记日志、不崩 driver 主循环。

**协议：** stock DeepSeek Messages。`agent-default-model` 指向 `deepseek-official` / `deepseek-flash`。`llm-deepseek.baseURL` 为 `https://api.deepseek.com/anthropic`（客户端再拼 `/v1/messages`）。会话记录里的协议名是 `anthropic_messages`。

**不要**在 `llm-pi-ai` 里再次声明 `deepseek-official`，更不要把它 patch 成 `openai-completions`。该 id 已是内置 Messages，再声明会被丢掉（`already declared`），请求仍走 Messages；配上 chat `/v1` 根路径就是 HTTP 404，worker 秒死、SCORE 不动。若必须走 completions，另用唯一 id `deepseek-contest`，本镜像默认不走这条。

`SOLVER_GATEWAY=1` 只改写**模型** baseURL：`https://api.deepseek.com/anthropic` → `http://api.deepseek.com.tsecbench.gw/anthropic`。`BENCHMARK_BASE_URL` / `BENCHMARK_TOKEN` **永不改写**。

权限：`DSH_PERMISSION_MODE=danger-full-access`，profile 里 `sandbox-policy.mode=danger-full-access`、`approval.policy=never`。上传页不必再填。

---

## 上传页必须填

```bash
DEEPSEEK_API_KEY=<你的 DeepSeek API Key>
SOLVER_GATEWAY=1
```

## 建议显式再写（防平台清空未声明变量）

```bash
DEEPSEEK_API_KEY=<你的 DeepSeek API Key>
SOLVER_GATEWAY=1
CONTEST_SUPERVISOR=1
CONTEST_DSH_LAUNCH=1
CONTEST_DSH_PROFILE=contest-baseline
CONTEST_DSH_PROFILE_FGS=contest
CONTEST_FGS_MODE=on_fail
CONTEST_FGS_RETRY_LAST=1
CONTEST_FGS_MAX_ACTIVE=1
CONTEST_FGS_MAX_RETRIES=1
CONTEST_RETIRE_GRACE=60
CONTEST_RETIRE_GRACE_SOLVED=30
CONTEST_SUPERVISOR_INTERVAL=20
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
```

镜像 Dockerfile 已内置同名默认（除 `DEEPSEEK_API_KEY` 与 `SOLVER_GATEWAY`）。`DEEPSEEK_BASE_URL` 必须是 Messages 根 `/anthropic`，不要写成 `https://api.deepseek.com/v1`。

---

## 环境变量

| Knob | 默认 | 谁读 | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | （上传页） | Messages 适配器 | 必填。不要烤进镜像 |
| `SOLVER_GATEWAY` | 上传页填 `1` | driver 改写 | 只改模型 baseURL |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | 改写 / 适配器 | chat `/v1` 根在 Messages 上会 404 |
| `BENCHMARK_BASE_URL` | 平台注入 | submit / progress / list | **永不改写**。上传页不填 |
| `BENCHMARK_TOKEN` | 平台注入 | 同上 | 上传页不填 |
| `CONTEST_DSH_LAUNCH` | `1` | `solver_argv` | |
| `CONTEST_DSH_PROFILE` | `contest-baseline` | 一遍 / 新题 | 无 FGS |
| `CONTEST_DSH_PROFILE_FGS` | `contest` | 失败后的二遍 | 有 FGS。不改已经在跑的 worker |
| `CONTEST_FGS_MODE` | `on_fail` | 调度 | `on_fail`：失败才 FGS（推荐）。`after_sec`：旧墙钟，不重试。`off`：永不 FGS |
| `CONTEST_FGS_AFTER_SEC` | `7200` | 仅 `mode=after_sec` | 从 **driver 进程启动**起算。`on_fail` / `off` **忽略**这个值。`0` = 立刻全用 FGS profile。`<0` 或 `off` / `never` / `false` / `no` = 一直 baseline |
| `CONTEST_FGS_RETRY_LAST` | `1` | 二遍优先级 | `1`：还有未开的新题时绝不跑 FGS。`0`：允许和该 tick 的新题并行，仍受 `CONTEST_FGS_MAX_ACTIVE` |
| `CONTEST_FGS_MAX_ACTIVE` | `1` | 二遍并发 | 同时活着的 FGS worker 上限 |
| `CONTEST_FGS_MAX_RETRIES` | `1` | 每题二遍次数 | 达到后写 `queue/fgs_done/<code>`，不再派 |
| `CONTEST_FAIL_ON_BUDGET` | `0` | 可选超时 | `1` 时，活着的 worker 超过 Solver 预算仍未通关会被 retire 并入队。默认关，慢但还在跑不算失败 |
| `CONTEST_SKIP_FGS_SEED` | `auto` | visit | baseline 跳过预种；FGS profile 仍预种，并在二遍补图 |
| `CONTEST_CHALLENGE_BUDGET_MIN` | `60` | Solver 任务书 | 平台没有时间字段时的分钟数 |
| `CONTEST_DSH_BIN` | `dsh` | which | |
| `CONTEST_WORKER_CMD` | 空 | 整条 launch | 测试用。正式赛不要设 |
| `CONTEST_SUPERVISOR` | `1` | driver | |
| `CONTEST_MAX_ACTIVE` | `3` | 并发 | |
| `CONTEST_RETIRE_GRACE` | `60` | supervisor | |
| `CONTEST_RETIRE_GRACE_SOLVED` | `30` | supervisor | 仅平台通关后的短宽限 |
| `CONTEST_SUPERVISOR_INTERVAL` | `20` | supervisor | |
| `DSH_PERMISSION_MODE` | `danger-full-access` | dsh-base | 上传页通常不填 |
| `FGS_UNIQUE_CODE` | 每 worker | submit | **禁止上传页全局**。driver 按题覆盖子进程 |
| `CONTEST_DSH_PROFILE_DIR` | 空 | 改写根 | 测试用 |

`benchmark_submit_flag` / `benchmark_get_progress` 用子进程里的 `FGS_UNIQUE_CODE`，其次才是本题工作目录 `.contest/challenge.json`。它们不读 `BENCHMARK_UNIQUE_CODE`。

---

## 上传页不要填

| 变量 | 原因 |
|---|---|
| `BENCHMARK_TOKEN` | 平台运行时注入 |
| `BENCHMARK_BASE_URL` | 平台运行时注入 |
| 全局 `FGS_UNIQUE_CODE` | 会绑错题 |
| `BENCHMARK_UNIQUE_CODE` | 同上，工具故意不读它 |
| 其它 LLM key | 只用 `DEEPSEEK_API_KEY` |
| `DEEPSEEK_BASE_URL=https://api.deepseek.com/v1` | Messages 根不是 chat `/v1`，会 404 |

镜像层内没有 `DEEPSEEK_API_KEY` / `BENCHMARK_*`。

---

## 上传后日志

1. 容器自行 list → start →（baseline 跳过预种）→ `dsh --profile contest-baseline`
2. 应见 `dsh profile select: pass=first … FGS_AFTER=ignored mode=on_fail → contest-baseline (FGS off)`。跑过 7200 秒也一样，只要这题还是一遍
3. 应见 `rewrote DEEPSEEK_BASE_URL … .tsecbench.gw/anthropic` 与 `BENCHMARK_BASE_URL unchanged`
4. **不应**出现 `configurable provider "deepseek-official" is already declared`
5. **不应**出现 `DeepSeek Messages request failed (404)`
6. baseline 交分应见 `[submit] … ACCEPT`，且不依赖 `fgs_satisfy_goal`
7. 失败题（进程已死、或 deferred 过了 `CONTEST_RETIRE_GRACE`、且平台未通关）写入 `$RUN/queue/failed/<code>.json`。通关题不会出现在这里
8. 新题队列空了之后，下一轮应见 `pass=fgs`、`profile=contest`、`enrich=facts:N` 或 `enrich=empty`。其它仍在跑的 baseline pid 不被杀、profile 不变
9. close / list 超时只打 warn / `pending retry`，进程不退出，也 **不**因此把题送进 FGS 队列

---

## 本地烟囱（无平台、无真 key）

```bash
node --test tests/contest_baseline.test.mjs tests/contest_driver.test.mjs tests/contest_supervisor.test.mjs tests/contest_fail_then_fgs.test.mjs
```

A1–A3 锁的是 `CONTEST_FGS_MODE=after_sec` 的墙钟。`on_fail` 忽略墙钟、失败入队、FIFO、补图，都在 `tests/contest_fail_then_fgs.test.mjs`。close 超时仍在 `tests/contest_supervisor.test.mjs`。

有 key 时再烟囱 Messages 工具调用（本仓库不内置 dsh，这里不打 `agent.tar.gz`）：

1. 用镜像里的 `contest-baseline` 起一个 worker。日志没有 `already declared`，也没有 Messages 404。
2. 模型能发出 `bash` 和 `benchmark_get_progress`。`SOLVER_GATEWAY=1` 时模型 URL 落在 `*.tsecbench.gw`。
3. `benchmark_submit_flag` 在没有 FGS satisfy 的情况下打到 Challenges submit。
4. 默认 `CONTEST_FGS_MODE=on_fail` 时，把 `CONTEST_FGS_AFTER_SEC=30` 跑过 30 秒：新 launch 仍是 `contest-baseline`。只有失败题的二遍才是 `contest`，旧 baseline pid 还在。要看旧墙钟，显式设 `CONTEST_FGS_MODE=after_sec`。

---

## 残余风险

- **Messages + FGS（失败二遍）**还没有在真 dsh 里烟囱过。FGS 插件按工具名做 Decide 门禁；`benchmark_*` 已放进 Decide 白名单，但 Messages 工具块形态若和插件假设不一致，二遍 worker 可能失败。失败时不要把 `deepseek-official` 改回 completions。若要退回 completions，用新 id `deepseek-contest`。
- 网关是否放行 `…/anthropic/v1/messages` 需要看托管白名单。只放行 `/v1/chat/completions` 时 Messages 会失败。
- 一遍和二遍工具面不同。斜率看 baseline 新题；FGS 只收已经失败的题，默认同时只有 1 个，而且排在新题后面。
- 多 flag：Solver 任务书要求看 `correct_flag_count` / `total_flag_count`。`CONTEST_RETIRE_GRACE_SOLVED` 只在平台判定通关后缩短宽限，不要在 1/N 时当 solved 关掉。
- 标题旁路会话（`Generate the session title`）两边都有。统计只计解题会话。
