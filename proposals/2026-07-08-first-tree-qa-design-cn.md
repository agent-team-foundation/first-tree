# First Tree QA Package 技术方案草稿（中文）

日期：2026-07-03
更新：2026-07-06
更新：2026-07-07（对抗性审查修订，结论与决议见 §14）
更新：2026-07-07（本地手工执行三个示例 case 后的运行契约修订，结论与决议见 §14 第三轮）
更新：2026-07-07（provider bridge 实测修订，结论与决议见 §14 第四轮）

状态：Draft PR discussion copy。本文来自本地中文技术方案草稿，用于团队内审阅和对齐；正式采纳后仍应同步到 Context Tree proposal。

## 1. 目标

本方案为 First Tree 设计一个新的内部 monorepo package：`@first-tree/qa`。

它的目标不是引入一个自动化测试平台，也不是让 agent 替代产品测试，而是把团队内 agent 执行 QA 工作所需的工作流、环境、用例、模板和职责边界组织成一个统一入口，让任一 agent 都能进入 QA 角色完成一次可复现、可审计、不会污染被测对象的 QA 闭环。

最小闭环固定为：

1. 接收 QA task request，明确被测目标、scope、上下文和环境约束。
2. 读取相关上下文。
3. 创建本次 run 的 QA plan 中间产物。
4. 在隔离环境中初始化完整本地系统。
5. 执行黑盒验证，并记录 setup、命令、服务日志、网络/API 观察、DB 变化和 UI evidence。
6. 产出 QA report；如失败，产出结构化 bug artifact。

## 2. 设计原则

### 2.1 QA 角色不修改被测对象

QA 角色的职责是验证、记录和反馈，不直接修复本次正在验证的对象。

这不是简单的路径规则。某个配置文件、测试数据或 runtime 配置如果本身就是 case 的测试对象，可以在 case 步骤中被修改；但修改必须发生在临时 git worktree + Docker 环境内，并在报告中说明它是测试步骤的一部分。

普通 QA 执行任务不得修改原始工作区、产品源码、迁移、产品测试或运行时配置。测试用例维护任务可以修改 `packages/qa/cases/**`，因为 case 是 QA 资产，不是本次被测对象。

### 2.2 正式 QA 必须运行在 Docker + 临时 git worktree

正式 QA 不直接在开发者原始工作区执行。

QA agent 先创建临时目录，再用 `git worktree` materialize 被测 git ref。Docker 环境只使用这个临时 worktree 作为 source root。容器可以在临时 worktree 内写入 `node_modules`、build output、logs、local homes、database state 等运行产物；这些产物随临时目录丢弃。

原始 repo 只作为创建 worktree 的来源，不挂载到容器里作为工作目录。

### 2.3 过程产物不进入 source repo

QA plan、report、bug artifact、evidence、logs 和环境摘要都是过程产物。它们写入临时 run 目录，例如：

```text
<tmp>/first-tree-qa-runs/<run-id>/
  repo.git/             # 一次性 bare repo
  source/              # git worktree
  artifacts/
    plan.md
    run-events.jsonl
    execution-log.md
    report.md
    paths.json
    case-results/
    bugs/
    commands/
    services/
    network/
    data/
    db/
    evidence/
      screenshots/
      browser-traces/
      api-responses/
    logs/
    env-summary.md
```

agent 最终把必要结论反馈给开发者，并可引用本机 artifact 路径。过程产物不提交。

artifact 路径必须在宿主与容器之间有明确映射。v1 标准做法是先计算 run root 的 `realpath`，再把整个 run root 以相同绝对路径挂载进 Docker。这样宿主和容器都能用同一个 `<run-root-real>/artifacts/...` 路径引用证据，避免断言、日志和 DB snapshot 在容器内外路径错位。

### 2.4 agent 执行，脚本不托管生命周期

`@first-tree/qa` 不提供正式 CLI/bin，也不以 `qa env up/down` 之类命令托管环境生命周期。

agent 通过 briefing 理解并执行固定流程；package 提供 Docker/Compose 配置、模板、case 和规范。这样保留 agent 的现场判断，同时让环境定义、case schema 和职责规则统一。

### 2.5 结构化自然语言 case 优先

QA case 优先是面向 agent 的 Markdown frontmatter-only checklist。它用结构化自然语言指导 agent 选择验证路径、检查执行前状态、按顺序操作和观察系统、采集证据并判断结果。

如果某个验证可以稳定地做成可执行 scenario/spec，应优先放回产品自身的单元测试、集成测试或 E2E 测试体系中，而不是把 `@first-tree/qa` 变成第二套测试 runner。

### 2.6 Observability 是正式 QA 的必需环节

正式 QA 不能只给结论。每次 run 都必须留下最小可追溯证据链，说明 agent 做了什么、系统运行到了什么状态、哪些网络/API 行为发生过、相关 DB 数据如何变化、Web UI 的可见结果是什么。

最小 observability 不等于全量抓包或全程录像。v1 的默认能力应覆盖命令日志、服务日志、HTTP/API evidence、case 相关 DB snapshot/diff、Web screenshot/console log。raw packet capture、pgaudit、Playwright 全量 trace/video 可以作为深度 profile，在 case 需要时启用。

## 3. Package 定位

`@first-tree/qa` 是内部工具 package，不发布 npm，不提供 CLI/bin。它是 First Tree monorepo 内的 QA 资产包和 agent 工作流入口。

建议目录：

```text
packages/qa/
  package.json
  AGENTS.md
  briefings/
    setup-environment.md
    run-qa.md
    maintain-cases.md
  cases/
    README.md
    onboarding/
    team/
    agents/
    chat/
    runtime/
    context-tree/
    context-management/
    github/
    release/
    cli/
  fixtures/
    README.md
  env/
    Dockerfile
    docker-compose.qa.yml
    env.example
    README.md
  observability/
    README.md
    db-snapshot.example.sql
  schemas/
    qa-case.schema.md
  templates/
    qa-case.md
    qa-task-brief.md
    qa-plan.md
    case-result.md
    qa-report.md
    bug-artifact.md
```

`package.json` 只用于 monorepo ownership、dependency declaration 和后续可能的 schema tooling；v1 不设计 user-facing bin。

## 4. 三个主要部分

### 4.0 QA 任务输入契约

一次 QA task 从 task request 开始，不从完整 test plan 开始。task request 给 QA agent 足够信息理解被测对象和目标置信度；QA plan 是 agent 阅读 request、上下文、QA case 和环境约束后生成的本次 run 中间产物。

必需输入：

- **Target identity**：repo、source path、branch/commit/PR ref 或 patch identity。如果目标不可复现，request 必须明确说明。
- **QA objective**：feature validation、regression check、bug reproduction、release smoke、runtime/provider validation、exploratory risk pass，或其他明确 QA intent。
- **Scope and evidence boundaries**：需要验证的产品区域和可观察边界，例如 CLI、HTTP API、Web UI、server behavior、runtime/daemon behavior、DB state、provider behavior、integration flow。
- **Context pointers**：issue、PR、design proposal、Context Tree nodes、source areas、prior reports，或其他必须阅读材料。
- **Expected behavior / risk focus**：应成立的行为、需要保护的用户 workflow、已知回归风险或需要重点关注的 risk area。
- **Environment constraints**：provider/auth 假设、data/fixture 需求、required data profile、browser/device 需求、callback/webhook 需求、external access 需求，以及 agent 不能安全推断的 setup。
- **Reporting expectation**：谁需要结果、FAIL 是否需要逐个 bug artifact、deadline 或 scope limit。

可选输入：

- 建议使用的 QA cases 或 case 目录
- seed data 示例
- 账号或 provider state，受 provider/auth policy 约束
- 相关历史 QA artifacts
- 明确 out-of-scope
- 已知 flaky area 或环境风险

由 agent 在 plan 阶段决定的内容，不应强制作为输入：

- selected case set 和 execution order
- run id、临时 run root、Compose project name、discovered URLs
- 具体 command sequence 和 readiness gates
- selected environment baseline 和 case data setup sequence
- observability plan 和 evidence paths
- case result judgment
- 最终 report 和 bug artifacts

因此，test plan / QA plan 是每次 run 的中间产物，写入 `artifacts/plan.md`。如果人类在 task request 中提供了 test plan，agent 把它视为输入上下文或约束，然后在本次生成的 QA plan 中采纳、调整或说明偏离原因。本次生成的 QA plan 才是 run 的 artifact of record。

如果缺失的必需输入无法从本地上下文中安全推断，agent 应在正式 QA 前请求澄清；如果缺失项是 setup 中才发现的环境、凭据或数据前置条件，则结果应为 `BLOCKED`。

### 4.1 测试用例维护

测试用例放在：

```text
packages/qa/cases/**/*.md
```

