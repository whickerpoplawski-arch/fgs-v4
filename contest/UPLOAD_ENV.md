# TSecBench 上传页环境变量（托管 Agent）

**计分（推荐 `CONTEST_FGS_MODE=on_fail`）：**

- 新题一直用 profile `contest-baseline`：无 FGS，`benchmark_submit_flag` 一跳 `POST /openapi/v1/challenges/submit`（list 探到的前缀优先）。墙钟 `CONTEST_FGS_AFTER_SEC` **不**改变这一点。
- 只有该题被窄定义判定为失败后，才进入 FIFO 重试队列。窄失败含：进程已死、deferred 过宽限、baseline 或 mid-FGS 步数超过 `CONTEST_CHALLENGE_MAX_STEPS`（默认关，上传写 `125`）、一遍已超过 `CONTEST_CHALLENGE_FGS_AFTER_STEPS` 但 FGS 槽满（reason=`fgs_slot_busy`）、或可选墙钟 `CONTEST_FAIL_ON_BUDGET`。新题吃完（`CONTEST_FGS_RETRY_LAST=1`）时，按失败时间从早到晚给它开 **末轮** profile `contest`：挂 `@local/fgs-deepseek-dsh`，预种图，并用 baseline 产物补 Fact / Intent。插件仍是 `verifyMode: command`（`submit_flag.mjs`）。同一 profile 也有 `benchmark_*`。失败当下先快照再杀，然后腾槽，不立刻派 FGS 占槽。`RETRY_LAST=1` 只是新题还在时不 **开跑** 失败队 FGS；槽满失败仍然马上入队。
- 已经在跑的 baseline **不会**热挂载 FGS。上传 `CONTEST_CHALLENGE_FGS_AFTER_STEPS=75`、`CONTEST_CHALLENGE_MAX_STEPS=125` 时，一遍旁路大于 75 且未超过 125、并且 FGS 槽有余量，会杀掉该 baseline，在同一工作目录以 `pass=fgs` 重开（promote）：不写 `failed/`，不关容器，不消耗 `fgs_attempts`，**不删** `.fgs/dsh_step_count`。mid-FGS 与 baseline 共用绝对上限 125（大于 125 才入失败队）。槽满则立刻失败入队（reason=`fgs_slot_busy`）：快照到 `queue/artifacts/<code>/`，杀掉 baseline，确认进程已死后入队并关容器，腾出平台槽；不写 `promote_enrich/`，不调用 `note_fgs_dispatch`。末轮（`from_fail_queue`）不受步数上限和墙钟预算 retire；做完一道再下一道靠 `CONTEST_FGS_MAX_ACTIVE=1`。deferred 宽限和 reap 仍在。
- 二遍如果平台上该题容器还是 active 且地址还在，就复用；reap 已经 close 掉的话会再 `start`。
- regex 只认形态不计分，禁止上赛场。
- `CONTEST_FGS_MODE=after_sec` 是旧的墙钟兼容：到点后**新** worker 用 `contest`，失败题不重试。`off` 永不 FGS。上传不要用这两档，除非明确要退回 PR#12。

**稳定性：** tip 含 PR#11 —— Challenges `close`/`list`/`start` 超时或断连只记日志、不崩 driver 主循环。

**协议：** stock DeepSeek Messages。`agent-default-model` 指向 `deepseek-official` / `deepseek-flash`。`llm-deepseek.baseURL` 为 `https://api.deepseek.com/anthropic`（客户端再拼 `/v1/messages`）。会话记录里的协议名是 `anthropic_messages`。正式镜像（dsh 0.2.1-rc.2）和本仓库 `profiles/contest/cordis.patch.yml`、`profiles/contest-baseline/cordis.patch.yml` 上 Messages 的 `thinking` 都是 `enabled`；设成 `disabled` 会 TRANSPORT 失败。

**不要**在 `llm-pi-ai` 里再次声明 `deepseek-official`，更不要把它 patch 成 `openai-completions`。该 id 已是内置 Messages，再声明会被丢掉（`already declared`），请求仍走 Messages；配上 chat `/v1` 根路径就是 HTTP 404，worker 秒死、SCORE 不动。若必须走 completions，另用唯一 id `deepseek-contest`，本镜像默认不走这条。

`SOLVER_GATEWAY=1` 只改写**模型** baseURL：`https://api.deepseek.com/anthropic` → `http://api.deepseek.com.tsecbench.gw/anthropic`。`BENCHMARK_BASE_URL` / `BENCHMARK_TOKEN` **永不改写**。

权限：`DSH_PERMISSION_MODE=danger-full-access`，profile 里 `sandbox-policy.mode=danger-full-access`、`approval.policy=never`。上传页不必再填。

---

<a id="contest-image-builtin"></a>

## 镜像内置（Release，不是上传页变量）

