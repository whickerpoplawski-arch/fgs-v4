# Contest supervisor

插件 D-002 已经在 deferred 之后拒绝 Execute（`docs/DEFERRED_STOP.md`）。进程和容器槽位不归插件管。本目录补的是这一层。

只把插件装进 profile `bundles` 不会启动这里的 reap / retire。那一层只在托管容器走 `contest/entrypoint.sh` → `contest/driver.py` 且 `CONTEST_SUPERVISOR=1` 时运行。对照 README「[托管容器额外要求](../README.md#hosted-container-extras)」。

A profile-bundle install does not run reap / retire. See README 「托管容器额外要求」.

## 谁在调度

托管入口只有一个调度器：`contest/driver.py`。

`CONTEST_SUPERVISOR` 默认开启。循环在 driver 进程内，顺序是：

1. **reap** — 容器仍是 `available` / `pending` / `stop_pending`，或本进程启动过的 worker 已经退出，且没有存活 pid → `close` 一次。有存活 pid → 留下。`closed.txt` 里已有的 code，只要 list 仍是 ACTIVE 且没有存活 pid，每个 tick 再 POST 一次 close，并打 `close <code> retry (still active after closed.txt)`。list 已离开 ACTIVE 则不再关。传输失败不写 `closed.txt`。同一 tick 不重复关同一个 code。
2. **retire** — 存活 worker 的 meta 是 `deferred` 或 `solved`，或平台 `is_completed`。过宽限后 `SIGTERM`，仍在则 `SIGKILL`，然后 `close`。平台已通关但 meta 还不是 `solved` 用短宽限（默认 30 秒），其余默认 60 秒。`solved`（含平台对账）会把 worker 目录归档为 `_done_*`。`on_fail` 下还可选：步数超过 `CONTEST_CHALLENGE_MAX_STEPS`，或 `CONTEST_FAIL_ON_BUDGET=1` 时墙钟超过预算。这两条打 baseline，也打「50 步 promote 之后、尚未进失败队」的 mid-FGS。只有失败队拉起的末轮（slot 标志 `from_fail_queue`）不因步数或墙钟 retire。同一 tick 先判步数上限，再判 promote：已经超过上限的只入失败队。
3. **gc** — `monitor_sampler.sh loop` 的 `SESSION_ID` 不属于存活 worker 时杀掉。
4. **补派** — `alive_workers < CONTEST_MAX_ACTIVE` **并且** `active_containers < CONTEST_MAX_ACTIVE` 才补人。默认 `CONTEST_FGS_MODE=on_fail` 时先派未做过一遍的新题（profile `contest-baseline`，不预种）。新题没有了，才按 `failed_at` 从早到晚派失败题的二遍（profile `contest`，预种并补图），同时活着的 FGS worker 不超过 `CONTEST_FGS_MAX_ACTIVE`。`CONTEST_FGS_RETRY_LAST=1` 时，只要还有新题，这一轮就不派失败队里的 FGS。列表失败时按活跃容器已满处理，不补派，也不把题写进失败队列。Promote 不走这条补派：它只在 FGS 槽有余量时，把**已经占着的** baseline 槽换成 `pass=fgs`，不关容器，也不占用 `fgs_attempts`。空闲槽仍然先给新题。

平台 list / start / close 的 HTTP 超时或连接中断只打 `contest:` 日志，driver 继续下一轮。close 没拿到响应时不写入已关集合，下一轮再试。这类毛刺 **不是** 失败，不会入 FGS 队。close 超时不是失分（已经 submit 的分数还在）；这个异常如果冒出主循环，整条 launch/submit 流水线会停。

### 失败（窄）

同时满足才写入 `$RUN/queue/failed/<code>.json`：

1. 平台 `is_completed` / `completed` 不是真，本地 meta 也不是 `solved`。
2. 并且是下面之一：worker 进程已经死掉（reap）；或 meta `deferred` 且过了 `CONTEST_RETIRE_GRACE` 被 retire；或 `CONTEST_CHALLENGE_MAX_STEPS>0` 且 baseline **或** mid-FGS 的步数旁路 **大于** N（恰好等于 N 继续跑）；或显式打开 `CONTEST_FAIL_ON_BUDGET=1` 后，活着的 baseline 或 mid-FGS 超过本题墙钟预算仍未通关被 retire。

还在跑、多 flag 没齐、close/list 超时，都不是失败。通关走 solved 归档，禁止再 FGS。列表毛刺只 park，不因步数入队。末轮标志是 `from_fail_queue`，不是「凡 `pass=fgs`」。只有这个标志豁免步数和墙钟；它的 reap / deferred 仍走 settle（不新开一条 `failed/`，未写 `fgs_done` 时才把 `failed_at` 挪到队尾）。mid-FGS 的 steps / reap / deferred 入队，`register_fail` 第二次调用不改已有的 `failed_at`。`CONTEST_FGS_MAX_RETRIES` / `fgs_done` 只由失败队派发计数。Promote 成功不写 `failed/`，也不调用 `note_fgs_dispatch`。

`CONTEST_CHALLENGE_FGS_AFTER_STEPS`（默认 `0`，上传 `50`）打开 promote：一遍旁路 **大于** M、且没有超过 `MAX_STEPS`、且 `fgs_live < CONTEST_FGS_MAX_ACTIVE` 时，先把工作目录拷到 `$RUN/queue/promote_enrich/<code>/`（不写 `queue/artifacts/`），再 `SIGTERM`，确认进程已死，删掉同一目录里的 `.fgs/dsh_step_count`，然后 `visit(pass=fgs, reuse_ok)`。不 `attempt_close`。槽满则不杀，baseline 继续跑到超过 `MAX_STEPS`。`MAX_STEPS<=0` 或 `AFTER>=MAX` 时 promote 关闭。进程杀不掉则不重开，避免同一目录两个进程。launch 失败才 `register_fail`（reason `promote`），避免 `first_pass_started` 已写、两队都没有这道题。

步数旁路是工作目录 `.fgs/dsh_step_count`（单调整数）。`contest-benchmark-tools` 每次 `agent/pre-step` 加一，读到旧值就加一。Supervisor 只读该文件；缺文件或不是非负整数则本轮不因步数 retire。Promote 必须删掉这个文件，因为二遍复用 `workdir/<problem_id>`，不会换目录。这个 `n` 是 pre-step 次数，不是 DSH session 的 `pagination.total`（后者还计 system / user / assistant / tool_result）。成功样本的 session 步数大约在 40–50，通常对应更少的 pre-step；长空转仍会晚一些跨过同一数字。上传推荐 `MAX_STEPS=100`、`FGS_AFTER_STEPS=50`。超步入队前先快照再杀。建图在 FGS visit（promote 或末轮）里 seed + enrich，不在 kill 之前。失败队末轮的 enrich 仍读 `queue/artifacts/`。

一遍结束记在 `queue/first_pass_done/<code>`，不再表示「永远不派」。二遍派过并达到 `CONTEST_FGS_MAX_RETRIES` 后记 `queue/fgs_done/<code>`。baseline 产物快照在 `queue/artifacts/<code>/`。补图从这里抽 Fact（做过什么、已验证、已排除，不写裸 flag）和一条继续利用的 Intent。产物为空则只种 origin/goal，日志 `enrich=empty`。

二遍若该题容器仍是 `available` / `pending` / `stop_pending` 且 `container_addr` 还在，就复用，不再 `start`。reap 已经把容器 close 掉时，二遍会再 `start`。

队列空、没有待重试的 close、且没有存活 worker 时 driver 退出。列表失败不算队列空。`CONTEST_SUPERVISOR=0` 不进入循环，仍是一次性 list → start →（按当前 mode 的一遍 profile）→ dsh，没有失败重试。

`contest/supervisor/autosup.sh` 是 `$RUN/workers/wN_<code>` 那套目录布局的手动入口，内部同样是 gc → retire → reap → 双护栏。它和 driver **不能同时补派**：谁先拿到 `$RUN/monitor/scheduler.lock`，另一方直接退出。entrypoint 不会启动 `autosup.sh`。

## 环境

| 变量 | 默认 |
|---|---|
| `RUN` | `CONTEST_WORKDIR` |
| `BENCHMARK_TOKEN` / `BENCHMARK_BASE_URL` | 必填，运行时注入，不进镜像 |
| `CONTEST_SUPERVISOR` | `1` |
| `CONTEST_MAX_ACTIVE` | `3` |
| `CONTEST_RETIRE_GRACE` | `60` |
| `CONTEST_RETIRE_GRACE_SOLVED` | `30` |
| `CONTEST_SUPERVISOR_INTERVAL` | `20` |
| `CONTEST_HTTP_TIMEOUT` | 不设时 close 为 20、driver 的 list/start 为 30。设置后三者共用，且必须是正数 |
| `FGS_UNIQUE_CODE` | driver 按题注入 | 与 start/close 的 `unique_code` 相同。不要在上传页设成一个全局值。缺了则 FGS `submit_flag.mjs` fail-closed。baseline 的 `benchmark_submit_flag` 同样只认这个子进程值和本题 meta，不认 `BENCHMARK_UNIQUE_CODE` |
| `CONTEST_DSH_PROFILE` | `contest-baseline` | 新题一遍的 profile。无 FGS bundle |
| `CONTEST_DSH_PROFILE_FGS` | `contest` | 失败二遍的 profile。含 FGS。不改已经在跑的 worker |
| `CONTEST_FGS_MODE` | `on_fail` | `on_fail` 推荐。`after_sec` 保留 PR#12 墙钟且不重试失败题。`off` 永不 FGS |
| `CONTEST_FGS_AFTER_SEC` | `7200` | **只在 `mode=after_sec` 时生效。** `on_fail` 忽略。`0` 立刻全用 FGS profile。负数或 `off` / `never` / `false` / `no` 则一直用 baseline。不热挂载。这不是步数 promote |
| `CONTEST_FGS_RETRY_LAST` | `1` | `1`：有新题就不跑 FGS。`0`：可以和新题同一轮并行，仍受下面的上限 |
| `CONTEST_FGS_MAX_ACTIVE` | `1` | 同时 FGS worker 上限 |
| `CONTEST_FGS_MAX_RETRIES` | `1` | 每题 FGS 遍数。用尽后写 `fgs_done` |
| `CONTEST_FAIL_ON_BUDGET` | 关 | `1` 才把「活过墙钟预算仍未通关」的 baseline 或 mid-FGS 当失败。默认关。`from_fail_queue` 忽略 |
| `CONTEST_CHALLENGE_MAX_STEPS` | `0` | pre-step 上限。`0` 关。`> N` 才 retire 并入失败队（满 N 仍跑）。上传推荐 `100`。打 baseline 和 mid-FGS。末轮 `from_fail_queue` 忽略。与墙钟预算正交 |
| `CONTEST_CHALLENGE_FGS_AFTER_STEPS` | `0` | 一遍 pre-step 超过 M 则 promote 到 `contest`（杀再建，同一目录）。`0` 关。上传推荐 `50`。`MAX_STEPS<=0` 或 `AFTER>=MAX` 时也关。比较符 `>`。FGS 槽满则不杀。与 `CONTEST_FGS_AFTER_SEC` 不是同一个开关 |
| `CONTEST_SKIP_FGS_SEED` | `auto` | `auto`：只有 FGS profile 预种图。`1` 一律不预种。`0` 一律预种 |
| `CONTEST_CHALLENGE_BUDGET_MIN` | `60` | Solver 任务书里的「本题时间预算」分钟数。平台字段优先 |

`CONTEST_SUPERVISOR_INTERVAL` 是 driver 循环和手动 `autosup` 两轮之间的休眠秒数。`0` 仍合法（不休眠）。别名 `GRACE` / `GRACE_SOLVED` 仍覆盖对应的 `CONTEST_RETIRE_*`。

`reap.sh` / `retire.sh` / `autosup.sh` 缺 `RUN` 或 `BENCHMARK_*` 时失败并写明缺哪一个。路径和凭证只来自环境变量，不写死某一次 run 的目录或 env 文件。

## 竞赛推荐 env

默认已经与下面这一档对齐（deferred 之后大约再占宽限加一轮间隔）。上传页或编排可以显式写上，便于核对。本地单测可以 `CONTEST_SUPERVISOR=0`，或显式把 `CONTEST_RETIRE_GRACE` 拉大。正式赛不要关 supervisor。

```bash
# 竞赛推荐（本仓库默认已与此对齐；显式写出便于上传页/编排核对）
CONTEST_SUPERVISOR=1
CONTEST_MAX_ACTIVE=3
CONTEST_RETIRE_GRACE=60
CONTEST_RETIRE_GRACE_SOLVED=30
CONTEST_SUPERVISOR_INTERVAL=20
CONTEST_DSH_LAUNCH=1
CONTEST_DSH_PROFILE=contest-baseline
CONTEST_DSH_PROFILE_FGS=contest
CONTEST_FGS_MODE=on_fail
CONTEST_FGS_RETRY_LAST=1
CONTEST_FGS_MAX_ACTIVE=1
CONTEST_FGS_MAX_RETRIES=1
SOLVER_GATEWAY=1
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
# 上传页另写（代码默认都是 0；不写则不按步数 promote / 腾槽）
# CONTEST_CHALLENGE_FGS_AFTER_STEPS=50
# CONTEST_CHALLENGE_MAX_STEPS=100
# + BENCHMARK_TOKEN / BENCHMARK_BASE_URL / DEEPSEEK_API_KEY（运行时注入，勿进镜像）
# 协议：stock Messages（deepseek-official）。不要把该 id patch 成 openai-completions。
```

解题 prompt 不包含这些脚本。监管只动进程和槽位，不改题目内容。