case 文件使用 `.md`，但 v1 是 frontmatter-only。Markdown body 为空，避免 frontmatter 和正文形成两份事实来源。

v1 schema 保持精简稳定，必填字段：

```yaml
---
id: string
description: string
domains: string[]
surfaces: string[]
preconditions:
  must_have: string[]
  must_not_have: string[]
flow:
  - a: string
    a1: string
    a2: string
evidence: string[]
---
```

字段口径：

- `id`：全局稳定的 case identity，替代 `title` 的引用作用。
- `description`：非结构化概括内容，说明 case 存在原因、验证边界或风险背景。
- `domains`：QA 自维护的 domain 名称数组，例如 `team`、`agents`、`chat`、`runtime`、`context-tree`、`github`、`onboarding`、`release`、`context-management`、`cli`。domain 词表不强制绑定 Context Tree 结构：`packages/qa/cases/README.md` 是 domain 词表和目录结构的 owner，命名尽量对齐 Context Tree domain 以便 agent 选上下文，但新增/调整 domain 属于 case 维护工作流，不依赖 Context Tree 变更。数组首个 domain 是 primary domain，决定 case 所在目录。其中 `cli` 只在 primary validation question 属于 CLI shell / command surface / output contract 本身时使用；如果 CLI 只是执行某个产品行为的入口，`domains` 使用对应 owner domain，`cli` 放入 `surfaces` 或 `operate cli-command`。
- `surfaces`：First Tree workspace / sub-package impact tags，例如 `cli`、`client`、`server`、`web`、`shared`、`doc-website`、`skill-evals`、`qa`。它不是产品入口、Docker service 或操作/观察对象。
- `preconditions.must_have`：case 执行前必须成立的状态。
- `preconditions.must_not_have`：case 执行前必须不存在的污染、缓存、授权、残留数据或其他会掩盖结果的状态。两个键都必须存在；`must_not_have` 允许显式空数组，但空必须是有意判断的结果，不是省略。
- `flow`：有序 BranchFlow 列表；每个 branch object 先用 `a`、`b`、`c` 写分支断言，再用 `a1`、`a2`、`a3` 写该分支下的 action；每条 action value 格式为 `<operate|observe> <object>: <action detail>`。action 执行顺序以数字后缀升序为准，从 1 连续编号；单分支超过 9 条 action 视为 case 过大，应拆分。每个 branch 必须至少包含一条 `operate` 和一条 `observe`。action 必须描述产品入口、公开 contract、或 agent 可执行的黑盒动作，不把参考目录里的临时 probe / harness 当作未声明依赖。
- `evidence`：case 必须留下的证据类型，自由文本；实际的 observe action 绑定和 artifact path 由本次 run 的 case result（`templates/case-result.md`）记录。每条 evidence 必须能追溯到 `flow` 中至少一个 `observe` action，这一映射在 case 维护 review 时人工核对，在 case result 中按 action key 显式落地。

v1 暂不引入 `title`、`type`、`risk`、`data_profile`、`failure_guidance`、`non_goals`。这些要么已经被其他字段替代，要么属于本次 QA plan / report 的判断，不是 case 本身的稳定属性。

`flow` 中的 `<object>` 不等于 `surfaces`。`surfaces` 标记 repo 内相关 workspace / package；`flow` object 标记 agent 实际操作或观察的对象。

同一个 case 可以通过扩展 `flow` 记录多个正常和异常分支，但这些分支必须服务同一个 primary validation question。v1 不新增 `variants` 字段；`flow` 使用有序 BranchFlow 列表，每个 item 用 `a`、`b`、`c` 写分支断言，例如 `"Binary in ~/.local/bin can be detected."`，并用 `a1`、`a2`、`a3` 写该分支 action。一个 case 内的正常和异常分支应尽可能覆盖该 primary validation question 下的主要情况；本次实际执行或跳过哪些分支，以及每个分支的 artifact path，由 QA plan / report 记录。branch assertion 和 action value 都必须整体加引号。

如果 PASS 需要多维 evidence，例如 command output、DB state、API response、fixture checksum、screenshot、service log，`flow` 中必须分别出现对应的 `observe` action。`evidence` 不允许引入 `flow` 没有观察过的新事实。

v1 operate object：

| object | 含义 |
| --- | --- |
| `environment` | 操作 Docker compose、temporary git worktree、container、network、volume、readiness gate。 |
| `filesystem` | 操作隔离 worktree、临时 home、配置文件、provider binary、Context Tree fixture 等本地文件状态。 |
| `cli-command` | 运行 in-tree First Tree CLI 命令。 |
| `browser-ui` | 通过浏览器操作 Web UI。 |
| `http-api` | 直接操作 Server HTTP API，例如 curl / fetch / API probe。 |
| `runtime-process` | 启动、停止、绑定、配置 local client daemon / runtime / session / computer。 |
| `db-state` | 准备或重置 DB 数据；主要用于 environment baseline 或 case precondition。 |
| `external-service` | 操作 GitHub、provider/auth、callback、tunnel 等外部依赖状态。 |

v1 observe object：

| object | 含义 |
| --- | --- |
| `run-event-log` | 观察或引用 `artifacts/run-events.jsonl` 中的 setup、case execution、evidence capture、failure、cleanup 事件。 |
| `command-output` | stdout、stderr、exit code，例如 CLI、install、build、check、case command 输出。 |
| `service-log` | server、web、client、runtime、container logs。 |
| `container-state` | `docker compose ps`、healthcheck、端口、network、volume 状态。 |
| `http-api` | HTTP status、redacted headers、body summary、safe full body、API response artifact、access log。 |
| `network-traffic` | HAR、proxy log、internal Docker network 请求记录。 |
| `db-state` | before/after snapshot、只读 SQL 查询输出、diff 或 observation note。 |
| `browser-ui` | Web 可见状态、截图、交互后的 UI 结果。 |
| `browser-console` | console error/warning/log。 |
| `runtime-event` | client/runtime WebSocket、Inbox、session、agent bind、provider capability 等运行时事件。 |
| `filesystem` | 文件生成结果、配置状态、Context Tree snapshot/local fixture 状态。 |
| `external-service` | GitHub/provider/callback/tunnel 的外部可见状态。 |

case 维护属于独立 workflow：`briefings/maintain-cases.md`。它允许修改 QA 资产，例如 `packages/qa/cases/**` 和模板，但不允许顺手修改产品实现。

### 4.1.1 Test Case 颗粒度与组合

QA case 是围绕一个稳定行为、风险或可观察 workflow slice 的可复用 QA 资产。它不等于一次完整 QA task，也不应该把整套 feature end-to-end 验证全部塞进一个 case，除非该 feature 本身就是很小且稳定的 workflow。

颗粒度规则：

- 一个 case 应只有一个 primary validation question 和一个 primary result。
- 一个 case 可以跨多个 workspace tag 或 observe object，但这些边界必须服务于同一个验证问题。
- 一个 case 必须有明确 `preconditions.must_have`、`preconditions.must_not_have`、`flow` 和 `evidence`。
- 一个 case 应通过 preconditions 声明 data preconditions 和 expected data changes；本次 run 的 QA plan 负责决定具体 materialization sequence。
- 一个 case 应避免隐藏依赖其他 case。共享 setup 写在 QA plan 或显式 preconditions 中。
- 一个 case 应足够稳定，可以在未来任务中复用。一次性探索记录应留在本次 run 的 plan/report，除非它揭示了可复用风险。
- 一个 case 不应重复确定性的 unit/integration/E2E test。如果某个检查可以稳定自动化且属于产品正确性契约，应回到产品测试体系。
- 一个 case 不应把参考目录中的临时 probe、历史 QA 命令或本次探索 helper 固化成隐含执行依赖；它应描述产品入口或 agent 可以执行的黑盒动作。
- 一个 case 的每条 evidence 必须由 `flow` 中的 observe action 支撑；多维 evidence 需要多维 observe。

一次 QA task 通过 QA plan 组合多个 case。例如一次 feature QA task 可以包含：

- setup/readiness case
- 一个或多个 primary workflow cases
- 相关 integration / DB-state cases
- 与变更区域相关的 regression cases
- 暂未沉淀为 case 的 exploratory checklist

QA plan 记录 selected cases、execution order、shared setup、explicit skipped cases 和 ad hoc checks。report 同时记录 `artifacts/case-results/` 下的 case-level results，以及覆盖整个 task scope 的 top-level result。

不要通过给每个参数组合都新建 case 来制造 case matrix。variant 默认在 QA plan 中参数化；只有当某个 variant 代表高频、高风险、且有独立 setup/evidence/expected outcome 时，才沉淀为独立 case。

### 4.2 环境初始化

