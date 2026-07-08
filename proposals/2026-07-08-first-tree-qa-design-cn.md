# First Tree QA Package 方案草稿（中文）

日期：2026-07-08

状态：Draft PR discussion copy。本文是本地中文技术方案草稿，用于团队内审阅和对齐；正式采纳后再同步到长期 proposal / Context Tree 入口。

## 1. 结论

骨架保留：Docker + 临时 git worktree 的一次性 run cell、黑盒验证、observability、诚实状态。

复杂 DSL 删除：case 不再试图把 QA 判断力编码成机器可校验结构。v1 只硬约束会静默污染结果或破坏 run 边界的少数不变量，其余进入 briefing 和示例。

`@first-tree/qa` 是内部 QA 资产包，不发布 npm，不提供正式 CLI/bin。它让团队内 agent 在拿到 QA 任务后，完成“读上下文 -> 生成 QA plan -> 启动隔离环境 -> 黑盒验证 -> 产出 report/bug artifact”的闭环。

## 2. 核心不变量

违反以下不变量时不能给正式 PASS：

1. 正式 QA 必须在 Docker + 临时 git worktree 中执行，不污染宿主 checkout。
2. QA 执行角色不修改被测对象；测试数据、配置、fixtures 只能在隔离 run cell 内作为验证步骤变更。
3. PASS 必须有真实产品行为证据；证据不足只能是 BLOCKED 或 INCONCLUSIVE。
4. 过程产物只写临时 run 目录，不提交 source repo。
5. 环境、依赖、凭据、provider/auth 或数据前置失败时必须诚实标记 BLOCKED，不能包装成 FAIL 或 PASS。

这些是不变量，不是完整流程。具体怎么 setup、怎么观察、怎么组织报告，由 agent 按 briefing 和现场事实判断。

## 3. 与 Context Tree 解耦

`@first-tree/qa` 不使用 Context Tree domain taxonomy 作为 case schema 或目录主轴。

Context Tree 可以是 task request 的上下文来源之一，但 QA package 自己拥有 case 组织、case 命名、briefing、模板、环境配方和 observability 口径。QA 资产可以随 QA 实践演进，不需要等待 Context Tree 结构变化。

## 4. Package 目录

建议目录：

```text
packages/qa/
  AGENTS.md
  package.json
  briefings/
    setup.md
    plan.md
    execute.md
  cases/
    README.md
    cli/
    runtime/
    server/
    web/
    cross-surface/
  templates/
    case.md
    plan.md
    report.md
    bug.md
  environment/
    docker-run-cell.md
    git-worktree.md
    provider-bridge.md
  observability/
    logs.md
    network.md
    database.md
    screenshots.md
  fixtures/
    provider-binaries/
    db-seeds/
    workspaces/
```

职责：

- `AGENTS.md`：必读 overview，只放角色边界、5 条不变量、状态语义、升级规则。
- `briefings/`：agent 执行流程。setup、plan、execute 拆开，避免把生命周期固化成 CLI。
- `cases/`：自然语言 QA case。目录只是查找维度，不是 schema。
- `environment/`：Docker/worktree/provider bridge 配方。
- `observability/`：最小 trace 能力说明。
- `templates/`：plan/report/bug/case 模板；实际产物写临时目录。
- `fixtures/`：可复用 QA 资产，不放每次 run 的产物。

## 5. Task Request 与 QA Plan

一次 QA task 的输入是 task request，不是完整 test plan。

task request 应包含：

- target identity：repo、branch、commit、PR ref 或 patch identity。
- QA objective：功能验证、回归、bug reproduction、release smoke、runtime/provider validation 等。
- scope：要验证的产品区域和可观察边界。
- context pointers：issue、PR、design doc、源码路径、历史 report、Context Tree 节点等。
- expected behavior / risk focus：应成立的行为和重点风险。
- environment constraints：provider/auth、数据、浏览器、callback、外部访问等约束。
- reporting expectation：结果接收方、deadline、FAIL 是否需要 bug artifact。

QA plan 是 agent 阅读输入、上下文和 case 后生成的本次 run 中间产物，写入 `artifacts/plan.md`。如果人类提供 test plan，它只是输入约束或参考；本次生成的 QA plan 才是 artifact of record。

## 6. QA Case 设计

case 是给聪明 agent 的可复用 prompt，不是给笨执行器的 spec。

v1 使用极小 frontmatter + Markdown 正文 prose checklist：

```md
---
id: runtime-external-binary-resolution
description: Verify provider binary resolution across supported and unsupported locations.
areas: [runtime]
surfaces: [cli, client]
---

## Goal
Verify that provider binary resolution follows the selected provider contract.

## Preconditions
- A disposable Docker run cell is available.
- The selected provider contract is recorded in the QA plan.
- No host provider home is mounted writable into the container.

## Checklist
- Create a fixture binary in one supported location and observe the product entrypoint that reports capability state.
- Move the fixture to another supported location if the provider supports that path, then observe again.
- Place a fixture outside the supported contract and verify it is not treated as valid.
- Remove external fixtures and verify missing or bundled fallback behavior matches the selected provider contract.

## Evidence
- Command output or API response showing detected source/path.
- Container filesystem state proving fixture placement.
- Service or daemon log if the product emits resolution details.

## Expected Result
Supported locations are detected, unsupported locations are ignored, and missing/bundled behavior matches the selected provider contract.
```