当前正式包是 Release [`contest-image-6b5d71f`](https://github.com/whickerpoplawski-arch/fgs-v4/releases/tag/contest-image-6b5d71f)（提交 `6b5d71f2bcb684b452998316adc27fb7b56ba29e`）。下载 [`agent.tar.gz`](https://github.com/whickerpoplawski-arch/fgs-v4/releases/download/contest-image-6b5d71f/agent.tar.gz)。SHA256 `e1713e1485e1fccf3361b452823efaa79779ce3fc0fbe0dbcf32f3b260634ccf`。

镜像内置 `@deepseek-ai/dsh@0.2.1-rc.2`。`contest-baseline` 与 `contest` 都不挂 dsh-ops；打靶用 dsh 自带的 bash / 文件工具。只有 `contest` 挂 FGS。Messages 为 **`thinking: enabled`**。`thinking: disabled` 在 dsh 0.2.1-rc.2 上会 TRANSPORT 失败。细则见 README「[正式竞赛镜像](../README.md#contest-image-release)」。

仓库里的 `profiles/contest/cordis.patch.yml` 与 `profiles/contest-baseline/cordis.patch.yml` 同样是 `thinking: enabled`，并且不声明 dsh-ops 组件。两份 `package.json` 的 `bundles` 不含 `dsh-ops`，也没有 `file:/opt/dsh-ops`。示例 `contest/Dockerfile` 不安装 dsh，也不安装 `/opt/dsh-ops`，拷贝的是这两份 profile，构建结果不是这份 Release。已发布的 `contest-image-6b5d71f` tarball 仍是去掉 dsh-ops 之前的烘包。上传页要填的变量见下一节，没有新增项。

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
CONTEST_CHALLENGE_FGS_AFTER_STEPS=75
CONTEST_CHALLENGE_MAX_STEPS=125
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
| `CONTEST_FGS_AFTER_SEC` | `7200` | 仅 `mode=after_sec` | 从 **driver 进程启动**起算。`on_fail` / `off` **忽略**这个值。`0` = 立刻全用 FGS profile。`<0` 或 `off` / `never` / `false` / `no` = 一直 baseline。不是步数 promote |
| `CONTEST_FGS_RETRY_LAST` | `1` | 二遍优先级 | `1`：还有未开的新题时绝不跑 FGS。`0`：允许和该 tick 的新题并行，仍受 `CONTEST_FGS_MAX_ACTIVE` |
| `CONTEST_FGS_MAX_ACTIVE` | `1` | 二遍并发 | 同时活着的 FGS worker 上限 |
| `CONTEST_FGS_MAX_RETRIES` | `1` | 每题二遍次数 | 达到后写 `queue/fgs_done/<code>`，不再派 |
| `CONTEST_FAIL_ON_BUDGET` | `0` | 可选墙钟 | `1` 时，活着的 baseline 或 mid-FGS 超过 Solver 预算仍未通关会被 retire 并入队。默认关。末轮 `from_fail_queue` 忽略 |
| `CONTEST_CHALLENGE_MAX_STEPS` | `0` | 步数腾槽 | `0` 关。`> N` 把未通关的 baseline 或 mid-FGS retire 并入 `failed/`（恰好 N 继续跑）。上传推荐 `125`。旁路文件 `.fgs/dsh_step_count`（pre-step 次数，不是 session `pagination.total`）。Promote 保留该文件，所以这是 baseline 加 mid-FGS 的绝对上限。缺文件不触发。末轮 `from_fail_queue` 忽略。与 `CONTEST_FAIL_ON_BUDGET` 正交 |
| `CONTEST_CHALLENGE_FGS_AFTER_STEPS` | `0` | 步数挂插件 | `0` 关。上传推荐 `75`。一遍 `> M` 且未超过 `MAX_STEPS`、并且 `CONTEST_FGS_MAX_ACTIVE` 有余量：快照到 `queue/promote_enrich/<code>/`，杀掉 baseline，保留同一目录的 `dsh_step_count`，以 `pass=fgs` 重开。不写 `failed/`，不关容器。槽满则快照到 `queue/artifacts/<code>/`，杀掉并 `register_fail(reason=fgs_slot_busy)`，再关容器。`MAX_STEPS<=0` 或 `AFTER>=MAX` 时关闭。与 `CONTEST_FGS_AFTER_SEC` 无关 |
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
7. 失败题（进程已死、deferred 过了 `CONTEST_RETIRE_GRACE`、baseline 或 mid-FGS 步数 `> CONTEST_CHALLENGE_MAX_STEPS`、一遍已超过 AFTER 但 FGS 槽满、或可选墙钟预算，且平台未通关）写入 `$RUN/queue/failed/<code>.json`。通关题不会出现在这里。超步日志是 `contest: retire <code> (steps)` 和 `contest: fail_queue steps code=<code> n=<n>`。槽满日志是 `contest: retire <code> (fgs_slot_busy)` 和 `contest: fail_queue fgs_slot_busy code=<code> n=<n>`。仍有新题时不立刻派该题末轮 FGS，但槽满记录已经在 `failed/`。同一 tick 步数已超过 125 时只走 steps，不 promote
8. 一遍 `> CONTEST_CHALLENGE_FGS_AFTER_STEPS` 且未超过 `MAX_STEPS`、FGS 槽有余量：日志 `contest: promote <code> n=<n>`，随后 `pass=fgs`。此时没有 `failed/<code>.json`，也没有 `fgs_done`。`.fgs/dsh_step_count` 还在。快照在 `queue/promote_enrich/<code>/`，不在 `queue/artifacts/`。FGS 槽已满则没有 promote 这行，baseline pid 已死，`failed/<code>.json` 的 reason 是 `fgs_slot_busy`，快照在 `queue/artifacts/<code>/`，没有 `queue/promote_enrich/<code>/`
9. 新题队列空了之后，下一轮应见末轮 `pass=fgs`、`profile=contest`、`enrich=facts:N` 或 `enrich=empty`。该 worker 带 `from_fail_queue`，步数远超上限、墙钟超过 `CONTEST_CHALLENGE_BUDGET_MIN` 也不因 steps/budget retire。mid-FGS 超过绝对 `MAX_STEPS` 会 retire 入队。通关的 mid-FGS 不写 `failed/`，腾出的 FGS 槽给下一次 promote，或在新题队列空了之后给失败队
10. close / list 超时只打 warn / `pending retry`，进程不退出，也 **不**因此把题送进 FGS 队列

---

## 本地烟囱（无平台、无真 key）

```bash
node --test tests/contest_baseline.test.mjs tests/contest_driver.test.mjs tests/contest_supervisor.test.mjs tests/contest_fail_then_fgs.test.mjs tests/contest_light_constraint.test.mjs
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
- Solver 任务书另有输出纪律：工具调用前可见文字 ≤2 句，通关后只交 flag 加一句结论。
- 标题旁路会话（`Generate the session title`）两边都有。统计只计解题会话。

---

## Baseline 轻约束

这是 **harness / Cordis 钩子**，不是新的模型 tool，也不装 `dsh-routing-suite` / graded / super-injector。`prompt.txt` 里的「输出纪律」（PR#14）仍是软契约；本层用 `agent/pre-step` 在 `next()` 之后 `enter` 一批 sourced user message（`source.kind=plugin:contest-benchmark-tools`，format v4 producer-owned），保证写进**本步 admitted request**。轻约束不改 Messages 的 thinking 开关，也不改 Fail-then-FGS 队列。该开关在正式镜像和本仓库 profile 里都是 `thinking: enabled`（见「[镜像内置](#contest-image-builtin)」）。

挂在已有的 `@local/contest-benchmark-tools`（baseline 与 contest 都会加载）。`inject` 仍只有 `['tools']`：`ctx.on('agent/pre-step')` 不需要 `agents` 服务，避免和 FGS profile 抢依赖。关总开关即可做 A/B。

| Knob | 默认 | 谁读 | 说明 |
|---|---|---|---|
| `CONTEST_LIGHT_CONSTRAINT` | `1` | Cordis plugin | `0` / `off` / `false` / `no` 关闭 L1–L3 |
| `CONTEST_LIGHT_NOTES` | `1` | 同上 | L1：每步注入「≤2 句→工具、禁复读」；若 cwd 有 `NOTES.md` / `.fgs/notes.md`（或 observations 尾）附末尾 ≤400 字 |
| `CONTEST_LIGHT_LOOP_BREAK` | `1` | 同上 | L2：连续 N 步 assistant 文本或 bash/工具指纹相似则注入「换攻击面」，并可用现有 `record_observation` 记一条 |
| `CONTEST_LIGHT_LOOP_N` | `3` | 同上 | 连续相似步阈值（≥2） |
| `CONTEST_LIGHT_ANCHORS` | `1` | 同上 | L3：静态三锚（回顾 / 收敛 / 反跑题）。可关 |

driver 把父进程环境原样拷给 worker，不必再为这些名字改调度代码。镜像 Dockerfile 已带同名默认。平台若清空未声明变量，插件仍按上表默认开启。

```bash
CONTEST_LIGHT_CONSTRAINT=1
CONTEST_LIGHT_NOTES=1
CONTEST_LIGHT_LOOP_BREAK=1
CONTEST_LIGHT_LOOP_N=3
CONTEST_LIGHT_ANCHORS=1
```

A/B：`CONTEST_LIGHT_CONSTRAINT=0`。环状态在本题 cwd 的 `.fgs/light_constraint_state.json`，不污染平台。离线单测：`tests/contest_light_constraint.test.mjs`。