环境初始化由 `briefings/setup-environment.md` 指导，`packages/qa/env/**` 提供固定 Docker 资产。

### 4.2.1 已跑通的 v1 模型

2026-07-03 本地实践使用 `first-tree` commit `274837e2` 跑通了以下闭环：

- 创建临时 run root：`/tmp/first-tree-qa-runs/practice-bare-20260703-191443`
- 在 run root 内创建一次性 bare repo：`repo.git`
- 从该 bare repo 创建 detached `git worktree`：`source`
- 用 Docker Compose 启动 Docker-only run cell；早期实践使用 `postgres` + `app`，本轮手工执行示例 case 后的 v1 口径拆为 `postgres`、`cli`、`server`、`web`，daemon/runtime 也在 run cell 内启动。
- 在 Docker run cell 内运行 pnpm install、Drizzle migrate、server/web/client/CLI build、server/web service start、`pnpm check`、`pnpm typecheck`
- 从宿主访问 server `/healthz`、web `/`、web proxy `/api/v1/health`

这个实践修正了两个关键细节：

1. **不要直接从原始 repo 创建 worktree 再只挂载 worktree。** 宿主 `git worktree` 的 `.git` 文件会指向原 repo 下的绝对 gitdir，容器无法访问，`git rev-parse` 会失败。正确做法是在 run root 里先创建一次性 bare clone，再从这个临时 bare clone 创建 worktree。
2. **容器内必须能访问 gitdir 的 realpath。** macOS 上 `/tmp` 是 `/private/tmp` 的 symlink，Git 写进 `.git` 的路径是 `/private/tmp/...`。因此 setup 必须先 `realpath "$RUN_ROOT"`，并把 realpath 同路径挂载进容器。

推荐 setup 流程：

1. agent 选择目标 git ref。正式 QA 应尽量针对可 materialize 的 branch/commit/PR ref；如果目标只有 dirty workspace diff，agent 应先反馈需要明确被测 diff，或在报告中把它标成非标准输入。
2. agent 创建临时 run 目录，并解析 realpath。
3. agent 创建临时 bare repo：

   ```bash
   git clone --bare --no-hardlinks <source-repo> "$RUN_ROOT_REAL/repo.git"
   ```

4. agent 从临时 bare repo 创建 detached worktree：

   ```bash
   git --git-dir="$RUN_ROOT_REAL/repo.git" worktree add --detach "$RUN_ROOT_REAL/source" <target-ref>
   ```

5. agent 生成 tmp worktree 专用 `.env`，不要复制开发者原始 `.env`。
6. agent 启动 Docker Compose。
7. agent 在容器内完成 install/build/migrate/seed/dev-server/daemon 等步骤。
8. 环境无法启动时，agent 立刻反馈 `BLOCKED`，不继续包装成完整 QA report。

#### 4.2.1.1 QA run cell contract

本地试运行确认：v1 必须把 run cell 当作一个有契约的运行单元，而不是一组临时命令。一个正式 run cell 的最小契约如下：

- **Source boundary**：容器内的产品源码只来自 `<run-root-real>/source`，它由 `<run-root-real>/repo.git` materialize，不挂载原始 checkout。
- **Path boundary**：`<run-root-real>` 必须以同一绝对路径挂载进所有需要读写 artifact 的容器；`/workspace` 可以指向 `<run-root-real>/source`，但 artifact path 以 `<run-root-real>/artifacts` 为准。
- **Service boundary**：web、server、db、CLI runner、daemon/runtime runner 都在 Docker 环境中运行。宿主只负责创建 run root、调用 Docker、访问 loopback URL、汇总 artifact。
- **Network boundary**：服务间通过 Compose network 访问；Postgres 默认不暴露到宿主；server/web 只有在需要宿主 curl、浏览器或截图时暴露 loopback 动态端口。
- **State boundary**：Postgres data、First Tree home、provider test state、server workspaces、pnpm store、browser profile、daemon/runtime home 都必须是 run-local volume 或 run-root 子目录。
- **Artifact boundary**：所有 command output、service log、API/DB observation、screenshot、browser trace、case result、bug artifact 写入 `<run-root-real>/artifacts`。
- **Identity boundary**：run id、Compose project name、target ref、discovered host ports、service URLs、provider readiness、external access mode 必须写入 `artifacts/env-summary.md`；机器可读映射可写入 `artifacts/paths.json`。

推荐 `paths.json` 最小字段：

```json
{
  "run_root": "/private/tmp/first-tree-qa-runs/<run-id>",
  "source": "/private/tmp/first-tree-qa-runs/<run-id>/source",
  "artifacts": "/private/tmp/first-tree-qa-runs/<run-id>/artifacts",
  "compose_project": "ftqa_<run-id>",
  "server_url": "http://127.0.0.1:<port>",
  "web_url": "http://127.0.0.1:<port>"
}
```

### 4.2.2 Docker/Compose 依赖

已验证的 Node service image 需要：

- `node:24-bookworm-slim`
- `corepack`，使用 repo `packageManager` 指定的 pnpm 10.12.1
- `git`
- `ca-certificates`
- `openssl`
- `python3`
- `make`
- `g++`

已验证的 compose service roles：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: firsttree_qa
      POSTGRES_USER: firsttree_qa
      POSTGRES_PASSWORD: firsttree_qa
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U firsttree_qa -d firsttree_qa"]

  cli:
    image: node:24-bookworm
    working_dir: /workspace
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      HOME: /qa-home
      FIRST_TREE_HOME: /qa-home/first-tree
      FIRST_TREE_CHANNEL: dev
      FIRST_TREE_SERVER_URL: http://server:8000
      PNPM_HOME: /pnpm
      PNPM_STORE_DIR: /pnpm/store
    volumes:
      - <run-root-real>/source:/workspace
      - <run-root-real>:<run-root-real>
      - pnpm-store:/pnpm/store
      - qa-home:/qa-home
    command: sh -lc "corepack enable && pnpm config set store-dir /pnpm/store && sleep infinity"

  server:
    image: node:24-bookworm
    working_dir: /workspace/packages/server
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://firsttree_qa:firsttree_qa@postgres:5432/firsttree_qa
      FIRST_TREE_DATABASE_URL: postgresql://firsttree_qa:firsttree_qa@postgres:5432/firsttree_qa
      FIRST_TREE_CHANNEL: dev
      FIRST_TREE_HOST: 0.0.0.0
      FIRST_TREE_PORT: 8000
      FIRST_TREE_PUBLIC_URL: http://server:8000
      FIRST_TREE_HOME: /qa-home/first-tree
      PNPM_HOME: /pnpm
      PNPM_STORE_DIR: /pnpm/store
    ports:
      - "127.0.0.1::8000"
    volumes:
      - <run-root-real>/source:/workspace
      - <run-root-real>:<run-root-real>
      - pnpm-store:/pnpm/store
      - qa-home:/qa-home
    command: sh -lc "corepack enable && pnpm config set store-dir /pnpm/store && pnpm exec tsx src/index.ts"

  web:
    image: node:24-bookworm
    working_dir: /workspace/packages/web
    depends_on:
      server:
        condition: service_started
    environment:
      VITE_API_BASE_URL: http://server:8000
      PNPM_HOME: /pnpm
      PNPM_STORE_DIR: /pnpm/store
    ports:
      - "127.0.0.1::5173"
    volumes:
      - <run-root-real>/source:/workspace
      - <run-root-real>:<run-root-real>
      - pnpm-store:/pnpm/store
    command: sh -lc "corepack enable && pnpm config set store-dir /pnpm/store && pnpm exec vite --host 0.0.0.0"

volumes:
  pnpm-store:
  qa-home:
```

注意：

- Postgres 不需要默认暴露 host port；server/cli 通过 `postgres:5432` 访问。
- web、server、db、cli runner、daemon/runtime runner 都属于 Docker run cell。正式 QA 不应在宿主直接运行 dev server、server、db 或 candidate CLI。
- server/web host ports 应允许 override，避免端口冲突。
- `DATABASE_URL` 和 `FIRST_TREE_DATABASE_URL` 都要设置。Drizzle tooling 读 `DATABASE_URL`，server runtime 读 `FIRST_TREE_DATABASE_URL`。
- `FIRST_TREE_PUBLIC_URL` 与动态端口策略存在先后关系：使用 `127.0.0.1::8000` 动态分配时，compose environment 里写不出实际 host port。已验证做法是容器先起、`docker compose port` 发现映射端口，再在容器内启动 server 进程时注入 PUBLIC_URL。compose 片段中的 `http://localhost:<server-host-port>` 只在使用显式 host port 时才能预先写死；需要稳定 PUBLIC_URL 的 case（OAuth/callback 等）应显式指定端口。
- pnpm store 必须放到 Docker volume，例如 `/pnpm/store`。实践中 `PNPM_STORE_DIR` 环境变量不够，必须用 `pnpm install --store-dir /pnpm/store --frozen-lockfile` 或写 `.npmrc`。否则 pnpm 会在 worktree 里生成 `.pnpm-store`，导致 `pnpm check` 被 Biome 扫依赖缓存而失败。
- `pnpm install` 目前会提示 ignored build scripts：`@sentry/cli`、`bcrypt`、`cpu-features`、`esbuild`、`protobufjs`、`ssh2`。本次实践中 server/web/client/CLI build、`pnpm check`、`pnpm typecheck` 仍通过，但 setup briefing 应要求 agent 记录该警告；如果某个 case 触碰 native/runtime 行为，应把它作为风险或主动处理 `pnpm approve-builds`。