frontmatter 只用于查找和引用：

- `id`：稳定 case identity。
- `description`：非结构化概括。
- `areas`：QA 自维护分类，例如 `cli`、`runtime`、`server`、`web`、`cross-surface`。
- `surfaces`：相关产品触达面或 package，例如 `cli`、`client`、`server`、`web`。

正文表达判断：goal、preconditions、checklist、evidence、expected result、limitations/notes。

明确删除：

- BranchFlow。
- operate/observe 枚举。
- evidence 到 observe key 的静态绑定。
- 每分支必须 operate + observe。
- 单分支小于等于 9 条。
- `type`、`risk`、`data_profile` 等字段。

case 颗粒度：

- 一个 case 只回答一个 primary validation question。
- 一个 case 可以包含正常和异常分支，但它们必须服务同一个问题。
- 一次 QA task 通过多个 case 组合完成。
- 参数矩阵默认写进 QA plan，不为每个参数新建 case。
- 能稳定自动化并属于产品契约的检查，应优先回到产品单元测试、集成测试或 E2E。

## 7. 环境模型

正式 QA 使用一次性 run cell：

```text
<tmp>/first-tree-qa-runs/<run-id>/
  repo.git/
  source/
  artifacts/
    plan.md
    env-summary.md
    execution-log.md
    report.md
    bugs/
    commands/
    services/
    network/
    db/
    evidence/screenshots/
```

run cell 包含：临时 run root、一次性 bare repo、source worktree、唯一 Compose project、隔离 Docker network、隔离 volumes、artifact tree、运行时发现的本地 URL。

关键配方：

```bash
RUN_ROOT=/tmp/first-tree-qa-runs/<run-id>
RUN_ROOT_REAL=$(realpath "$RUN_ROOT")
git clone --bare --no-hardlinks <source-repo> "$RUN_ROOT_REAL/repo.git"
git --git-dir="$RUN_ROOT_REAL/repo.git" worktree add --detach "$RUN_ROOT_REAL/source" <target-ref>
```

必须使用 `realpath`，并把整个 run root 以同一绝对路径挂载进 Docker。宿主和容器都引用 `<run-root-real>/artifacts/...`，避免证据路径错位。

所有被测产品入口都在 Docker run cell 内运行。若本次 scope 需要 server/web/db/cli/daemon/runtime，它们都必须在 Docker 中启动；宿主只创建 run root、调用 Docker、访问 loopback URL、汇总 artifact。

环境规模按 case scope 伸缩。CLI/API-only case 不必强制启动 web；Web case 不应跳过 server/db；真实 agent 行为 case 需要 daemon/runtime 和 provider readiness。

## 8. Docker 与并发

v1 不提供正式 `qa env up/down` CLI。agent 按 briefing 使用或生成 Compose 配方。

基础依赖：Node.js 24、pnpm via corepack、git、PostgreSQL 16、python3、make、g++、openssl、ca-certificates。

Compose 原则：

- `postgres` 默认只在 Compose network 内暴露。
- `server`、`web` 默认绑定 loopback 动态端口。
- `cli` 是 Docker 内命令执行容器。
- daemon/runtime runner 只在相关 case 中启动。
- pnpm store 使用 Docker volume，避免写入 worktree。
- `FIRST_TREE_HOME`、provider test home、browser profile 都是 run-local state。
- `DATABASE_URL` 与 `FIRST_TREE_DATABASE_URL` 都要明确设置。

端口默认动态映射：

```yaml
ports:
  - "127.0.0.1::8000"
```

agent 启动后用 `docker compose port` 发现实际 URL，并写入 `env-summary.md`。

本地多 agent 并发时，每个 run 必须有唯一 run id、run root、source worktree、Compose project、network、volumes、artifact tree。agent 不能执行 broad Docker cleanup；只能按当前 run 清理：

```bash
docker compose -p "$COMPOSE_PROJECT_NAME" down -v
git --git-dir="$RUN_ROOT_REAL/repo.git" worktree remove "$RUN_ROOT_REAL/source"
rm -rf "$RUN_ROOT_REAL"
```

清理失败时，report 记录 run id 和 Compose project name，方便后续定点清理。

## 9. 对外访问

默认模式是 `local-only`：容器内服务通过 Compose network 通信，宿主只通过 loopback 动态端口访问 web/server。

显式模式：

- `lan`：暴露给局域网设备。
- `public-tunnel`：短生命周期 tunnel，用于 webhook、OAuth callback 或外部 review。

external access 必须由 task request 或 case 明确要求，并写入 QA plan：为什么需要、暴露哪个 service、URL 是什么、谁可以访问、如何清理。

不得暴露 Postgres、artifact directory、provider home、runtime home 或宿主 credential store。

## 10. 数据准备

