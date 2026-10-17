## 这几条最重要

装插件、做自己的竞赛镜像，先核对这六条：

1. **模型**：竞赛 profile 走官方 **Messages**（`deepseek-official` + `https://api.deepseek.com/anthropic`，会话协议 `anthropic_messages`）。**不要**把 `deepseek-official` patch 成 `openai-completions`：该 id 已经是内置 Messages，再声明会被丢掉（`already declared`），请求仍打 Messages，配上 chat `/v1` 根路径就是 **HTTP 404**。若还要 completions，用另一个 id（`deepseek-contest`），不要复用 `deepseek-official`。
2. **托管上传环境变量**：只填 `DEEPSEEK_API_KEY` 和 `SOLVER_GATEWAY=1`。不要设 `BENCHMARK_*`（平台运行时注入）。
3. **镜像要能跑 bash**：安装 `bubblewrap`（`bwrap`），和/或把 DSH 默认权限设成 `danger-full-access`，`approval.policy` 设为 `never`。
4. **打靶**：用 `bash` / `curl` 打挑战目标。`web_fetch` 会拒私网 IP（`10.0.177.x`）。
5. **开题**：`POST .../challenges/start?unique_code=`（`unique_code` 放在 query）。`5624fa3` 已经是这个写法。
6. **交 flag（SCORE）**：baseline（`contest-baseline`，新题默认）用 `benchmark_submit_flag` 一跳 `POST …/challenges/submit`，不经过 `fgs_satisfy_goal`。FGS profile（失败题的二遍，不是墙钟到点）仍把插件 `cordis.patch.yml` 保持 `verifyMode: command`，`verifyCommand` 为 `node ./tools/submit_flag.mjs`；同一 profile 也挂了 `benchmark_*`，Decide 放行这三个工具。禁止用 `regex` 上赛场：`regex` 只检查 fact 里有没有 `flag{…}`，不会 POST submit，SCORE 不涨。每个 worker 由 `launch_dsh` 注入 `FGS_UNIQUE_CODE`（与 start/close 的题号相同）。不要在上传页写一个全局 `FGS_UNIQUE_CODE`。本地练习可以在自己的 profile 里改回 `regex`。
7. **正式竞赛镜像**：Release [`contest-image-6b5d71f`](https://github.com/whickerpoplawski-arch/fgs-v4/releases/tag/contest-image-6b5d71f) 内置 `@deepseek-ai/dsh@0.2.1-rc.2`。本仓库的 `contest-baseline` 与 `contest` 不打包、不启用 dsh-ops；打靶用 dsh 自带的 bash / 文件工具。Messages 仍是 `deepseek-official` + `/anthropic`，并且 **`thinking: enabled`**。这不是 `dsh plugin add` 本仓库能装出来的。详见「[正式竞赛镜像](#contest-image-release)」。

---

# fgs-deepseek — DSH 原生插件（FGS 黑板）

把 `CONTRACT.md` 冻结的 **FGS 黑板**（Fact → Step → Fact）做成 DeepSeek Harness 的**原生插件**：
Host 半提供单写者 Controller、Decide/Execute 双 toolset、FLAG 硬门与 reopen；Client 半在
composer 上方渲染一条只读黑板条。

> 契约最高优先级：与 `DeepSeek_FGS_harness_plugin_design.md` 冲突时以 `CONTRACT.md` 为准。
> 本仓库是**原生 DSH 移植**（`fgs-deepseek/` 是上一版 Python harness 适配层）。

## 装（clone / 解压后照抄即可）

**前提**：已装 DSH，且能跑 `dsh`（本插件纯 ESM、**零运行时依赖**，不需要 npm 发布、不需要 build）。
包名是 `@local/fgs-deepseek-dsh`（`private: true`，**不在 npm registry 上**），所以要用**本地路径**或 **git** 安装。

### 方式 A：本地目录（推荐，离线可用）

```bash
# <插件目录> = 你 clone 或解压出来的仓库根目录（含 package.json）
dsh plugin --profile web add /绝对路径/<插件目录>
# 例如： dsh plugin --profile web add /home/me/fgs26-10-12
```

### 方式 B：直接从 git 仓库装

```bash
dsh plugin --profile web add github:<你的用户名>/<仓库名>
# 或指定分支/标签： dsh plugin --profile web add github:<user>/<repo>#v10
# 也可以：          dsh plugin --profile web add git+https://github.com/<user>/<repo>.git
```

### 方式 C：Web GUI

设置 → 插件 → 安装 → 填上面的路径或 git 形式（同一个安装器）。

只把插件装进 profile `bundles` 只有 FGS 工具和黑板，不会跑 reap / retire。托管容器的额外要求见「[托管容器额外要求](#hosted-container-extras)」。

装完**即生效（DSH 对 profile 热加载，无需重启）**。安装器会做两件事：把包写进 profile 的
`dependencies`，并**自动把它加入 `dsh.profile.bundles`**（这一步是关键——只加 `dependencies`
而不进 `bundles`，插件 overlay 不生效、**插件会静默不加载**）。

### 装完怎么确认真的生效

```bash
# token 从 dsh 启动日志里取（dsh web 打印的 URL 里带 token）
curl -s "http://127.0.0.1:3080/fgs/state?token=<TOKEN>"
```

返回 JSON 里应含 `"pluginGeneration": <N>` 与 `"buildTag": "<N>+cairn-v2+..."`；
同时在会话里应能看到 15 个 `fgs_*` 工具。**注意**：未带 token 请求 `/fgs/state` 会被
DSH Web 掩码成 404（和"插件没加载"的 404 无法区分），所以务必带 token 断言。

### 卸载 / 排查

```bash
dsh plugin --profile web remove @local/fgs-deepseek-dsh
# 排查：确认 profile 的 package.json 里 dsh.profile.bundles 含本包名
grep -n 'fgs-deepseek-dsh' ~/.dsh/profiles/web/package.json
```

`cordis.patch.yml` 插入一行 Host 行；Client 半由 `package.json` 的 `dsh.client` 自动装载。

> ⚠️ **改动本插件目录里的文件后，务必重新跑一次安装命令（或重启 DSH）。**
> 实测：DSH 监听到被 link 的插件包内容变化时会把插件**卸载**，且不会自动挂回来；
> 此时 `/fgs/state` 变 404、会话里的 `fgs_*` 工具全部消失（**没有任何报错**）。
> 恢复方式：
> ```bash
> dsh plugin --profile web add /绝对路径/<插件目录>   # 重新触发挂载
> curl -s "http://127.0.0.1:3080/fgs/state?token=<TOKEN>"   # 必须重新出现 pluginGeneration
> ```

<a id="hosted-container-extras"></a>

## 「托管容器额外要求」

只把本插件装进自己的 DeepSeek harness（`dsh plugin add`，包进入 profile 的 `dependencies` 和 `dsh.profile.bundles`）只提供 **FGS 工具和黑板**。没有 contest driver，reap / retire 不会跑。已发布的竞赛镜像另含 dsh 0.2.1-rc.2。竞赛 profile 不依赖 dsh-ops，见「[正式竞赛镜像](#contest-image-release)」。

Installing this plugin into a profile bundle only provides the **FGS tools and the blackboard**. That install does not start the contest driver. The published contest image also contains dsh 0.2.1-rc.2. Contest profiles do not depend on dsh-ops (see 「正式竞赛镜像」).

TSecBench 托管容器在插件之外还要：

- **ENTRYPOINT** [`contest/entrypoint.sh`](contest/entrypoint.sh)。它 exec `contest/driver.py`：`list` → `start` →（仅 FGS profile）磁盘预种 → Solver 任务书 → `dsh --profile <contest-baseline|contest>`。baseline 不预种。FGS 预种在任何模型回合之前完成。
- 环境变量：`CONTEST_SUPERVISOR=1`、`CONTEST_DSH_LAUNCH=1`、`SOLVER_GATEWAY=1`、`CONTEST_FGS_MODE=on_fail`。新题用 `contest-baseline`。失败题末轮用 `contest`。不热挂载。一遍 pre-step 超过 `CONTEST_CHALLENGE_FGS_AFTER_STEPS`（上传 `75`）且未超过 `CONTEST_CHALLENGE_MAX_STEPS`（上传 `125`）、FGS 槽有余量时，杀掉该 baseline，在同一目录以 `contest` 重开，并保留 `.fgs/dsh_step_count`。槽满则 `fgs_slot_busy` 入失败队并关掉该 worker。末轮不因步数被杀。`CONTEST_FGS_AFTER_SEC` 只在 `mode=after_sec` 时生效。
- **不要设置** `BENCHMARK_*`，也不要在上传页写全局 `FGS_UNIQUE_CODE`。`BENCHMARK_TOKEN` / `BENCHMARK_BASE_URL` 由平台在运行时注入。
- **交 flag**：baseline 走 `benchmark_submit_flag`（同一 POST submit）。FGS 插件仍保持 `verifyMode: command`。driver 按题注入 `FGS_UNIQUE_CODE`。
- 竞赛 profile 用 **stock Messages**：`provider: deepseek-official`，`baseURL: https://api.deepseek.com/anthropic`。`SOLVER_GATEWAY=1` 只改写模型基址（`https://api.deepseek.com/anthropic` → `http://api.deepseek.com.tsecbench.gw/anthropic`），不改 `BENCHMARK_*` 和 Challenges API。不要把 `deepseek-official` 配成 `openai-completions`。

没有 contest driver，或 `CONTEST_SUPERVISOR` 不是 `1`，**reap / retire 不会运行**。

The hosted container also needs `ENTRYPOINT contest/entrypoint.sh` (driver: list → start → Solver brief → dsh; FGS preseed only on the FGS profile), plus `CONTEST_SUPERVISOR=1`, `CONTEST_DSH_LAUNCH=1`, and `SOLVER_GATEWAY=1`. Do not set `BENCHMARK_*` (the platform injects them). Use stock DeepSeek Messages (`deepseek-official`, base `https://api.deepseek.com/anthropic`). Do not patch that provider id to openai-completions. Without the contest driver and `CONTEST_SUPERVISOR=1`, reap / retire do not run.

细则：[`contest/SUPERVISOR.md`](contest/SUPERVISOR.md)，启动顺序见 [TSecBench contest entry](#tsecbench-contest-entry)。

## 用

### 人类命令

| 命令 | 作用 |
|---|---|
| `/fgs new <problemId> [brief]` | 建一道题的 Project（独立图 + `workspace/`）。给了 brief 就同时种题，并切为活动题 |
| `/fgs switch <problemId>` | 切换活动题。之后的图工具、`/fgs status` 和 `/fgs/state` 都走这道题 |
| `/fgs list` | 列出全部题：id / title / 派生角色 / open / satisfied / state。`*` 是活动题 |
| `/fgs init <brief>` | 兼容别名：等价 `/fgs new default <brief>` |
| `/fgs status` | 活动题的角色 / facts / steps / open 数 / satisfied |
| `/fgs graph` | 打印活动题的图投影（fact 仅 id+title） |
| `/fgs path` | 打印活动题的 `graph.yaml` 路径 |
| `/fgs reopen <原因>` | 打回活动题：清空 `satisfied*` + 追加 feedback Fact |
| `/fgs off` | 退出本会话在活动题上的运行（图文件保留）。会被记住，不会被自动认领拉回来；`/fgs switch <id>` 可重新进入 |

### 模型工具（角色自动切换 + 隔离）

角色由图状态推导：**有 open step → Execute，否则 Decide**。没有活动 Project 时，
改图工具（含 `fgs_seed`）被 guard 拒，只放只读 `fgs_status`。先 `fgs_project action=new`
（或人的 `/fgs new`）。活动题已建但还没种题时，只有 `fgs_seed` / `fgs_status` 可用。

- **控制面**：`fgs_project`（`action=new|switch|list`，建题/换题/列题）、`fgs_seed`、`fgs_status`
  - `fgs_project` 在任何角色、任何状态下都放行——没有活动 Project 时正是唯一要用它的时刻，
    所以它不能进「没有活动 Project 就拒」那条分支。这是模型自主跑多题的前提。
- Decide：`fgs_open_step`、`fgs_drop_step`、`fgs_change_step_priority`、`fgs_preview`、
  `fgs_commit`、`fgs_satisfy_goal`、`fgs_reopen` + `decideAllowTools` 里的元工具
- Execute：`fgs_submit_fact`、`fgs_commit_step` + 宿主提供的环境工具
  （`bash`/`read`/`write`/`edit`/`glob`/`grep` 等，本插件不注册它们）

### 认领（attach）：磁盘上的图说了算

run 只在 `fgs_seed` / `fgs_project action=new <brief>` 时创建。重启或换会话后内存里没有 run，
但磁盘上的 Project 已经种好题——这时**按磁盘自动认领**（建 run + 按图推导角色），
而不是拿「内存里有没有 run」当「有没有种题」。否则会自相矛盾：

```
guard    → 「FGS 未启动：先 fgs_seed 种题，再使用图工具」
fgs_seed → 「已经种过题」并报错
```

只看错误信息的自主 agent 会卡死在这个循环里。回归用例见 `tests/projects.test.mjs`
的「认领」两例（用「同一 workspace 重新 apply」模拟重启）。

隔离是**在 dispatch 层硬拦**：`tools.guard` 顺序无关、单调。Decide 轮用**白名单**——
不在 `ROLE_TOOLS.decide ∪ decideAllowTools` 里的工具一律拒（含 `bash`/文件/`web_*`/
`subagent`/`workflow`，因为它们能间接执行环境动作）。Execute 轮拒 Decide 的规划类工具。

> 为什么不用 `tools.restrict` 做 schema 级隐藏：实测于 DSH **0.2.0-rc.2**（历史记录。当前已发布竞赛镜像的 dsh 是 0.2.1-rc.2，restrict 交集行为没有在 0.2.1 上复测）。对同一 agent scope
> 连续 `restrict` 时后一次不会解除前一次的限制（限制取交集）。角色随图状态变化，一旦
> 为「未启动」隐藏了规划工具，进入 Decide 后它们就再也不可见了。所以 schema 层永远保留
> 全部 `fgs_*` 工具，越权由 guard 硬拒。`tests/plugin.test.mjs` 有回归用例锁住这一点。

## 目录

```
CONTRACT.md                 # 冻结契约（拷贝进仓库根）
package.json                # bundle manifest + dsh.bundle.patch + dsh.client
cordis.patch.yml            # 插入 Host 行
index.js                    # Host 半：服务、12 个工具、角色门、命令、上下文、HTTP 快照
client.js                   # Client 半：conversation.input.dock 只读黑板条
yaml.js                     # FGS 图 YAML 子集读写（无外部依赖）
controller/                 # 单写者：ops.js + index.js（GraphStore/Controller）+ projects.js（ProjectRegistry）
hooks/                      # validate_write（写图预检）/ flag_verify（FLAG 硬门）/ sync_context
env/windows.js              # WSL/PowerShell 规范化（CONTRACT §11）
fixtures/                   # golden：origin-only / mid-graph / post-satisfy
io-specs/                   # LLM 工具 I/O 预制规范
schemas/tools/              # Decide/Execute 工具 JSON Schema
prompts/                    # Decide/Execute 系统骨架；apply 时读入并注入 fgs-graph
tools/                      # submit_flag.mjs（赛方提交）+ bootstrap_project.mjs（无 LLM 写盘种题）
contest/                    # hosted 入口：entrypoint.sh + driver.py + supervisor/ + Dockerfile 示例
tests/                      # node --test（离线，无外部依赖）
tests/fixtures/             # 含 fgs-v3-baseline.index.js（gen9 冻结基线，供对抗测试做集合差）
docs/                       # 开发笔记：HANDOFF / V3_CHANGES / V4_CHANGES / FIXES.patch（历史记录，不参与运行）
```

## 数据

一场比赛 = 一个 workspace 根（CLI 可用 `stateDir` 配置改名，默认 `.fgs`）。
一道题 = 一个 Project，图和 Execute 工作目录按题隔离，不共用一张图：

```
<workspace>/.fgs/
  competition.json                 # problems[] + activeProblemId
  graph.yaml.bak                   # 仅旧布局迁移后留下的备份
  projects/<problemId>/
    graph.yaml                     # 该题主真相，顶层键仅 facts → goals → steps
    graph.json                     # 同构镜像（先写 tmp + fsync 再 rename）
    graph.lock                     # 该题写锁（陈旧锁 10s 自愈）
    meta.json                      # state / model / budget / roundSeq / createdAt
    workspace/                     # 该题 Execute 产物目录
```

`problemId` 会规范成 `[a-z0-9_-]{1,64}`（非法字符变成 `_`）。重复 id 拒绝创建。
内存里的 run 以 `(sessionId, problemId)` 为键：草稿、角色、`roundSeq` 都随题分开。
「一轮只收束一个 open step」比对的是本 run 的 `roundSeq`，不是全局 DSH turn。

若磁盘上还是旧的单图 `.fgs/graph.yaml`、且还没有 `projects/`，第一次访问会把它迁到
`projects/default/`（原文件留 `.bak`），并把 `default` 设为活动题。

## 配置（`cordis.patch.yml` 的 `config`）

```yaml
- insert:
    - id: fgs-deepseek
      name: '@local/fgs-deepseek-dsh'
      config:
        stateDir: .fgs                 # 图目录（相对会话 cwd）
        factContentMaxBytes: 8192      # content 超阈值拒写（CONTRACT §7）
                                       #   注：超过该阈值的 content 实际一律拒写——契约要求的
                                       #   「文件路径」形态本身就是短串（实测 <4 KiB），两个条件互斥，
                                       #   故「>8 KiB 且是路径」这一分支不可达。蒸馏意图不变：
                                       #   大产物落文件，fact 里只放结论与路径。
        factTitleMaxChars: 120
        verifyMode: command            # 真赛默认。regex | local 仅本地练习（不存在关门的 none：§8 必须有硬门）
        flagPattern: 'flag\{[^}\s]{4,}\}'   # 真实竞赛（百度）用**小写** flag{...}；submit_flag 也用它抽 flag
        flagFlags: i                   # 忽略大小写编译，同时兼容 FLAG{...}；'g' 会被剔除
        expectedFlag: ''               # verifyMode=local 时必填
        verifyCommand: 'node ./tools/submit_flag.mjs'
                                       # verifyMode=command：读 stdin 的校验命令，退出码 0 = 通过
                                       #   ./ 相对本插件目录，不是 worker cwd
                                       #   stdin 收到 {goalId, reason, satisfiedBy, facts[]}；
                                       #   stdout 若是 {"ok":false,"reason":"…"} 也按拒绝
        decideAllowTools: [todo_write, skill, ask_user_question, exit_plan_mode, cordis_inspect_list, cordis_inspect_query]
                                       # Decide 轮白名单：不在表里的工具（bash/文件/网络/subagent/workflow…）一律拒
        maxResultChars: 8000           # 图工具出参截断（io-specs 的 max_result_chars）
        deniedEnvTools: [bash, read, write, edit, glob, grep, ...]
        exposeHttpState: true          # 给 Web 面板的只读快照路由
        httpPath: /fgs/state
        executeSessionTtlMs: 600000    # 单题 Execute 墙钟，默认 10 分钟
```

`executeSessionTtlMs` 到期：同一会话进入收束。环境工具停止，一条 Fact 经 `fgs_commit_step` 关闭当前 step，然后回到 Decide。不写未完成 Fact，step 不保持 open，题目不因此标 `deferred`。回合结束前模型没调用 `fgs_commit_step` 时，Controller 补上这一条 Fact 并关 step。`stepLeaseMs`（默认 30 分钟）只是认领租约，过期后别的会话可以 `claim_step` 接手仍 open 的 step；它不写 Fact，也不被会话 TTL 替换。

FLAG 硬门**不可关闭**（`CONTRACT §8`）：`verifyMode` 没有 `none`，未识别/`none` 一律
fail-closed 回退到 regex。要放行请把 `flagPattern` 显式设宽——让「本运行不做外部校验」
留在配置里可见，而不是把门拆掉。

### 真赛默认就是 `verifyMode: command`

`cordis.patch.yml` 已经是 `command` + `node ./tools/submit_flag.mjs`。不要改回 `regex` 再上赛场。

`regex` 只能校验「fact 文本里出现过 flag 形态」，**不能证明这个 flag 真的对**，也**不会**
`POST ${BENCHMARK_BASE_URL}/openapi/v1/challenges/submit`。harness 可以多次报「goal_final 已满足」，
SCORE 面板仍然不涨。本地练习可以在自己的 profile 里覆盖成 `regex`。

`tools/submit_flag.mjs` 会：从 `facts` 文本抽出全部 flag → 逐个 POST 到
`${BENCHMARK_BASE_URL}/openapi/v1/challenges/submit`（带 `BENCHMARK_TOKEN`）→
`200/201` 判对、**`409` 重复提交也按已判对**（说明此前已提交成功）→ 全部通过才 exit 0。
只有这一步通过，§8 hook 才允许写 `satisfied*`。

需要的环境变量：`BENCHMARK_BASE_URL`（或 `PLATFORM_BASE_URL`）、`BENCHMARK_TOKEN`、
`FGS_UNIQUE_CODE`（如 `b-02`，也可在被引用的 fact 文本里带 `"unique_code"`）。
`contest/driver.py` 的 `launch_dsh` 按题注入 `FGS_UNIQUE_CODE`，值与 start/close 的题号相同，
并且不改写 `BENCHMARK_*`。不要在上传页设一个全局 `FGS_UNIQUE_CODE`。
三者缺任一、或接口不可达、或抽不到 flag → **一律 fail-closed 拒收**（宁可挡住一次真 flag）。

> 为什么 `regex` 的默认值改过：早期默认是 `FLAG\{[^}\s]{4,}\}`（全大写 + 没有 `i`），
> 而真实竞赛的 flag 是 `flag{...}` 小写——**拿到真题的真 flag 也会被硬门拒收**，
> 只有自己敲的 `FLAG{}` 假数据能过。这个问题是靠一份真实比赛会话导出（b-02）才暴露的。

<a id="tsecbench-contest-entry"></a>

## TSecBench contest entry（磁盘预种）

托管评测是**一个 Agent 容器跑多题队列**（题目靶场另起，`start` 之后才有 `container_addr`，同时活跃约 **3** 题）。平台不替你敲 `/fgs new`，也不规定 ENTRYPOINT 写法；行为要求是：**镜像启动后自行开始解题**。只在 prompt 里写「必须 `fgs_project`」不够——网关丢 `function_call` 时整题没有黑板，Decide/Execute 会停在「未启动」。

P0 做法是磁盘预种：每题 `start` 成功后、拉起 dsh **之前**，用本仓库的写图器落盘。`attachRun` 看到 `fact_origin` 就自动认领，模型第一轮不必建题。

### 环境契约

| 变量 | 谁提供 | 说明 |
|---|---|---|
| `BENCHMARK_TOKEN` | 平台注入 | 缺则 `contest/entrypoint.sh` **exit 1**。不要写进镜像，也不要填在上传页 |
| `BENCHMARK_BASE_URL` | 平台注入 | 同上 |
| 模型 key / base URL | 上传页环境 | 运行时读取。镜像内剥离密钥 |
| `SOLVER_GATEWAY=1` | 选手运行时 | 只改写模型基址（`DEEPSEEK_BASE_URL`、`OPENAI_BASE_URL` 等）和竞赛 profile 的 `baseURL`：`https://api.deepseek.com/anthropic` → `http://api.deepseek.com.tsecbench.gw/anthropic`（https→http，主机名后加 `.tsecbench.gw`）。不改 `BENCHMARK_BASE_URL`、`BENCHMARK_TOKEN`，也不改 Challenges API URL。托管沙箱没有公网。本地调试不要设。Messages 不要把这个值设成 chat `/v1` 根，否则会 404 |
| `CONTEST_VPN` | 可选，默认关 | integration 文档写访问题址要任务 VPN；托管上传页**没写**沙箱是否已内置 VPN。默认不阻塞预种。打开时还要 `CONTEST_VPN_CONFIG`（配置文件）和 `CONTEST_VPN_EXEC`（本骨架不内置 OpenVPN） |
| `CONTEST_MAX_CONCURRENCY` | 可选，默认 3 | 超过 3 会被压到平台 max active |
| `CONTEST_WORKDIR` | 可选 | 每题一个子目录。默认 `<仓库>/contest-work` |
| `CONTEST_FIXTURE` | 离线 | 指向 challenges JSON，不访问平台。正式托管不要设 |
| `CONTEST_DSH_LAUNCH=1` | 可选 | 本骨架**不**内置 dsh。未设置时只写 `.fgs/dsh-launch.json` 占位。profile 用 stock Messages（`deepseek-official`），不要把该 id patch 成 openai-completions |
| `CONTEST_DSH_PROFILE` | `contest-baseline` | 新题一遍的 `--profile`。bundles 不含 FGS |
| `CONTEST_DSH_PROFILE_FGS` | `contest` | 失败二遍的 `--profile`。含 FGS + `benchmark_*` |
| `CONTEST_FGS_MODE` | `on_fail` | 新题保持 baseline。失败（进程已死、deferred 过宽限、步数超过绝对 `CONTEST_CHALLENGE_MAX_STEPS`、FGS 槽满时的 `fgs_slot_busy`，或可选墙钟预算）才 FIFO 二遍。`after_sec` 是旧墙钟且不重试。`off` 永不 FGS |
| `CONTEST_CHALLENGE_MAX_STEPS` | `0` | pre-step 绝对上限。`0` 关。`> N` 才入失败队。上传推荐 `125`。baseline 和 mid-FGS 共用 `.fgs/dsh_step_count`（promote 不删）。末轮 `from_fail_queue` 不吃，也不吃 `CONTEST_FAIL_ON_BUDGET` |
| `CONTEST_CHALLENGE_FGS_AFTER_STEPS` | `0` | 一遍 `> M` 且未超过 `MAX`：FGS 槽有余量则杀再建挂 `contest` 并保留步数文件。上传推荐 `75`。槽满则 `fgs_slot_busy` 入队并关容器。`0`、`MAX_STEPS<=0` 或 `AFTER>=MAX` 时关。与 `CONTEST_FGS_AFTER_SEC` 无关 |
| `CONTEST_FGS_AFTER_SEC` | `7200` | **仅 `mode=after_sec`。** `on_fail` 忽略。`0` 立刻全 FGS。`off` / 负数一直 baseline。不杀已运行 worker |
| `CONTEST_FGS_RETRY_LAST` | `1` | 有新题时不跑 FGS |
| `CONTEST_FGS_MAX_ACTIVE` | `1` | 同时 FGS worker 上限 |
| `CONTEST_FGS_MAX_RETRIES` | `1` | 每题 FGS 遍数 |
| `CONTEST_SKIP_FGS_SEED` | `auto` | 仅 FGS profile 预种。baseline 跳过 bootstrap。二遍在预种后按 baseline 产物补图 |
| `CONTEST_CHALLENGE_BUDGET_MIN` | `60` | Solver 任务书的时间预算（分钟）。只在 `CONTEST_FAIL_ON_BUDGET=1` 时退休**一遍** worker |
| `BENCHMARK_API_PREFIX` | 可选 | 不设时 list/start 先试 `/api/v1`，再试 `/openapi/v1`（与 `tools/submit_flag.mjs` 的提交路径同族） |
| `RUN` | 可选 | 监管根目录（`workers/`、`monitor/`、`attempted/`）。不设时 entrypoint 用 `CONTEST_WORKDIR` |
| `CONTEST_SUPERVISOR` | 默认开 | `1`：driver 内循环做 reap / retire / 双护栏补派。`0` 关闭，回到一次性 visit（本地单测） |
| `CONTEST_MAX_ACTIVE` | 默认 3 | 同时存活 worker 与平台活跃容器的上限。超过 3 压到平台 cap。未设时沿用 `CONTEST_MAX_CONCURRENCY` |
| `CONTEST_RETIRE_GRACE` | 默认 60 | deferred / 本地已 solved 的退休宽限（秒） |
| `CONTEST_RETIRE_GRACE_SOLVED` | 默认 30 | 平台 `is_completed` 但本地 meta 还不是 solved 时的短宽限（秒） |
| `CONTEST_SUPERVISOR_INTERVAL` | 默认 20 | driver 监管循环（以及手动 autosup）的轮询间隔（秒）。`0` 表示不休眠 |
| `CONTEST_HTTP_TIMEOUT` | 可选 | 平台 list/start/close 的单次 HTTP 超时（秒）。不设时 close 为 20、driver 的 list/start 为 30。必须是正数。超时只记日志并在下一轮重试，不会让 driver 退出 |

行为说明和竞赛推荐 env 见 [`contest/SUPERVISOR.md`](contest/SUPERVISOR.md)。Token 与 base URL 只在运行时注入，不要写进镜像。

本地单题调试可以用 `FGS_PROBLEM_ID` / `FGS_BRIEF` / `FGS_WORKSPACE` 调 `bootstrap_project.mjs`。托管题面真源是 Challenges API 的 `unique_code` 和 `description`，不是这些变量。

### 启动后的磁盘预种顺序

`contest/entrypoint.sh` 校验 token 与 base URL，然后 exec `contest/driver.py`。默认 `CONTEST_SUPERVISOR=1`：调度循环在 driver 进程里（子进程退出后 close、deferred / 平台已通关过宽限后 kill+close、存活 worker 和活跃容器都小于 3 才补派）。entrypoint **不**另起 `autosup.sh`。`CONTEST_SUPERVISOR=0` 时仍是下面这一次性 visit。driver 对每个未完成的 visit：

1. `list_challenges`（跳过已通关）
2. `POST {prefix}/challenges/start?unique_code={code}`（query，body `{}`；`prefix` 用 list 成功的那个，托管是 `/openapi/v1`）→ `container_addr`。失败或地址为空：**不** bootstrap、**不** 拉 dsh
3. `mkdir $CONTEST_WORKDIR/<problemId>/`（id 规范成 `[a-z0-9_-]{1,64}`，与 `ProjectRegistry.normalizeId` 相同）
4. 按本遍选 profile（`profile_for_visit`）。默认 `on_fail`：新题用 `contest-baseline`，忽略 `CONTEST_FGS_AFTER_SEC`。失败二遍才用 `contest`。`mode=after_sec` 才按 driver 启动时钟走旧的 `profile_for_now`。baseline **不**跑 bootstrap。FGS profile 才执行 `node tools/bootstrap_project.mjs --cwd <该目录> --problem-id <id> --brief <description + addr> --target <addr> --criterion '取得有效 flag 并 submit correct=true'`，并验收 `.fgs/competition.json` 的 `activeProblemId` 以及 `projects/<id>/graph.yaml` 含 `fact_origin` 和 `goal_final`。二遍还会把 baseline 产物补成 Fact / Intent（`tools/apply_enrich.mjs`）
5. 把对手 Solver 任务书写入 `prompt.txt`（纪律段逐字，题目块来自 list/start）。两边都写这份任务书。任务书含输出纪律：工具调用前可见文字 ≤2 句，通关后只交 flag 加一句结论。运行时轻约束（`agent/pre-step` 注入，不是新 tool）见 [`contest/UPLOAD_ENV.md`](contest/UPLOAD_ENV.md)「Baseline 轻约束」。
6. 拉起 `dsh --profile <选中的 profile> --json prompt.txt`（cwd = 该目录），环境注入 `FGS_UNIQUE_CODE=<unique_code>`（与 start/close 题号相同，不改 `BENCHMARK_*`）。harness 未装时写 launch stub。`.fgs/dsh-launch.json` 记录 `protocol: anthropic_messages`、`provider: deepseek-official` 和选中的 profile

写盘复用 `ProjectRegistry`、`GraphStore`、`Controller.apply(seedOriginOp)`，不另造图格式。有 `target` 时 origin 正文与 `/fgs new` 一样是 `{target, brief}` 的 JSON。已有 `fact_origin` + `goal_final` 时第二次调用 **幂等成功**，不覆盖图（之后 Decide 写下的 step 还在）。缺 brief、id 非法、cwd 不可写则 exit 1。

```bash
node tools/bootstrap_project.mjs \
  --cwd /tmp/work/a-10 \
  --problem-id a-10 \
  --brief '题面……' \
  --target 'http://10.0.0.8:8080'
```

stdout 一行 JSON：`status` 为 `seeded` 或 `already-seeded`。

### 镜像

示例见 `contest/Dockerfile`：`ENTRYPOINT ["contest/entrypoint.sh"]`。构建上下文不要把密钥拷进去。上传仍是 `docker save … | gzip`，上限 3GB。这个示例骨架不安装 dsh，也不安装 `/opt/dsh-ops`。它把仓库里的 `profiles/contest-baseline` 和 `profiles/contest` 拷到 `$DSH_HOME/profiles/`（这两份是 `thinking: enabled`，`bundles` 不含 dsh-ops，patch 里也没有 dsh-ops 组件），并把默认 profile 设成 `contest-baseline`。`docker build -f contest/Dockerfile` 得到的镜像与下面的正式包是两份东西。正式 tarball 见「[正式竞赛镜像（Release）](#contest-image-release)」。上传页环境见 [`contest/UPLOAD_ENV.md`](contest/UPLOAD_ENV.md)。

```bash
docker build -f contest/Dockerfile -t fgs-contest .
```

离线验收（无模型、无平台）：

```bash
node --test tests/bootstrap_project.test.mjs tests/contest_driver.test.mjs tests/contest_supervisor.test.mjs tests/contest_baseline.test.mjs tests/contest_fail_then_fgs.test.mjs tests/contest_light_constraint.test.mjs
```

<a id="contest-image-release"></a>

### 正式竞赛镜像（Release）

当前正式包是 Release [`contest-image-6b5d71f`](https://github.com/whickerpoplawski-arch/fgs-v4/releases/tag/contest-image-6b5d71f)，对应提交 `6b5d71f2bcb684b452998316adc27fb7b56ba29e`。下载 [`agent.tar.gz`](https://github.com/whickerpoplawski-arch/fgs-v4/releases/download/contest-image-6b5d71f/agent.tar.gz)。SHA256 `e1713e1485e1fccf3361b452823efaa79779ce3fc0fbe0dbcf32f3b260634ccf`。

- dsh：`@deepseek-ai/dsh@0.2.1-rc.2`（上一份正式烘包是 `0.2.0-rc.2`）。
- 工具面：dsh 自带的 bash / 文件工具。`contest-baseline` 和 `contest` 都不挂 dsh-ops。只有 `contest` 有 FGS。
- Messages 仍是 `deepseek-official` + `https://api.deepseek.com/anthropic`。**`thinking: enabled`**。dsh 0.2.1-rc.2 在 `thinking: disabled` 时会 TRANSPORT 失败。

本仓库的 `profiles/contest/cordis.patch.yml` 和 `profiles/contest-baseline/cordis.patch.yml` 都是 `thinking: enabled`，不再声明 dsh-ops 组件。两份 profile 的 `package.json` 都不把 `dsh-ops` 放进 `bundles`，`dependencies` 里也没有 `file:/opt/dsh-ops`。在 `profiles/contest` 或 `profiles/contest-baseline` 里跑 `npm install` 不需要 `/opt/dsh-ops`（`contest` 仍要 `/opt/fgs-v4`，`contest-baseline` 仍要 `/opt/fgs-v4/contest-benchmark-tools`）。`contest/Dockerfile` 是示例骨架：不安装 dsh，也不安装 dsh-ops，拷贝的是仓库里的这两份 profile。`docker build -f contest/Dockerfile` 不会得到上面的 `agent.tar.gz`。

已发布的 [`contest-image-6b5d71f`](https://github.com/whickerpoplawski-arch/fgs-v4/releases/tag/contest-image-6b5d71f) tarball 仍是去掉 dsh-ops 之前的烘包。按当前 profile 重新烘包时不要再装 dsh-ops。

## 契约对照

| CONTRACT | 落点 |
|---|---|
| §1 MVP 范围 | 单 `goal_final`（`validate` 拒 `goal_sub`/`kind:sub`），无 findings/租约 |
| §2 图序列化唯一真源 | `yaml.js` + `GraphStore.load/save`；非法顶层键直接拒读；ID 规则进 validate |
| §3 单写者 Controller | `controller/index.js`；写路径先 `hooks/validate_write.preflight`（有计数器证明调用） |
| §4 Decide 白名单 / 禁环境工具 | 白名单（`decideAllowTools`）：默认只留规划工具 + 元工具，bash/文件/网络/subagent/workflow 全拒 |
| §5 Execute 收束 | 一轮只吃一个 open step（按本 Project run 的 `roundSeq`；宿主 turn 只推进这一题的计数）；回合收口强制观察 Fact |
| §6 reopen | 清空 `satisfied*` + feedback Fact，永不删历史 |
| §7 Fact 蒸馏 | title ≤120 字；content 超阈值必须是路径 |
| §8 因果 + satisfy 硬门 | `from` 非空、`producedBy` 必填、verify hook 前置 |
| §9 干净上下文 / I/O 预制 / 上下文同步 | `hooks/sync_context` + `systemPrompt.section`/`context`（每步注入本会话图投影 + 该角色 io-spec）；图工具出参按 `maxResultChars` 截断 |
| §10 测试资产 | `fixtures/` 三份 + `tests/`（controller / role / flag / 离线 replay） |
| §11 目录落点 | 见上「目录」 |

## 测试

```bash
cd <插件目录>            # 你 clone / 解压出来的仓库根目录
node --test "tests/*.test.mjs"
```

离线、零依赖，直接跑即可（本机实测 **228 tests / 228 pass**）。基线对比用的 gen9 源码已作为
`tests/fixtures/fgs-v3-baseline.index.js` 收进仓库，所以**不需要任何仓库外的兄弟目录**。

覆盖：Project 建题/切换/列表、两题图与草稿隔离、旧单图迁移、无活动 Project 时拒改图、YAML 往返与真实 `cordis.patch.yml`、Controller 全部拒写路径（空 `from` /
缺 `reason` / 缺 `satisfy_goal` 字段 / 超长 fact / 无 `producedBy` / 非 open step /
FLAG verify 失败不落盘 / reopen 清空且不删历史）、角色隔离与 Decide 白名单、回合语义
（一轮一个 step、回合收口强制观察 Fact）、显式 stepId 不许换 step、`/fgs` 命令、
运行时上下文与 io-specs 注入、出参截断、HTTP 快照按会话取图、固定 JSON 轨迹离线 replay、
无 LLM 磁盘预种（含重复 bootstrap 幂等）以及 contest fixture 的 list→start→预种顺序。

`tests/contract_fixes.test.mjs` 是对抗性审计发现项的回归：审计用哪一招打进来，就用哪一招锁回去。

> ⚠️ 改动 `index.js` 后**必须重启 Harness 进程**才会加载新模块代次
> （`set_plugin` / 重装 bundle 都不会换掉已加载的 JS 模块；`/fgs/state` 返回的
> `pluginGeneration` 可用来确认当前跑的是哪一代；M1 为代次 **4**，`buildTag` 含 `+project`）。