### 4.2.3 已验证命令

在 `cli` 容器内执行安装、构建、迁移、CLI 探测等一次性命令：

```bash
node -v
corepack pnpm -v
git rev-parse --show-toplevel
git rev-parse --short HEAD
corepack pnpm install --store-dir /pnpm/store --frozen-lockfile
corepack pnpm --filter @first-tree/server db:migrate
corepack pnpm --filter @first-tree/server build
corepack pnpm --filter @first-tree/client build
corepack pnpm --filter first-tree-dev build
node apps/cli/dist/cli/index.mjs --help
corepack pnpm check
corepack pnpm typecheck
```

启动并验证产品运行入口：

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" up -d postgres cli server web
docker compose -p "$COMPOSE_PROJECT_NAME" port server 8000
docker compose -p "$COMPOSE_PROJECT_NAME" port web 5173
curl http://127.0.0.1:<server-host-port>/healthz
curl http://127.0.0.1:<web-host-port>/
curl http://127.0.0.1:<web-host-port>/api/v1/health
```

本地实践结果：

- `/healthz` 返回 `{"status":"ok"}`
- Web root 返回 HTML
- Web proxy `/api/v1/health` 返回 `{"status":"ok","db":"connected"}`
- `pnpm check` 退出码 0，仅有当前 repo 已存在 warning/info
- `pnpm typecheck` 退出码 0
- 临时 worktree `git status --short` 为空；install/build/check 没有产生可提交污染

### 4.2.4 本地多环境并发运行

本地机器上可能同时有多个 agent 对多个功能做 QA。v1 不需要中央调度器，但每次正式 QA 都必须是独立的 run cell。

一个 run cell 包含：

- 一个临时 run root
- 一个 run root 内的一次性 bare repo
- 一个从该 bare repo 创建的 source worktree
- 一个唯一 Docker Compose project name
- 一个由 Compose project 隔离的 Docker network
- 一组由 Compose project 隔离的 Docker volumes
- 一个 run root 内的 artifact tree
- 一组运行时发现的本地访问 URL

run id 应唯一且可读，例如：

```text
20260703-191443-agent-a-274837e-web-settings
```

Compose project name 从 run id 归一化得到，例如：

```text
COMPOSE_PROJECT_NAME=ftqa_20260703_191443_agent_a_274837e_web_settings
```

Compose project name 是本地隔离 key。compose 文件内部仍可使用稳定 volume 名称，例如 `postgres-data`、`pnpm-store`、`qa-home`、`runtime-home`；由于 project name 不同，Docker 实际创建的 network/container/volume 互不相同。

默认端口策略：

- Postgres 不暴露 host port，只在 Compose network 中以 `postgres:5432` 被 server/cli 访问。
- server/web 需要宿主 curl、浏览器或截图时，默认绑定 loopback 动态端口。
- 固定 callback/OAuth/webhook 场景可以主动指定 host port；如果冲突，属于环境前置失败，agent 应换用允许的端口或反馈 `BLOCKED`，不能把两个 QA run 合并到同一个 Compose project。

推荐 compose 端口写法：

```yaml
ports:
  - "127.0.0.1::8000"
  - "127.0.0.1::5173"
```

agent 启动后发现实际端口：

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" port server 8000
docker compose -p "$COMPOSE_PROJECT_NAME" port web 5173
```

2026-07-03 本地用同一 compose 文件启动两个不同 project，已验证 Docker 会分配不同 host port，并且两个映射 URL 分别命中各自 project 的 service。因此默认不需要 agent 预先协商端口。

每个 run 应写入环境摘要，例如：

```text
run_id=20260703-191443-agent-a-274837e-web-settings
compose_project=ftqa_20260703_191443_agent_a_274837e_web_settings
target_ref=274837e2
run_root=/private/tmp/first-tree-qa-runs/20260703-191443-agent-a-274837e-web-settings
source=/private/tmp/first-tree-qa-runs/20260703-191443-agent-a-274837e-web-settings/source
server_url=http://127.0.0.1:58100
web_url=http://127.0.0.1:55174
```

共享资源原则：

- Docker image layer/build cache 可以由 Docker 自己共享。
- 默认 pnpm store volume 应按 Compose project 隔离，保证正式 QA 运行互不影响。
- 将来可以引入共享 pnpm cache，但它只能是显式优化，必须有清晰失效策略，不能成为正确性前提。
- PostgreSQL data、First Tree runtime home、provider test state、logs、screenshots、artifacts 必须按 run 隔离。

provider/auth 继承在并发环境中也必须有边界。若 case 需要宿主凭据，应只把必要材料挂载或复制进 run-local container/home，宿主边界尽量只读；一个 agent 不得在另一个 QA run 活跃时重写宿主 credential store 或共享 provider home。