环境准备负责 run baseline：DB service、migrations、空 DB 或共享 seed、多 case 共用账号/组织/workspace、非敏感配置、run-local provider/runtime home。

case 负责声明验证所需业务状态：必要 entities、relationships、权限、状态、时间戳、字段值、provider/runtime state、执行后预期数据变化。

QA plan 负责 materialize 数据：选择 baseline、应用 fixture 或 seed、记录 setup path、记录 before/after DB observation。

如果“创建数据”本身是被测行为，必须通过产品入口、API、UI 或 CLI 执行。若数据只是下游行为前置条件，可以在隔离 QA DB 内使用 fixture 或 direct DB writes，但不能把该 setup path 当成产品 evidence。

## 11. Provider/Auth

provider readiness 分三层：

- `binary-detected`：探测到 binary 或 bundled source。
- `binary-launchable`：binary 可启动，或 doctor/smoke 通过。
- `one-turn-ready`：auth 和 runtime session 足以完成真实 agent turn。

真实 agent 行为 case 必须要求 `one-turn-ready`。

宿主 provider 状态可以作为输入，但必须桥接到 run-local Docker home：先做 host discovery，只复制或只读挂载最小 credential，在 Docker 内安装或使用 Linux-compatible provider binary，不把宿主 macOS/Windows binary 当成容器可执行文件，不整包可写挂载宿主 provider home。

provider/auth 缺失是 BLOCKED，不是产品 FAIL。

## 12. Observability

正式 QA 必须留下最小 trace：

- `execution-log.md`：agent 调用了什么命令或工具、为什么、输出在哪里、结论是什么。
- command stdout/stderr。
- service logs。
- Docker service state。
- HTTP/API request/response evidence。
- DB before/after snapshot、query output 或 diff note。
- Web screenshot 和 console log，若涉及 UI。
- provider/runtime smoke 或真实 turn evidence，若涉及 runtime。

这些证据写入 `artifacts/`。report 只摘要，不粘贴敏感信息。

敏感信息必须 redact：Authorization、cookie、token、provider credential、private connection string、个人数据。

深度 profile 可以按需启用：HAR、Playwright trace/video、mitmproxy、Postgres audit、tcpdump。它们是扩展，不是默认负担。

## 13. 结果状态

统一使用 4 态：

- `PASS`：计划范围已验证，真实产品行为证据足够，未发现问题。
- `FAIL`：发现可复现产品问题，必须附 bug artifact。
- `BLOCKED`：环境、依赖、权限、provider/auth、数据准备等前置失败。
- `INCONCLUSIVE`：执行了部分验证，但证据不足、结果不稳定或覆盖不足。

未执行、未适用、跳过的内容写在 report 的 coverage / limitations 中，不进入状态枚举。

## 14. Artifact 模板

`templates/plan.md`：task summary、target ref、context read、selected cases、environment plan、data setup plan、provider readiness plan、observability plan、external access plan、risks/out of scope。

`templates/report.md`：overall status、target ref、environment summary、cases/checklists executed、evidence summary、findings、limitations、artifact paths。

`templates/bug.md`：title、severity/risk、repro steps、expected result、actual result、environment、evidence、impact、suspected cause / suggested dispatch direction。

bug artifact 只能写疑似原因和分派方向，不写实现方案。

## 15. runtime-env-qa

`runtime-env-qa` 先作为参考，不迁移能力。

可吸收经验：黑盒验证、provider/runtime 分层、install detection 与 auth/session failure 分离、report 记录环境/命令/结果/证据。

不迁移：runner、scenario matrix、probe scripts、report history。有效场景未来可重写为 prose checklist case。

## 16. V1 非目标

v1 不做：正式 CLI/bin、自动执行 case、`qa guard` 命令、CI gate、test management UI、GitHub issue 自动创建、browser automation adapter、runtime-env-qa 能力迁移。

脚本化留到方案稳定后再做。当前阶段优先把整体工作模型、目录、briefing、case 写法和 artifact 口径定清楚。

## 17. 为什么删除旧版复杂度

旧版 §14 的多轮对抗性审查本身就是证据：每轮都是在示例 flow 里发现事实错误，然后再新增规则。

这些错误并不是因为规则不够多，而是因为僵硬 DSL 逼迫 case 作者在产品不在手时提前猜：应观察哪个入口、provider 契约是否统一、branch 是否适用、evidence 应绑定哪个 observe key、setup 是否会污染后续分支。

运行时 agent 面对真实产品写 prose checklist，反而可以直接观察真实存在的入口和行为。

因此 v1 不继承 22 条 MUST，也不继承 BranchFlow。它保留少数保护正确性的硬边界，其余交给 briefing、示例和执行 agent 的现场判断。

## 18. 后续方向

方案稳定后可以逐步增加：最小 frontmatter lint、可复用 Compose snippets、execution-log helper、report JSON 摘要、browser screenshot/trace adapter、runtime/provider case 示例沉淀、QA skill/eval。

新增脚本不能反向支配 case 设计。case 仍应优先作为给 agent 的自然语言 QA prompt。