清理也必须按 run cell 进行：

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" down -v
git --git-dir="$RUN_ROOT_REAL/repo.git" worktree remove "$RUN_ROOT_REAL/source"
rm -rf "$RUN_ROOT_REAL"
```

agent 不应在正式 QA 清理中执行 broad Docker cleanup，因为同一机器上可能有其他 agent 的 QA project 正在运行。清理失败时，report 应记录 run id 和 Compose project name，方便后续只清理该 run 的资源。

### 4.2.5 对外访问模式

本地 Docker QA 环境可以提供对外访问能力，但不是默认行为。默认正式 QA posture 是 local-only：容器之间通过 Compose network 通信，宿主访问只使用 loopback 动态端口。

v1 支持三种 access mode：

- **local-only**：默认模式。Postgres 只在 Docker network 内部可见；server/web 绑定 `127.0.0.1` 动态 host ports，供本机 agent、browser、curl 使用。
- **lan**：显式模式。server/web 可绑定指定 host interface 或 `0.0.0.0`，用于同机/同 LAN review、跨设备检查、移动浏览器验证。
- **public-tunnel**：显式模式。通过短生命周期 tunnel 或 reverse proxy 只暴露必需 HTTP(S) entrypoint，用于 webhook callback、OAuth redirect、外部 review 或第三方 integration test。

external access 必须由 task input 请求，或由 selected case 明确要求。生成的 QA plan 必须写清：

- 为什么需要 external access
- 暴露哪个 service
- 使用哪个 URL / callback target
- 谁或什么系统可以访问
- 暴露的数据是否安全
- 如何清理 exposure

环境只能暴露 web/server HTTP(S) entrypoints。不得暴露 Postgres、内部 provider state、runtime home、pnpm store、artifact directory 或宿主 credential store。若使用 tunnel，它必须 scoped 到 run cell，并记录在 `env-summary.md`；cleanup 必须随 Compose project 一起关闭 tunnel。

需要稳定 callback URL 的 case 可以使用显式 host port 或 tunnel domain。如果无法安全建立 required external access，QA 结果应为 `BLOCKED`，不能降级给 `PASS`。

### 4.2.6 数据准备边界

数据准备同时涉及 environment setup 和 case execution，但两者职责不同。

环境准备负责 run baseline，让系统进入已知、隔离、可复现的起始状态：

- database service、schema、migrations、extension readiness
- 空 DB 或明确记录的 baseline seed
- 多个 case 都需要的本地 test account、organization、workspace、project
- 非敏感 config 和 runtime home
- 属于环境 ready 条件、而不是被测行为的 provider/auth state
- run cell 的 reset/cleanup 语义

这个 baseline 应是 case-agnostic、idempotent、deterministic，并且只作用在临时 Docker 环境中。它要记录到 `env-summary.md` 和 run event log。

QA case 负责声明数据前置条件。case 应说明为了回答该验证问题需要什么业务数据状态：

- 必要 entities 和 relationships
- 相关字段值、权限、状态、时间戳
- case 所需 provider/runtime state
- 数据创建路径是否本身就是被测行为；如果是，应在 `flow` 中通过对应产品入口/API/UI/CLI 执行
- case 执行中或执行后预期发生的数据变化

本次 run 的 QA plan 负责 materialize case data preconditions：选择哪个 shared baseline、应用哪些可复用 fixtures、按什么顺序准备数据，以及用哪些 DB/API/UI observation 证明 case 开始前数据已就绪。

边界规则：

- 如果数据是让产品可运行、或多个 case 共享的 common starting point，属于 environment setup。
- 如果数据是为了验证某个 case 的 behavior/risk/variant，属于 case preconditions 和本次 QA plan。
- 如果“创建数据”本身就是被测行为，必须通过对应产品入口/API/UI/CLI 执行，并作为 case assertion 的一部分。
- 如果数据只是下游行为的前置条件，plan 可以选择最快且可靠的 setup path，包括 fixture loading 或在隔离 QA DB 内 direct DB writes；但必须记录 setup path，且不能把该 setup path 当成产品行为 evidence。

可复用静态 QA fixtures 可以作为 QA 资产放在 `packages/qa/fixtures/**`。每次 run 生成的 seed payload、SQL output、import file、DB snapshot、diff 都属于临时 artifacts，不能提交 repo。

所有数据准备都必须发生在临时 Docker/worktree run cell 内。QA data setup 不得修改原始 checkout、共享开发数据库、staging/prod service 或宿主 credential store。如果无法安全准备所需数据，结果是 `BLOCKED`。

### 4.2.7 Runtime / provider readiness

本地试运行已覆盖 daemon 启动、client register、agent bind 和真实 runtime turn 失败路径。v1 方案应把 daemon/runtime/provider auth 作为 case-specific setup，并显式区分 provider readiness：

- 默认 QA 环境提供 `FIRST_TREE_HOME` 和隔离 home。
- provider/auth 默认继承宿主，但必须显式挂载/注入，不自动覆盖宿主 credential。
- provider install 不能默认直接复制宿主 binary。宿主 binary 可能是 macOS/Windows 架构，而正式 QA run cell 是 Linux Docker；setup 应先做 host discovery，再在 Docker 内使用 compatible provider install、package 或 bundled binary。
- provider credential bridge 只允许复制或只读挂载完成本次 case 所需的最小凭证材料到 run-local container/home，例如单个 auth file。不得整包共享可写宿主 provider home。
- missing/unauthorized provider 场景必须在临时 container/home 内构造。
- daemon/runtime readiness 应在 runtime case 中定义自己的 ready gate。
- `binary-detected`：安装或路径探测通过，例如 capability snapshot 能报告 provider binary / bundled source。它不证明二进制可运行，也不证明 auth 可用。
- `binary-launchable`：provider 二进制可实际启动，或 doctor/smoke/check 命令能完成到 provider 自身定义的可运行状态。
- `one-turn-ready`：provider auth 和 runtime session 条件足以完成一个真实 agent turn。

真实 agent 行为类 case 必须在 QA plan 中要求并记录 `one-turn-ready`。如果只达到 `binary-detected` 或 `binary-launchable`，agent 不应继续发送真实任务 prompt 来制造稳定 blocked；应在 plan 或 case result 中直接标记 `blocked`，并说明缺失的 readiness 层级。

Docker 环境应承载常用依赖：

- Node.js / pnpm
- PostgreSQL
- first-tree server
- first-tree web
- dev CLI execution context
- client daemon/runtime execution context
- browser automation dependency基础设施（可作为后续 adapter 使用）

v1 不要求自动执行所有步骤；briefing 明确 agent 如何操作。

### 4.3 执行测试

执行测试由 `briefings/run-qa.md` 指导。

流程：

1. 阅读 `packages/qa/AGENTS.md`。
2. 读取并校验 QA task input contract。
3. 阅读任务相关 Context Tree / source context。
4. 选择并组合相关 case。
5. 在临时 run 目录写 `plan.md`，包括 environment / observability / external access plan。
6. 按 case 手动执行黑盒验证。
7. 按 case `flow` 采集真实产品行为 evidence。
8. 写 case-level results 和 `report.md`。
9. 对每个 FAIL 写结构化 bug artifact。
10. 最终向开发者反馈结论、证据摘要、artifact 路径和未覆盖风险。

真实产品行为 evidence 来源包括但不限于：

- CLI 行为
- HTTP API
- Web UI
- daemon / runtime 行为
- DB 状态
- 日志
- provider/runtime capability 或 auth 行为

preview、mock、harness、静态阅读可以作为探索证据，但不能单独支撑正式 PASS。

### 4.4 最小 Observability / Traceability

Observability 是正式 QA 的一部分，不是事后 debug 的附加项。一次无法追溯 setup、执行过程和证据来源的 QA run，不能给干净的 `PASS`。

v1 默认最小基线：

- **Run event log**：`artifacts/run-events.jsonl` 追加记录 setup、install、migration、service start、readiness gate、case execution、evidence capture、failure、cleanup。每条记录包含时间、phase、action/command、exit code、artifact path。
- **Command trace**：install、build、migration、check、typecheck、server start、web start、CLI command、case command 的 stdout/stderr。
- **Service trace**：`docker compose ps`、container health、Postgres/server/web/daemon/runtime 及 case-specific service logs。
- **Network/API trace**：作为 evidence 的 HTTP/API 请求和响应；Web case 涉及网络行为时，记录 browser HAR、proxy/access log 或等价边界日志。
- **DB trace**：case 相关表的 before/after snapshot、只读 SQL 查询输出，或简洁 diff/observation note。
- **Web/UI trace**：涉及 Web UI 时必须有 screenshot；需要时记录 browser console log。
- **Tool-call / execution log**：`artifacts/execution-log.md` 记录 agent 调用了什么工具或命令、为什么调用、输入摘要、输出 artifact、结论和重试原因。它面向人类评估方案和复盘执行过程。

`run-events.jsonl` 是整次 run 的 spine。注意它记录的是 QA 过程自身，不是产品行为：`observe run-event-log` 可以支撑过程可追溯性，但不得作为某个 case PASS 的唯一 evidence 来源。示例：

```json
{"time":"2026-07-03T20:10:01+08:00","phase":"setup","event":"worktree_created","target":"274837e2"}
{"time":"2026-07-03T20:12:44+08:00","phase":"install","command":"pnpm install","exit_code":0,"stdout":"commands/001-pnpm-install.stdout.log","stderr":"commands/001-pnpm-install.stderr.log"}
{"time":"2026-07-03T20:18:02+08:00","phase":"server","event":"ready","url":"http://127.0.0.1:58100/healthz","evidence":"network/healthz.json"}
```

每个 case result 应绑定判断与 trace，不只写自然语言结论：

- case id / title
- result status
- executed steps
- actual observations
- 关联 run event id 或时间戳
- evidence path
- 涉及 observe object 的 DB/network/UI trace path
- limitations / skipped checks

case result 的 `Status` 只能使用 case-level 6 态：`pass`、`fail`、`blocked`、`inconclusive`、`skipped`、`not-run`。`pass-with-case-design-note` 这类混合状态不得作为正式状态；设计说明、产品归一化、观察限制应写入 `Limitations and Notes`，不改变状态枚举。

Docker 环境需要让最小采集变得直接：

- 命令执行时 stdout/stderr tee 到 `artifacts/commands/`
- 长时间运行的服务日志写入或复制到 `artifacts/services/`
- API probe 保存 status、redacted headers、body summary 或安全的 full body
- DB snapshot 通过 Docker network 内只读 SQL probe 输出
- browser screenshot / console log 在隔离 Docker/browser 环境内采集

敏感信息必须显式处理。Authorization header、cookie、token、provider credential、private connection string、个人数据在被汇总或共享前应 redact。如果 redact 会破坏证据，report 应说明证据存在于本机 artifact 中，并用不泄密的方式描述。

深度 observability profile 可以包括：

- mitmproxy / HTTP access-log proxy，用于内部 web-to-server traffic
- Playwright trace zip / HAR / screenshot / video
- Postgres query logging / pgaudit / logical decoding / trigger audit table
- tcpdump / netshoot，用于连接层排障

这些是有用扩展，但不能替代默认基线。默认基线必须回答：运行了什么、系统发生了什么、状态改变了什么、最终结论为什么可信。

## 5. `packages/qa/AGENTS.md`

`packages/qa/AGENTS.md` 是 QA package 的必读入口，兼具 overview 和 canonical rules。

建议章节：

1. Overview
2. QA role and responsibility
3. QA task input contract
4. Required Docker + tmp git worktree environment
5. Required observability baseline
6. External access policy
7. Data preparation policy
8. Artifact policy
9. Provider/auth policy
10. Result status semantics
11. Case granularity and maintenance policy
12. Escalation rules
13. MUST / SHOULD / MAY rule table

三个 briefing 都要求先阅读 `packages/qa/AGENTS.md`。

规则不要藏在 report checklist 中。report 模板可以保持干净；agent 的最终结论必须由 AGENTS 规则约束。

## 6. Provider/Auth 策略

Docker QA 环境默认继承宿主环境中执行正式 QA 所需的 provider/auth 条件，但必须明确边界：

- 默认继承只服务于让正式 QA 复用操作员已有授权。
- “继承”分为两步：先在宿主做 provider install / credential discovery，再把最小必要 credential state 注入 run-local Docker home，并在 Docker 内使用 compatible provider binary/package 完成 smoke。
- 不得把宿主 macOS/Windows provider binary 当成 Linux Docker 可执行文件；若 provider binary 不兼容，setup 必须使用 Docker 内安装、repo dependency、vendor/bundled binary 或 case-specific install step。
- agent 不得覆盖、清空或重写宿主 provider credential store。
- agent 不得把完整宿主 provider home 以可写方式挂进多个并发 run；默认应复制单个必要 auth file 或使用只读挂载，并把目标路径写入 `env-summary.md`。
- 如需测试 missing/unauthorized/invalid-auth 场景，只能在临时 worktree/container/local home 中构造。
- provider/auth 条件必须写入 plan 和 report 的环境摘要。
- 如果 provider/auth 是 case 的变量，case 必须说明如何构造该状态。

这与 runtime capability 当前原则一致：provider install detection 不等价于 auth/smoke；auth 问题应在实际 session 运行时暴露。

provider readiness 必须写入 QA plan 和 report：

| readiness | 含义 | 允许支撑的 case |
| --- | --- | --- |
| `binary-detected` | provider binary 或 bundled source 被 capability probe 探测到。 | binary resolution、capability snapshot、missing/install guidance。 |
| `binary-launchable` | provider binary 可以实际启动，或 provider 自身 doctor/smoke 通过。 | runtime launch、daemon env、provider command integration。 |
| `one-turn-ready` | provider auth 和 runtime session 足以完成一个真实 agent turn。 | real-agent chat、ask/send briefing、agent behavior。 |

真实 agent 行为类 case 的 preconditions 必须要求 `one-turn-ready`。如果 setup 发现只具备 `binary-detected`，不能把后续 provider 401/credential error 当成产品 FAIL；应立刻标记 `BLOCKED`，并把 provider readiness 缺口写入 `env-summary.md`、case result 和 report。

## 7. Guard 设计

不提供 `qa guard` 可执行脚本。guard 通过 `AGENTS.md` 的 MUST/SHOULD/MAY 规则、workflow briefing 和 artifact 模板共同实现。

### 7.1 MUST

违反 MUST 时不能给正式 PASS。

- 正式 QA 必须使用 Docker + 临时 git worktree。
- agent 必须先读 `packages/qa/AGENTS.md`。
- 正式 QA 开始前必须有清晰 QA task input contract。
- agent 必须先生成本次 run 的 QA plan 中间产物，再执行验证。
- 每次正式 QA 必须使用唯一 run root 和唯一 Compose project name。
- run root 必须使用 `realpath`，并以同一绝对路径挂载进需要读写 artifact 的 Docker 容器。
- web、server、db、cli runner、daemon/runtime runner 必须运行在 Docker run cell 内；正式 QA 不得直接使用宿主 dev server 或宿主 candidate CLI。
- 数据准备必须限制在隔离 QA run cell 内，并区分 environment baseline 和 case-specific data preconditions。
- 每次正式 QA 必须采集最小 observability baseline。
- QA 执行任务不得修改原始工作区或本次被测对象。
- 环境无法启动、依赖缺失、provider/auth 前置失败时必须立刻反馈 `BLOCKED`。
- 真实 agent 行为类 case 必须在执行前具备并记录 provider `one-turn-ready`；缺失时结果是 `BLOCKED`，不是 `FAIL`。
- PASS 必须有真实产品行为 evidence，且每条 evidence 必须对应 case `flow` 中至少一个 observe 项；`run-event-log` 不得作为 PASS 的唯一 evidence 来源。
- QA case 的 `flow` action 必须描述产品入口、公开 contract、或 agent 可执行的黑盒动作，不得把参考目录里的临时 probe / harness 作为未声明前提。
- QA case 的 `flow` action 引用的观察面必须真实存在于产品公开 contract 中；case 维护时必须对照产品实际入口核实，不得假设不存在的命令输出或 API，也不得漏掉更直接的已有入口而绕行间接观察面。
- QA case 的每个 branch 必须至少包含一条 operate 和一条 observe action。
- provider/环境契约参数化的 case，QA plan 必须逐分支映射所选契约的适用性；不适用分支在 case result 中记 not-applicable，不得计为 skipped 或 pass。
- QA case 的每条 evidence 必须能映射到 `flow` 中至少一个 observe action；没有 observe 支撑的 evidence 不能用于 PASS。
- 每个 case result 必须绑定 trace/evidence artifact，并按 observe action key 显式记录每条 evidence 的绑定和 artifact path。
- case result 状态必须来自 6 态枚举；设计说明不得混入状态名。
- 当数据创建本身是被测行为时，必须通过相关产品入口/API/UI/CLI 执行。
- external access 必须显式规划、限定 scope、记录 trace 并清理。
- FAIL 必须有结构化 bug artifact。
- artifact 必须写入临时 run 目录，不提交到 repo。

### 7.2 SHOULD

违反 SHOULD 时可以继续，但 report 需要说明 limitation。

- 正式 QA 应针对可复现 git ref。
- 一次 QA task 应通过多个可复用 case 加显式 ad hoc checks 组合完成，不应把完整 feature QA 当成单个 case。
- 对影响结果的 case data，应记录 data setup path、baseline seed、fixture source 和 before/after observations。
- report 应记录实际发现的 server/web URL，而不是假设固定本地端口。
- 每个关键结论应绑定可追溯证据路径或摘要。
- case `flow` 中的关键 observe object 应尽量有对应 DB snapshot、HTTP/API log、screenshot、browser console log 或 service log。
- case `flow` 的 action detail 应指名到具体入口级别（命令及关键 flag、HTTP method + 路径、UI 位置），避免执行 agent 调错入口或端点。
- case 维护应检查 evidence 是否全部由 observe action 支撑，避免在 report 阶段补充未执行观察。
- report 应说明覆盖范围和未覆盖风险。
- bug artifact 应包含疑似原因或建议分派方向，但不能写成修复方案。
- case 维护应保持 frontmatter-only schema 精简，且 `flow` 步骤可执行、可观察。

### 7.3 MAY

允许但不是 v1 必须：

- 引用 runtime-env-qa 的经验和历史 report。
- 使用浏览器自动化工具采集更丰富的截图、trace 或视频。
- 在 case 需要时启用深度 observability profile，例如 raw packet capture、SQL audit、HAR、Playwright trace/video。
- 在 case 需要时启用 LAN 或 public tunnel 访问模式。
- 生成机器可读 JSON 摘要。
- 把 bug artifact 转成 GitHub issue body。

## 8. 结果状态

v1 固定 4 个整体结果状态：

- `PASS`：计划范围内的验证已在 Docker + 临时 git worktree 环境完成，真实产品行为证据足够，且证据对应 case `flow` 中的 observe 项，未发现阻断或回归问题。
- `FAIL`：完成了足够验证，并发现可复现的产品问题；必须附结构化 bug artifact。
- `BLOCKED`：环境、依赖、权限、provider/auth、数据准备等前置条件失败，导致 QA 无法继续。应立即反馈，不等待完整 report。
- `INCONCLUSIVE`：已执行部分验证，但证据不足、结果不稳定、scope 被中断或覆盖不足，不能负责任地给 PASS 或 FAIL。

case-level result 固定 6 个状态：`pass`、`fail`、`blocked`、`inconclusive`、`skipped`、`not-run`。整体（task-level）结论只使用上述 4 个状态，不新增。

状态名不承载说明。类似 `pass-with-case-design-note` 的写法应拆成 `Status: pass` 加 `Limitations and Notes`；类似 provider credential 缺失导致无法完成真实 turn 的情况应是 `blocked`，不是产品 `fail`。

branch-level 记录（case result 内部）额外允许 `not-applicable`：契约参数化 case 中经 QA plan 判定不适用于所选 provider/环境的分支。它不同于 `skipped`（适用但本次未执行），且不参与 pass 判定。

对依赖真实 LLM/agent 行为的 case：不可稳定复现的单次偏差记 `inconclusive` 而非 `fail`；`fail` 要求偏差可复现，并附结构化 bug artifact。

## 9. 模板

### 9.1 QA Task Brief

`templates/qa-task-brief.md` 应包含：

- Target identity
- QA objective
- Scope and evidence boundaries
- Context pointers
- Expected behavior / risk focus
- Environment constraints
- Provider/auth assumptions
- External access requirements
- Reporting expectation
- Known out of scope

### 9.2 QA Plan

`templates/qa-plan.md` 应包含：

- Task summary
- Target ref / source identity
- Context read
- Selected cases
- Case composition and execution order
- Environment plan
- Observability plan
- External access plan
- Provider/auth assumptions
- Provider readiness level（`binary-detected` / `binary-launchable` / `one-turn-ready`）及 readiness evidence
- Run cell path mapping（run root、source、artifacts、Compose project、discovered URLs）
- Environment baseline
- Case data setup
- Evidence plan
- Known risks / out of scope

### 9.3 QA Report

`templates/qa-report.md` 应包含：

- Overall status
- Target ref / git SHA
- Environment summary
- Run cell path mapping and Docker service summary
- External access summary, if used
- Data preparation summary
- Provider readiness summary
- Context and cases used
- Case-level results
- Executed steps
- Observability summary
- Evidence summary
- Findings
- Limitations and untested risks
- Artifact paths

### 9.4 Bug Artifact

`templates/bug-artifact.md` 应包含：

- Title
- Status
- Severity / risk
- Repro steps
- Expected result
- Actual result
- Environment
- Evidence
- Impact
- Suspected cause / suggested dispatch direction
- Non-goals / not a fix plan

bug artifact 可以同时生成 Markdown 和 JSON，但 v1 只要求临时目录中的 Markdown。

### 9.5 Case Result

`templates/case-result.md` 是 §4.4 中 case result 要求的模板归属，写入 `artifacts/case-results/`。应包含：

- Case id
- Result status（6 态之一）
- Executed / skipped branches
- Executed steps and actual observations
- Evidence bindings：每条 evidence 对应的 observe action key（如 `a4`、`b3`）和 artifact path
- Related run event ids / timestamps
- Limitations and skipped checks
- Design notes or product-owned normalization that affects interpretation but does not change the status enum

case 文件中的 `evidence` 保持自由文本；evidence 与 observe action 的实例级绑定在 case result 中落地。

### 9.6 QA Case

`templates/qa-case.md` 是新 case 的 frontmatter-only 起始模板，内容即 §4.1 的 v1 schema 骨架。

## 10. runtime-env-qa 的处理

`runtime-env-qa` 在 v1 作为参考输入，不迁移能力。

可吸收的设计经验：

- 黑盒验证，不 import 被测源码。
- provider/runtime 场景以真实 CLI/API 行为为准。
- install-only capability 与 auth/session run-time failure 分离。
- report 保留环境、命令、结果和证据。

不在 v1 迁移：

- runtime-env-qa 的 runner。
- scenario matrix。
- probe scripts。
- report history。

未来如果 `@first-tree/qa` 的 case/briefing 稳定，可以把 runtime-env-qa 的有效场景重写为 `packages/qa/cases/runtime/**/*.md`。

## 11. V1 非目标

v1 不做：

- 自动执行 QA case。
- 正式 CLI/bin。
- `qa env up/down/status/reset` lifecycle command。
- `qa guard` 可执行脚本。
- GitHub issue / PR comment 自动创建。
- browser automation adapter。
- Testcontainers / Dagger pipeline。
- runtime-env-qa 能力迁移。
- CI gate 集成。
- 完整 test management UI。

## 12. 后续方向

后续可以逐步增加：

- schema validator 或 floor check。
- Markdown + JSON 双输出 report。
- browser adapter，负责截图/trace/video 采集，但不拥有 QA schema。
- runtime-env-qa 场景迁移。
- QA skill/eval 覆盖：验证 agent 是否读 AGENTS、是否创建 plan、是否拒绝 preview-only PASS、是否在 FAIL 时生成 bug artifact。
- 历史 report 对比、flaky 风险和 coverage matrix。

## 13. 需要在英文 proposal 中沉淀的决策

英文 proposal 应聚焦耐久决策和理由：

- 新增 `@first-tree/qa` 内部 package，作为 QA 资产和 agent workflow 入口。
- 不提供 CLI/bin；agent 通过 briefing 执行，package 提供 Docker env、case、templates、AGENTS。
- 一次 QA task 的输入是 task request/brief；test plan 是 agent 生成的本次 run 中间产物。如果人提供 test plan，它只是输入参考或约束。
- 正式 QA 必须使用 Docker + 临时 git worktree。
- 数据准备拆为 environment baseline 和 case-specific data preconditions：前者属于 setup，后者由 case 声明并由 QA plan materialize；数据创建本身若是被测行为，必须通过相关产品入口/API/UI/CLI 执行。
- 支持本地多个 agent 并发 QA：每个 run 使用独立 temp run root、temporary bare repo/worktree、Compose project、network、volume、artifact tree 和动态发现的 host ports。
- 本地 QA 环境默认 local-only，但在 task/case 明确需要时可启用 LAN 或 public tunnel，对外访问必须显式规划、限制 scope、记录并清理。
- run root 使用 `realpath`，并以同一绝对路径挂载进 Docker；artifact path 在宿主和容器内保持一致。
- web、server、db、CLI runner、daemon/runtime runner 全部运行在 Docker run cell 内。
- Observability 是正式 QA 必需环节：默认采集 run events、command/service logs、network/API evidence、DB snapshot/diff、Web screenshot/console log；深度抓包、SQL audit、视频作为 case-specific profile。
- Tool-call / execution log 是 trace 的一部分，用来记录 agent 执行过程、重试和 artifact 绑定。
- provider readiness 固定三档：`binary-detected`、`binary-launchable`、`one-turn-ready`；真实 agent 行为 case 必须具备 `one-turn-ready`。
- 过程产物写临时目录，不提交 source repo。
- QA case 是 Markdown frontmatter-only、结构化自然语言 checklist；case 是可复用行为/风险切片，一次 QA task 通过多个 case 组合完成。
- QA case 的 `domains` 词表由 QA package 自维护（owner 是 `cases/README.md`），命名尽量对齐 Context Tree domain 但不强制绑定；首个 domain 是 primary domain 并决定 case 目录。`cli` 只在验证 CLI shell / command surface / output contract 本身时作为 domain，CLI 作为执行入口时写入 `surfaces` 或 `operate cli-command`。
- QA case 的 `flow` 必须描述产品入口、公开 contract、或 agent 可执行的黑盒动作；参考 probe / harness 只能作为来源，不成为未声明执行依赖。
- QA case 的每条 evidence 必须由 `flow` 中至少一个 observe action 支撑；多维 evidence 需要多维 observe。
- 三个 briefing：setup environment、run QA、maintain cases。
- `packages/qa/AGENTS.md` 是 canonical overview/rules。
- QA 执行不修改被测对象；case 维护是独立 QA 资产工作流。
- runtime-env-qa 先作为参考，不迁移。
- v1 不做自动 runner、CLI、guard command、CI gate。

## 14. 对抗性审查记录（2026-07-07）

对照 `first-tree` 源码与 Context Tree 做的一轮对抗性审查。整体架构（Docker + 临时 worktree run cell、frontmatter-only case、briefing 驱动、observability 基线、结果状态语义）通过，未发现需要推翻的结构性决策。以下发现已修订进本文与配套文档：

事实性错误：

1. 示例 flow 假设了不存在的观察面。provider 二进制解析结果（`runtimeSource`/`runtimePath`，`packages/shared/src/schemas/client-capabilities.ts`）由 daemon 探测后上传 server，经 clients read API 暴露。第一轮据此改用 server API 观察面，并断言"没有 CLI 命令打印 resolved path"——该断言在第二轮被推翻（见下），最终观察面改回 CLI local snapshot。新增 guard：case 维护必须对照产品实际入口核实观察面。
2. claude-code 有 SDK bundled binary fallback（`packages/client/src/runtime/capabilities/claude-code.ts`）：外部二进制全部缺失时 probe 返回 `ok/bundled` 而非 missing。"无二进制 → missing state" 类断言必须按所选 provider 的文档化契约表达。已修订示例 case 1。
3. compose 片段的 `FIRST_TREE_PUBLIC_URL` 与动态端口策略矛盾（先有容器才有映射端口）。已在 §4.2.2 补充注入时序说明。

内部不一致（已修订）：

4. domain 口径：决议为 QA 自维护 domain 词表与目录结构，不强制绑定 Context Tree 枚举，`cases/README.md` 是词表 owner。
5. 多 domain case 的目录归属：首个 domain 为 primary domain，决定目录。
6. templates 清单补齐 `qa-case.md` 与 `case-result.md`；case result 字段有了模板归属（§9.5）。
7. 分支级要求统一：每个 branch 必须至少一条 operate 和一条 observe（MUST）。

规则收敛（已修订）：

8. evidence 分层：case 文件中保持自由文本，类型级映射由 case 维护 review 核对；实例级绑定（observe action key + artifact path）在 case result 模板落地。
9. action 执行序 = 数字后缀升序，从 1 连续编号；单分支 >9 条视为过大应拆分。
10. `preconditions` 两键必须存在，`must_not_have` 允许显式空数组。
11. case-level 结果固定 6 态；LLM 行为类 case 的单次不可复现偏差记 `inconclusive`。
12. `run-event-log` 不得作为 PASS 唯一 evidence 来源。
13. 开放问题收敛：`surfaces` 用短名；operate/observe 词表 v1 严格枚举、扩展先经 maintain-cases 修订 schema 文档；v1 不写校验脚本但格式按可机械检查设计；首批示例 domain 为 runtime + chat。
14. 示例 case 1 的被测执行模式：v1 按 in-tree build 编写，installed-package 模式留待后续扩展。

### 第二轮审查（2026-07-07，针对第一轮修订本身）

第一轮修订引入或遗留了以下问题，已再修订：

15. **第一轮的"没有 CLI 打印 resolved path"是事实错误。** `daemon probe --json --no-upload` 是产品支持的免凭据 CLI 入口，本地输出 capability snapshot（`apps/cli/src/commands/daemon/probe.ts`）。case 1 的 primary question 是本地解析行为，观察面改回 `operate cli-command` + `observe command-output`，preconditions 不再需要 server/login。server read API 仍是合法替代观察面，但验证的是 daemon upload + server persistence 之后的状态，选它时 case 必须说明；该链路本身应是独立 case。教训沉淀为 guard："不得假设不存在的入口"与"不得漏掉更直接的已有入口"并列。
16. **provider-neutral discovery order 过度泛化。** claude-code 有显式 override（`CLAUDE_CODE_EXECUTABLE`）+ daemon PATH + well-known dirs + login-shell PATH + bundled fallback（`packages/client/src/handlers/claude-executable.ts`）；codex 是 bundled-first 再 PATH，无等价 override（`packages/client/src/runtime/capabilities/codex.ts`）。不能写成统一 contract。决议：case 1 保持 provider 参数化，但 preconditions 要求 QA plan 逐分支映射所选 provider 契约的适用性；不适用分支记 `not-applicable`（新增 branch-level 记录值，见 §8），不得计为 skipped 或 pass。该规则泛化进 guard，适用于所有契约参数化 case。
17. **API 观察面命名不够具体。** "clients/capabilities API" 指代不清：读面是 `GET /api/v1/clients/:clientId` 和 `GET /api/v1/me/clients`，`PATCH /api/v1/clients/:clientId/capabilities` 是上传写入口（`packages/server/src/api/clients.ts`、`me.ts`）。新增 SHOULD：action detail 指名到具体入口级别（命令及关键 flag、HTTP method + 路径、UI 位置）。
18. **case 1 branch c 被前序 fixture 污染。** branch b 创建的 user-local fixture 若未清除，branch c 的 out-of-contract 结论失去证明力。c1 已改为"先清空所有 in-contract fixture 与 override，再只创建一个 out-of-contract fixture"。
19. **case 3 缺少 `chat send` 的真实前置。** `chat send` 要求环境导出 `FIRST_TREE_CHAT_ID`（否则 `NO_CHAT_CONTEXT`）且必须传 `<name>` 收件人（否则 `NO_TARGET`），见 `apps/cli/src/commands/chat/send.ts`。已补入 preconditions。

### 第三轮审查（2026-07-07，本地手工执行三个示例 case 后）

本轮在临时 Docker + git worktree run cell 中手工执行了 3 个示例 case。执行产物位于 `/tmp/first-tree-qa-runs/manual-examples-20260707-171729`，本轮只用于方案评估，不落地 `packages/qa`。以下发现已修订进本文与配套文档：

20. **run cell 需要明确 path contract。** 实测中 assertion 和 artifact 既有宿主路径又有容器路径，容易错位。决议：v1 标准要求先 `realpath` run root，并把整个 run root 以同一绝对路径挂载进 Docker；artifact 路径以 `<run-root-real>/artifacts` 为准，`paths.json` 可记录机器可读映射。
21. **web/server/db/cli/daemon/runtime 必须全部在 Docker run cell 内。** 宿主只负责创建 run root、调用 Docker、访问 loopback URL 和汇总 artifact；不得把宿主 dev server 或宿主 candidate CLI 混入正式 QA。
22. **`daemon probe` 当前对 claude-code 路径是 install-only。** dummy fixture 能通过，说明 `binary-detected` 不等于 launch/auth。该事实保留为 case review note；文档中把 provider readiness 拆成 `binary-detected`、`binary-launchable`、`one-turn-ready`。
23. **真实 agent case 必须要求 `one-turn-ready`。** case 2 被 OpenAI 401 阻塞，不能判断 send-vs-request 行为。决议：真实 agent 行为 case 在 plan 阶段先检查 readiness；缺失时直接 `blocked`，不能算产品 `fail`。
24. **`chat send <name> --message-file` 有产品归一化前缀。** 持久化 content 会 prepend `@<recipient> `。决议：case 3 的精确断言是“去掉产品路由 mention prefix 后，file payload byte-for-byte 保留”；whole content mismatch 作为 design note / limitation 记录，不改变 `pass` 状态。
25. **chat case 的共享 setup 必须显式化。** CLI login 不足以完成 agent send：需要 user/org/session、sender agent、recipient agent、target chat、local sender config、daemon client register、sender bind；sender 和 recipient 应分离，避免 self-send 歧义。该内容写入 chat case preconditions 与 QA plan setup 模板。
26. **case result 状态不能扩展成说明性状态。** 实测使用的 `pass-with-case-design-note` 改为正式 `pass` + `Limitations and Notes`。case-level 状态仍固定 6 态。
27. **Tool-call / execution log 是正式 trace 的组成。** 本轮 `execution-log.md` 对方案评估很有价值，v1 把它纳入 observability baseline，记录工具/命令、目的、artifact、结论和重试原因。
28. **Shell / command template 需要精确约束。** `sh` 不支持 `set -o pipefail`、Node stdin script 不能混用 `require` 和 top-level await、命令级 env export 不会跨 `docker compose exec` 自动持久化。setup/run briefing 需要把这些作为执行注意事项，而不是 case 本身的产品断言。

### 第四轮审查（2026-07-07，provider bridge 解除真实 agent case BLOCKED 后）

本轮继续使用 `/private/tmp/first-tree-qa-runs/manual-examples-20260707-183056` 的 Docker + git worktree run cell。目标是解决 case 2 因 provider credential 缺失导致的 `BLOCKED`。以下发现已修订进本文与配套文档：

29. **provider/auth 继承必须拆成 discovery、credential bridge、Docker-compatible install 三步。** 实测宿主 Codex 安装为 `/opt/homebrew/bin/codex`，不能直接复制到 Linux Docker；本次使用 Docker 内 Linux Codex package，并只把宿主 `~/.codex/auth.json` 注入 container home。决议：方案中禁止把宿主 provider binary 视为可直接运行；只允许最小凭证桥接，二进制必须由 Docker-compatible install/source 提供。
30. **`one-turn-ready` 需要真实 turn evidence，而不是 doctor alone。** `codex doctor` 证明 auth/config/connectivity smoke，但 case 2 最终 PASS 依赖后续真实 runtime turn：用户侧 `POST /api/v1/chats/:chatId/messages`、agent reply 普通 `text` message、`format=request` 数量为 0、`open-requests` 为空、session events 包含 `turn_end`、receiver runtime 最终 `idle`。决议：QA plan/report 必须同时记录 smoke evidence 与真实 turn evidence。
31. **普通 chat send 可能带产品路由 mention prefix。** Codex agent 通过 ordinary CLI send 回复时，持久化内容为 `@qa-sender QA_NON_DECISION_DONE`。这仍然是普通 chat message，不是 tracked request。决议：case 的核心断言应写为 plain chat message + no request，不把“裸字符串完全相等”作为跨入口产品契约，除非 case 本身验证内容归一化。
32. **daemon lifecycle 需要避免重复 client id。** 误把后台父 shell PID 当 daemon PID 会导致旧 daemon 存活；重复 daemon 使用同一 client id 会被 server 以 WS close 4009 替换，产生重连和 stale inbox 干扰。决议：setup briefing 必须记录真实 daemon PID/进程名，并在重启前只清理当前 run cell 的 daemon/runtime 进程。
33. **shell 兼容性继续进入 guard。** zsh 中 `status` 是只读变量，外层双引号会提前展开 Node template literal 的 `${...}`。决议：运行 briefing 增加 shell guard：避免 zsh 特殊变量名，Node heredoc 使用 quoted delimiter，并通过 env 传入参数。
