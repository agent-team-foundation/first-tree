# Migrate breeze to `packages/auto`

> **Status:** Draft v4 (supersedes v3, integrates Codex round-2 review) · **Date:** 2026-04-27 · **Target branch:** `refactor-new-cli` · **Reviewers:** yuezengwu, Codex

## 0. Revision history

| Version | Date | Notes |
|---|---|---|
| v1 | 2026-04-27 | 占位改名方案（已废） |
| v2 | 2026-04-27 | 全量迁移方案首版（已被 Codex 标记 7 处硬错误） |
| v3 | 2026-04-27 | 全量迁移方案，吸收 Codex v2 review；Codex round-2 又指出 6 处问题 |
| v4 | 2026-04-27 | 本文档，吸收 Codex round-2 review（F1–F6） |

### Codex v2 review — 反馈与处理

| # | Codex 指出的问题 | v3 处理位置 | 处理方式 |
|---|---|---|---|
| 1 | 边界冲突：`packages/auto` 内的 commands/daemon/bridge/statusline 都是强 OS 交互，与 AGENTS.md "apps 处理 OS 交互、packages 放核心业务" 边界相悖 | §0.1, §4.1 | 路线 A：声明 `packages/auto` 为 **internal product package**，承认这是 AGENTS.md 边界例外 |
| 2 | 发布形态硬错误：apps/cli 用 `tsc`，tsc 不会把 `@first-tree/auto` 内联进 `dist/index.js`；同时 AGENTS.md 又说 `packages/*` internal 不发布；结果发布物引用不可用的 internal workspace 包 | §9 | apps/cli build 切到 **tsdown**（main 已用），把 `@first-tree/auto` 内联打包；同时 prepack 复制资源（`dashboard.html`、`VERSION`、`skills/`）进 `apps/cli/dist`；保留 `packages/auto` private 不发布 |
| 3 | 命令数量错：proposal 写 18，main `cli.ts` DISPATCH 实际 14 个 token，对外 commander 应是 11 | §3, §4.4, §5 D5 | 全部改为 14（DISPATCH） / 11（对外） |
| 4 | 端口共存假设错：HOME 隔离不能阻止两个进程同时 bind `127.0.0.1:7878` | §4.3, §5 D4 | 默认改 `7879`；支持 `$AUTO_HTTP_PORT` 覆盖；启动失败时给出明确提示 |
| 5 | 当前 commander 框架不支持选项 A："groups.ts:30" 没有 `.argument()` / `.allowUnknownOption()`，"context.ts:106" 也丢弃 action 参数；选项 B catch-all 更符合"原样搬运" | §4.4, §5 D11 | 改为选项 **B catch-all**：注册 `auto [args...]` 一个命令，原始 token 全部透传给 `runAuto` |
| 6 | HTTP route 列表错：proposal 写 `/status`，main 实际是 `/`、`/dashboard`、`/index.html`、`/healthz`、`/inbox`、`/activity`、`/events` | §3 | 修正 |
| 7 | files / skills 路径错：proposal 写"根 package.json:files 更新"，但根包是 private 不发布；skills 放仓库顶层不会进 apps/cli npm 包 | §5 D8/D9, §9 | 发布配置全部归 `apps/cli/package.json`；`dashboard.html` / `skills/auto/` 放进 `packages/auto/{assets,skills}/` 由 prepack 流程复制进 `apps/cli/dist/` |

### Codex round-2 review（v3 → v4）— 反馈与处理

| # | Codex 标 | Codex 指出的问题 | v4 处理位置 | 处理方式 |
|---|---|---|---|---|
| **F1** | 高 | catch-all 命令的 `auto --help` 会被 commander v14 截获，action 不会跑 `runAuto(["--help"])` | §4.4, §7 R12 | catch-all 显式 `.helpOption(false)` + `.helpCommand(false)`，让 `--help` / `-h` / `help` 三种 token 都落入 `args` |
| **F2** | 高 | TS project references 方案不完整：worktree 无根 `tsconfig.json`；`tsc -p` 不会 build referenced project | §4.2, §9.2（重写）, §7 R13 | 新增 `tsconfig.base.json` + 根 `tsconfig.json` manifest；workspace typecheck 切到 `tsc -b --noEmit` |
| **F3** | 高 | `prepack` 仅复制 assets 不保证先 build，干净 checkout 下会打进空 dist | §9.1 | `prepack` 改为 `pnpm run build && node scripts/copy-auto-assets.mjs`，与 main `package.json:6` 同模式 |
| **F4** | 中 | `runAuto(args, { stdout, stderr })` 与 main `runBreeze(args, output: (text)=>void)` API 不一致，违反"原样搬运" | §4.4, §4.5（新增） | 改回 `runAuto(args, output: Output = console.log)`，错误信息走同一 output，与 main 完全对齐 |
| **F5** | 中 | "47 个非测试源文件" 数字错（main 实际 41 .ts + 1 .tsx = 42 模块；3 个非源码文件 README/VERSION/.gitkeep） | §1, §3 | 校正为 "42 个 TS/TSX 源码模块（仓库路径合计 45 个）" |
| **F6** | 低 | §13 脚本依赖 `jq` / `timeout` / `lsof` 等工具，但前置条件未列；macOS 默认无 `jq` 与 GNU `timeout` | §13 前置, §13.0（新增）, §13.4 | 前置条件追加完整工具表 + macOS/Linux 安装提示；新增 §13.0 capability check 模板；§13.4 用 `${TIMEOUT_CMD:-}` 兼容 |

### 0.1 AGENTS.md 边界例外声明（路线 A）

[`AGENTS.md`](../../AGENTS.md) §"apps 和 packages 的界限"原文：

> 1. apps/cli 下主要负责和 Linux/MacOS/Windows 的操作系统交互，主要处理外界信息的转换和处理；前置抛出报错；
> 2. packages 中的逻辑主要实现核心业务逻辑；假设接受到的信息已经完成了基础的 format，为可用数据；

按字面执行，breeze 的 `start/stop/install/launchd/spawn/fs lock/HTTP server/SSE` 全部应当留在 `apps/cli`，仅 `classifier / task-kind / task-util / repo-filter / allow-repo / types` 等 ~7 个纯函数可下沉到 `packages/`。这等价于把 breeze 拆成两半重新装配，**违反**本方案的非目标"不重写、不顺手重构"。

**本方案声明 `packages/auto` 为 internal product package**，作为 AGENTS.md 的命名例外允许其承载 OS 交互代码（spawn / launchctl / HTTP / 文件锁 / launchd plist 写入等）。`apps/cli` 的角色相应缩窄为：

- 用 commander 注册顶层 `auto` 命令并把原始参数透传给 `packages/auto`；
- 不复刻子命令清单、不持有任何业务状态；
- 仅做退出码 / stdout 透传与 commander 错误格式映射。

理由：

1. main 上 `src/products/breeze/` 内部已经按 commands / daemon / runtime 三层做了清晰划分，整体迁入 `packages/auto/` 保留这一组织；
2. breeze 测试（34 个 vitest）期望源码与测试同位（包内 tests/），拆分会让 ~16 个 daemon 测试横跨两个包，迁移成本高出一个数量级；
3. 路线 B（严格遵守边界）实质等于 partial rewrite，与本方案"原样搬运"非目标抵触；
4. AGENTS.md 边界对未来真正的"通用核心 + 多 frontend"场景仍然适用，本例外仅作用于 `packages/auto`。

后续若有新 product 不属于 OS-heavy 形态（如规则引擎、解析器），应回归 AGENTS.md 默认边界，不受此例外影响。

## 1. Scope change（自 v1 起）

| 维度 | v1（已废） | v4（本方案） |
|---|---|---|
| 目标 | 在 refactor 线上为 `auto` 创建 6 个 placeholder 命令 | 把 main 上 `src/products/breeze/`（42 个 TS/TSX 模块 / ~12k 行 + 34 个 vitest 测试 + 资源 + skills）全量搬入新建的 `packages/auto/` 子包 |
| 子命令数 | 6 | DISPATCH 14 / `AUTO_USAGE` 暴露 11（primary 7 + advanced 4；commander 仅注册 1 条 catch-all，详见 §4.4 / §5 D11） |
| 引入新依赖 | 无 | ink、react、zod、proper-lockfile、yaml；devDeps：tsdown、ink-testing-library、@types/react |
| 分层 | 仅 `apps/cli/` | `apps/cli/`（commander catch-all 装配）+ `packages/auto/`（业务逻辑，含 OS 交互，**AGENTS.md 边界例外**） |
| 构建 | `tsc` | `apps/cli` 切到 **tsdown**（内联 `@first-tree/auto`） + statusline 独立 bundle + prepack 资源复制 |
| 风险等级 | 低 | 高 |

## 2. 目标 & 非目标

**目标（in scope）：**

- 在 refactor 线下建立 `packages/auto/` internal product package（**不发布到 npm**），包含 main breeze 全部源码、测试、资源、版本号文件。
- 新包暴露 `runAuto(args, output?)` / `AUTO_USAGE` / `AUTO_INLINE_HELP` 等对外 API，被 `apps/cli/src/commands/auto/` 通过 commander catch-all 子命令透传调用。
- 完成 `breeze → auto` 的命名替换（包名、HOME 目录、env vars、launchd label、内部符号、HTTP 默认端口）。
- 复制并适配 main 上 34 个 vitest 测试，全部通过。
- 复制 `assets/breeze/dashboard.html`、`src/products/breeze/VERSION`、`skills/breeze/`，整合进 `packages/auto/{assets,skills,VERSION}`，由 apps/cli prepack 流程复制进发布物。
- 保留 statusline 独立 bundle（Claude Code statusline hook 依赖）。
- `apps/cli` 的 build 脚本由 `tsc` 切换到 `tsdown`，同时保留 `tsc --noEmit` 作 typecheck。

**非目标（out of scope）：**

- **不重写**任何业务逻辑、不"顺便重构"。原样搬运，仅做必要的命名 / 路径 / 端口替换。
- **不引入**新功能、新子命令、新协议。
- **不修改** main 分支（main 视作只读参考）。
- **不迁移** main 上的 `gardener` 或 `tree` 产品。
- **不解决** refactor 线现存 hub / init / tree placeholder 的真实化。
- **不引入**跨平台原生模块（沿用 main 的纯 JS 依赖矩阵）。
- **不发布** `@first-tree/auto` 到 npm 公网；它仅作为 apps/cli 内部依赖被 bundler 内联。

## 3. main 上原 breeze 的实际形态（事实摘要 — 已校正）

来自 deep-dive 调研 + Codex review 校正：

- **42 个 TS/TSX 源码模块**（41 个 `.ts` + 1 个 `.tsx`），分四层。仓库路径合计 45 个（额外 `README.md`、`VERSION`、`.gitkeep` 三个非源码文件，**已校正自 v3 的"47"**）：
  - 顶层：`cli.ts`（dispatcher）+ `engine/bridge.ts`（spawn helpers）+ `engine/statusline.ts`（独立 bundle 入口）= 3
  - `engine/commands/`：9 个（install / start / stop / status / doctor / cleanup / poll / watch.tsx / status-manager）
  - `engine/daemon/`：17 个（broker / bus / candidate-loop / claim / dispatcher / gh-client / gh-executor / http / identity / launchd / poller / runner-skeleton / runner / scheduler / sse / thread-store / workspace）
  - `engine/runtime/`：13 个（activity-log / allow-repo / classifier / config / gh / identity / paths / repo-filter / store / task / task-kind / task-util / types）
- **DISPATCH 14 个 token**（`src/products/breeze/cli.ts` L167-189，已校正）：`install` / `run` / `daemon` / `run-once` / `start` / `stop` / `status` / `doctor` / `cleanup` / `poll-inbox` / `status-manager` / `poll` / `watch` / `statusline`。其中 `poll-inbox` 是 `poll` 的 legacy alias。
- **持久化文件系统布局**（`~/.breeze/` 下）：`inbox.json` / `activity.log` / `claims/` / `identity.json` / `runner/threads/` / `runner/locks/` / `runner/broker/` / `runner/workspaces/` / `runner/repos/` / `runner/launchd/`。
- **HTTP routes**（`src/products/breeze/engine/daemon/http.ts` L64-74，**已校正自 v2**）：`/`、`/dashboard`、`/index.html`（serve `dashboard.html`）、`/healthz`、`/inbox`、`/activity`、`/events`（SSE）。
- **HTTP host:port**：`127.0.0.1:7878` hardcode default。
- **运行时依赖（来自 main 根 `package.json`）**：`ink@7`、`react@19`、`zod`、`proper-lockfile`、`yaml`。
- **构建产物**：`dist/cli.js`（主，tsdown）+ `dist/breeze-statusline.js`（独立零依赖 bundle，<30ms 冷启动，**Claude Code statusline hook 现役依赖**）。
- **测试**：34 个 vitest 文件，覆盖 cli / daemon / runtime / TUI 全部层级。
- **平台**：launchd 仅 macOS；Linux/Windows 走 `spawn(detached:true)` fallback。
- **耦合**：与 tree/gardener/shared 几乎零 import 耦合，仅通过 main `src/products/manifest.ts` 注册到顶层 CLI。

### 当前 refactor 线现状（依据 v3 review 时核对）

- `apps/cli/package.json:18` — `build: "tsc -p tsconfig.json"`；`dependencies: { commander: ^14 }`；`files: ["dist"]`；`bin: { "first-tree": ..., "ft": ... }`；`type: "module"`。
- 根 `package.json` — `private: true`，**不发布**；仅作 workspace 装配 + lint / fmt / test 总入口。
- `pnpm-workspace.yaml` — `packages: [apps/*, packages/*]`，新建 `packages/auto/` 自动被发现。
- `apps/cli/src/commands/groups.ts` 现状：`registerCommandGroup` 只调 `.command(name).description(...).action(...)`，**未启用** `.argument()` / `.allowUnknownOption()` / `.passThroughOptions()`。
- `apps/cli/src/commands/context.ts` 现状：`withCommandContext` 只把 `Command` 实例转成 `CommandContext`，**不传** action 参数。

## 4. 总体设计

### 4.1 分层（路线 A，AGENTS.md 边界例外）

```
apps/cli/src/commands/auto/        # 薄层：commander catch-all 注册 + stdout/exitCode 桥接
packages/auto/                      # 厚层：internal product package（commands / daemon / runtime / bridge / statusline）
                                    #       承载 OS 交互代码，AGENTS.md 边界例外
```

`apps/cli/src/commands/auto/` 的职责严格限定为：

- 用 commander 注册一条 `auto [args...]` 顶层命令，附 `.allowUnknownOption(true)` + `.passThroughOptions(true)`；
- action 中将原始 args 数组透传给 `packages/auto` 暴露的 `runAuto(args, output)`；
- 把 `runAuto` 的返回值或抛错转换为 commander 的 exitCode / stderr 输出。
- **不**复刻子命令清单、**不**做参数前置校验（前置由 `packages/auto/src/cli.ts` 内部 dispatcher 自行处理，与 main 行为一致）。

### 4.2 `packages/auto/` 骨架

```
packages/auto/
├── package.json                   # name: "@first-tree/auto", private: true, main: "src/index.ts"
├── tsconfig.json                  # extends ../../tsconfig.base.json，composite: true（详见 §9.2）
├── tsdown.config.ts               # 仅产出 statusline 独立 bundle（apps/cli 主 bundle 由 apps/cli 自己的 tsdown 处理）
├── VERSION                        # ← src/products/breeze/VERSION ("0.3.0")
├── src/
│   ├── index.ts                   # re-export runAuto / AUTO_USAGE / AUTO_INLINE_HELP / statusline entry
│   ├── cli.ts                     # ← src/products/breeze/cli.ts（DISPATCH 表 + runAuto）
│   ├── bridge.ts                  # ← engine/bridge.ts
│   ├── statusline.ts              # ← engine/statusline.ts（独立 bundle 入口）
│   ├── commands/   { 9 files }    # ← engine/commands/*
│   ├── daemon/     { 17 files }   # ← engine/daemon/*
│   └── runtime/    { 13 files }   # ← engine/runtime/*
├── assets/
│   └── dashboard.html             # ← assets/breeze/dashboard.html
├── skills/
│   └── auto/SKILL.md              # ← skills/breeze/SKILL.md（顶层 skills/breeze/VERSION 合并入 packages/auto/VERSION）
└── tests/                         # ← main tests/breeze/* 全部 34 个文件
    ├── cli/
    ├── daemon/
    ├── runtime/
    ├── ui/
    └── fixtures/
```

`packages/auto/package.json` 通过 `pnpm-workspace.yaml` 已有的 `packages/*` glob 自动发现，无需改 workspace 配置。

### 4.3 命名替换矩阵（breeze → auto）

| 维度 | main（breeze） | refactor 线（auto）— 推荐 |
|---|---|---|
| 包名 | `first-tree`（umbrella） | `@first-tree/auto`（**D1**，private 不发布） |
| 顶层 dispatcher 函数 | `runBreeze(args, output)` | `runAuto(args, output)` |
| Usage 常量 | `BREEZE_USAGE` / `BREEZE_INLINE_HELP` | `AUTO_USAGE` / `AUTO_INLINE_HELP` |
| HOME 目录 | `~/.breeze/` | `~/.first-tree/auto/`（**D2**） |
| Env override | `$BREEZE_DIR` / `$BREEZE_HOME` | `$AUTO_DIR` / `$AUTO_HOME` |
| Daemon 子目录 | `~/.breeze/runner/` | `~/.first-tree/auto/runner/` |
| HTTP host:port | `127.0.0.1:7878`（hardcode） | `127.0.0.1:7879` 默认 + `$AUTO_HTTP_PORT` 覆盖（**D4**，**已校正自 v2**） |
| launchd label | `com.breeze.runner.<login>.<profile>` | `com.first-tree.auto.<login>.<profile>`（**D3**） |
| Statusline bundle | `dist/breeze-statusline.js` | `dist/auto-statusline.js`（**D6**） |
| Skill 目录 | `skills/breeze/`（仓库顶层） | `packages/auto/skills/auto/`（**D9**，由 prepack 复制进 `apps/cli/dist`） |
| Dashboard 资源 | `assets/breeze/dashboard.html`（仓库顶层） | `packages/auto/assets/dashboard.html`（**D8**，由 prepack 复制进 `apps/cli/dist`） |

> **隔离原则**：HOME / env / launchd label / HTTP 端口全部改名。同一台机器装了 main breeze 与 refactor auto 时两套 daemon 完全独立、互不感知、互不冲突。

### 4.4 `apps/cli/src/commands/auto/` 适配层（选项 B catch-all）

```ts
// apps/cli/src/commands/auto/index.ts
import type { Command } from "commander";
import type { CommandModule } from "../types.js";

export const autoCommand: CommandModule = {
  name: "auto",
  description: "Run auto workflow commands.",
  register(program: Command): void {
    program
      .command("auto")
      .description("Run auto workflow commands.")
      .argument("[args...]", "auto sub-command and its arguments")
      .allowUnknownOption(true)
      .passThroughOptions(true)
      .helpOption(false)        // 关 commander 默认 --help / -h，让 token 落入 args（详见 §4.5）
      .helpCommand(false)       // 关 implicit `help` 子命令，让 `auto help` 也透传
      .action(async (args: string[]) => {
        const { runAuto } = await import("@first-tree/auto");
        const exitCode = await runAuto(args);   // output 默认 console.log，与 main runBreeze 一致
        if (typeof exitCode === "number" && exitCode !== 0) {
          process.exitCode = exitCode;
        }
      });
  },
};
```

特性：

- 单文件、单命令注册；
- `[args...]` + `allowUnknownOption` + `passThroughOptions` 让 `--allow-repo` 等任意 flag 都原样落入 `args`；
- `.helpOption(false)` + `.helpCommand(false)` 关闭 commander 的默认 `--help` / `-h` 与 implicit `help` 子命令拦截（**已校正自 v3**：commander v14 默认每个 command 都注册 `--help` option 并在 action 之前优先处理，仅靠 `passThroughOptions` 不能让 `--help` 透传，必须显式禁用）；
- `--help` / `-h` / `help` 三种 token 都落入 `args`，由 `packages/auto/src/cli.ts` 的 `isHelpInvocation` 识别后输出 `AUTO_USAGE`（与 main breeze 行为完全一致）；
- 不需要改 `groups.ts` 或 `context.ts` 框架。

权衡：`first-tree --help` 的 *All commands* 附录里只会出现 `first-tree auto`，不会列出 `auto install`、`auto start` 等子命令——这与 hub/tree 风格不对齐，但与 main breeze 行为一致，且零框架改造。如果未来要让 `--help` 看到完整子命令清单，需要扩展 `SubcommandModule` / `groups.ts` 支持参数透传，建议**作为独立的 commander framework upgrade PR**，与本次迁移解耦。

### 4.5 `runAuto` 签名（与 main `runBreeze` 完全对齐）

`packages/auto/src/index.ts` re-export 的 `runAuto` 必须**原样**保持 main `runBreeze` 的签名（**已校正自 v3**：v3 §4.4 误写成 `{ stdout, stderr }` 流对象，违反 §2 非目标"原样搬运"）：

```ts
// packages/auto/src/cli.ts（自 main src/products/breeze/cli.ts:138, 222 搬运并改名）
export type Output = (text: string) => void;

export async function runAuto(
  args: string[],
  output: Output = console.log,
): Promise<number>;
```

要点：

- `output` 是单一函数（`(text: string) => void`），**不**是 `{ stdout, stderr }` 对象；
- 错误信息走同一 `output`（main 行为：`runBreeze` 内部错误也调 `write(...)`，即默认 `console.log` → stdout）；错误条件靠返回码 `1` 表达；
- apps/cli 适配层不传 `output` 参数，使用默认 `console.log`；进程级退出码由 commander action 在 `runAuto` 返回后映射到 `process.exitCode`。

## 5. 决策表

| # | 决策 | 推荐 | 备选 / 风险 |
|---|---|---|---|
| **D1** | npm 包名 | `@first-tree/auto` (scoped, **private: true**, 不发布) | `first-tree-auto`（无 scope）；理论上也可考虑 `@first-tree/auto-core` 与未来其他 auto-* 包并存 |
| **D2** | HOME 目录 | `~/.first-tree/auto/` | 沿用 `~/.breeze/` 与 main 共存；`~/.auto/`（短）；XDG `$XDG_DATA_HOME/first-tree/auto/` |
| **D3** | launchd label | `com.first-tree.auto.<login>.<profile>` | 沿用 `com.breeze.runner.<...>`（与 main breeze 冲突，不可取） |
| **D4** | HTTP 端口默认值（**已校正自 v2**） | 默认 `7879` + `$AUTO_HTTP_PORT` 覆盖 + 启动失败给提示 | 启动时 bind `127.0.0.1:0` 让 OS 分配，写入 `~/.first-tree/auto/runner/http.port` 让 watch / dashboard 读取（更彻底但需改 main 的 hardcode） |
| **D5** | 子命令对外暴露范围（**已校正自 v2**） | commander catch-all 不区分（D11），`runAuto` 内部 DISPATCH 14 个；`AUTO_USAGE` 文档中标 primary 7（install / start / stop / status / doctor / watch / poll）+ advanced 4（run / daemon / run-once / cleanup）+ hidden 3（statusline / status-manager / poll-inbox） | 删除 hidden 3（`statusline` 必须保留）→ 不可取 |
| **D6** | statusline 独立 bundle 是否本次完成 | 是。`packages/auto/src/statusline.ts` → `apps/cli/dist/auto-statusline.js`（tsdown 打包） | 推后；但 statusline 不出，watch / dashboard 也基本不可用，迁移意义大半折损 |
| **D7** | apps/cli 构建工具（**已扩张自 v2**） | `apps/cli/build` 切到 **tsdown**，内联 `@first-tree/auto`；保留 `tsc --noEmit` 用于 typecheck | 维持 tsc + 改用 module path resolution + 发布 packages/auto（违反 AGENTS.md packages internal）；维持 tsc + prepack 复制 packages/auto 编译产物（可行但比 tsdown 内联繁琐） |
| **D8** | dashboard.html 落点（**已校正自 v2**） | `packages/auto/assets/dashboard.html`，由 apps/cli prepack 流程复制到 `apps/cli/dist/assets/dashboard.html` | apps/cli 自带 assets/（违 AGENTS 分层精神，apps 层不应承载产品资源） |
| **D9** | skills 落点（**已校正自 v2**） | `packages/auto/skills/auto/SKILL.md`，由 apps/cli prepack 复制到 `apps/cli/dist/skills/auto/SKILL.md` | 仓库顶层 `skills/auto/`（不会自然进 npm 包，需要修改 apps/cli `files`） |
| **D10** | 实施粒度 | **多 PR / 多 commit 分阶段**（见 §6） | 单 PR 一次性合（review 不可行：12k 行 + 42 模块 + 34 测试） |
| **D11** | apps/cli 适配粒度（**已校正自 v2**） | **选项 B catch-all**：`auto [args...]` 单命令透传 | 选项 A 每子命令独立注册 → 需先扩展 `SubcommandModule` / `groups.ts` / `context.ts` 框架，本次范围爆炸 |
| **D12** | 测试是否一同迁 | 是。每个 phase 把对应模块的 vitest 测试一起搬过来 | 推后；但代码迁移没有测试守护，回归风险高 |
| **D13** | 业务代码"原样照搬" vs 顺手改名 | **原样照搬**，仅做命名 / 路径 / 端口替换。不动逻辑、不动结构、不重命名内部变量 | 顺手按 AGENTS.md 风格规整 → 推后到独立 PR |
| **D14** | 发布物组装策略（新增） | tsdown 内联 `@first-tree/auto` 进 `apps/cli/dist/index.js` + statusline 独立 bundle + `prepack` 脚本复制 `packages/auto/{assets,skills,VERSION}` 到 `apps/cli/dist/` | 发布 `@first-tree/auto` 到 npm（违反 AGENTS.md packages internal） |
| **D15** | apps/cli `files` 字段更新（新增） | 维持 `["dist"]`；所有资源 prepack 进入 `dist` | 增加 `["dist", "skills"]` 等顶层路径（更脆弱，依赖路径解析） |

## 6. 分阶段实施 Plan（D10 推荐方案）

每个 phase 是一个独立 PR 或一组紧凑 commits。每个 PR 控制在 **≤1500 行 diff**。

| Phase | 范围 | 文件量 | 依赖 | 验收 |
|---|---|---|---|---|
| **P0** | 方案签收（本文档 v4） | 0 代码 | — | yuezengwu + Codex 标"通过" |
| **P1** | bootstrap：`packages/auto/{package.json, tsconfig.json, src/index.ts, README.md}`；apps/cli 引入 tsdown（dependencies + build script）；`apps/cli/src/commands/auto/index.ts` catch-all 注册（运行 `runAuto` 返回未实现错误）；新增根 `tsconfig.base.json` + 根 `tsconfig.json` manifest（详见 §9.2） | ~8 新增 + ~4 修改 | P0 | `pnpm -r build`（含 tsdown）通过；`first-tree auto` 退出码 1 + "not implemented yet" |
| **P2** | runtime 层 13 模块 + 13 测试 + 命名/路径替换（`~/.breeze/` → `~/.first-tree/auto/`、env vars） | ~13 src + ~13 测试 | P1 | `pnpm --filter @first-tree/auto test` 通过 runtime 子集 |
| **P3** | daemon 层 17 模块 + 16 测试 + launchd label / 端口 / 路径常量替换 | ~17 src + ~16 测试 | P2 | daemon 子集测试通过；`runAuto(["daemon"])` 起 server 但不 sched 任何任务（smoke） |
| **P4** | commands 层 9 模块 + 5 测试；`packages/auto/src/cli.ts` DISPATCH 14 全部上线；`AUTO_USAGE` / `AUTO_INLINE_HELP` 输出 | ~9 src + ~5 测试 | P3 | `first-tree auto status` / `... doctor` / `... poll` smoke 通过 |
| **P5** | bridge.ts + statusline.ts + tsdown 配置 + `apps/cli/dist/auto-statusline.js` 产出 | ~3 src + 配置 | P4 | `node apps/cli/dist/auto-statusline.js` 输出有效 statusline；冷启动 < 30ms；bundle 字节数与 main 同量级 |
| **P6** | `dashboard.html` + `skills/auto/SKILL.md` + `VERSION`；apps/cli `prepack` 脚本复制资源到 `dist/`；`apps/cli/package.json:files` 维持 `["dist"]` 验证打包结果 | ~3 src + prepack 脚本 | P5 | `pnpm pack --filter first-tree` 产物含 `dist/assets/dashboard.html`、`dist/skills/auto/SKILL.md`、`dist/VERSION`；`first-tree auto start` 后浏览器 `http://127.0.0.1:7879/` 加载 dashboard |
| **P7** | 跨平台 smoke：macOS launchd / Linux detached spawn / Windows fallback；CI matrix；交付 `scripts/regression-auto.sh`（§13 自动化部分） | ~150 行 shell + CI 配置 | P6 | §13 本地回归清单全部跑通（macOS + Linux 各一台）+ CI 三平台全绿 |

总周期估算：**单人 6–12 工作日**（v3 起引入 bundler 切换 + prepack 流程，v4 沿用，比 v2 略多）。

## 7. 风险与缓解

| # | 风险 | 严重 | 缓解 |
|---|---|---|---|
| **R1** | 端口冲突：与 main breeze 同时运行时争 `127.0.0.1:7878` | 中 | D4 默认改 7879；`$AUTO_HTTP_PORT` 覆盖；启动失败给具体提示 |
| **R2** | statusline 独立 bundle 构建失败 → Claude Code statusline 整条链路炸 | 高 | D6 + D7：tsdown 显式 entry；P5 smoke `node dist/auto-statusline.js` |
| **R3** | dashboard.html 资源路径在 bundler / prepack 流程下丢失 | 中 | `packages/auto/src/daemon/http.ts` 用 `import.meta.url` 解析相对路径；prepack 脚本测试 + P6 端到端 smoke |
| **R4** | launchd plist 路径 / UID / GID 在新结构下不正确 | 中 | 完全沿用 main 的 plist 模板，仅替换 label 与 binary 路径；P3 + P7 macOS smoke |
| **R5** | 测试假设 `~/.breeze/` 存在或在测试外残留 daemon 进程 | 中 | 测试统一 `process.env.AUTO_DIR = mkdtempSync()`；teardown 强制 `runAuto(["stop"])`；vitest `globalSetup` 清理 lockfiles |
| **R6** | 12k 行 + 34 测试一次性 review 不可行 | 高 | D10 强制分阶段；每个 phase < 1500 行变更 |
| **R7** | `breeze → auto` 命名替换漏改（文档 / 注释 / 错误信息中残留 "breeze" 字样） | 低 | 每个 phase 收尾 `grep -ri "breeze\|BREEZE" packages/auto`，PR checklist 必查 |
| **R8** | `~/.breeze/inbox.json` schema 与 Rust runner 字节级兼容（main 注释强调）；refactor 线未来引入 Rust 集成时不能漂移 | 低 | D13 原样照搬 schema 与 zod 类型；P2 测试覆盖 round-trip |
| **R9** | tsdown 接管 apps/cli build 后，commander 等 native-ish 模块的 bundling 兼容性问题（如 `import.meta.url` 解析、动态 import、`__dirname` polyfill） | 中 | P1 验证 tsdown 配置：external `node:*`、target `node22`、format `esm`；P5 / P6 smoke 串联 |
| **R10** | `packages/auto` 内 React 19 + Ink 7 与 apps/cli 工具链兼容性（本仓库与 main 工具版本不一致；`apps/cli/package.json` 当前声明 `typescript: ^6.0.3`，TypeScript 6 在 npm registry 主流通道不可用，需在 P1 阶段先实测包是否解析为 5.x preview / fork 或确属 typo） | 中 | P1 试装依赖 + `tsc -b --noEmit` 全跑通；如果 tsdown bundling React 出问题，回退：把 `watch.tsx` 标为 lazy import + 不内联进主 bundle（保留独立 chunk） |
| **R11** | private `@first-tree/auto` 在 npm 安装链上的解析：用户 `npm i -g first-tree` 时 `apps/cli/dist/index.js` 必须**完全自给自足**，不能在运行时 `require("@first-tree/auto")` | 高 | tsdown 配置 `noExternal: ["@first-tree/auto"]`（或等价）；P1 验收时手工 `pnpm pack` + 在干净目录 `npm i ./pack.tgz` 跑 smoke |
| **R12** | commander v14 默认 `--help` 在 catch-all 命令上会截获 token，action 不被调用 → `runAuto` 永远收不到 `--help` | 高 | catch-all 上显式 `.helpOption(false)` + `.helpCommand(false)`（§4.4）；`runAuto` 内 `isHelpInvocation` 已识别 `--help` / `-h` / `help` 三种 token（main `cli.ts:isHelpInvocation`） |
| **R13** | TypeScript `composite` + `references` 初次引入易踩 incremental cache 不一致；`tsc -p` 不会自动 build referenced project | 中 | 新增根 `tsconfig.base.json` + 根 `tsconfig.json` manifest；workspace typecheck 改用 `tsc -b --noEmit`（§9.2）；P1 阶段先跑 `tsc -b --clean` 再 build 验证；CI 缓存 `*.tsbuildinfo` 时按分支隔离 |

## 8. 测试策略

- **测试文件迁移粒度**：每个 phase 把对应模块的 vitest 测试一并搬过来；测试路径 `packages/auto/tests/<layer>/<module>.test.ts`。
- **测试运行**：`pnpm --filter @first-tree/auto test`（包级）+ `pnpm -r test`（workspace 全量，CI 必跑）。
- **fixture 隔离**：测试一律 `process.env.AUTO_DIR = mkdtempSync()`，避免污染 `$HOME`。
- **集成测试中的真实 daemon**：保留 main 上的 strategy；P3 收尾时把 hardcode `7878` 改成可注入（默认 `7879`，测试用 `127.0.0.1:0` 让 OS 选端口）。
- **跨平台 CI**：refactor 线现有 CI（commit `813a9bb`）已在；P7 加 macos / ubuntu / windows matrix。
- **打包冒烟**：P6 把 `pnpm pack --filter first-tree` 后在干净目录 `npm i ./first-tree-X.Y.Z.tgz` 全程串通跑入 P7 CI。

## 9. 构建与发布（已重写）

### 9.1 依赖添加

`packages/auto/package.json`：

```jsonc
{
  "name": "@first-tree/auto",
  "version": "0.3.0",                 // 沿用 main src/products/breeze/VERSION
  "private": true,                    // 不发布到 npm 公网
  "type": "module",
  "main": "./src/index.ts",           // 由消费方（apps/cli）的 bundler 直接读 src
  "dependencies": {
    "ink": "^7.0.0",
    "react": "^19.2.5",
    "yaml": "^2.8.3",
    "zod": "^4.3.6",
    "proper-lockfile": "^4.1.2"
  },
  "devDependencies": {
    "@types/node": "^22.19.17",       // 与 apps/cli 版本对齐
    "@types/react": "^19.2.14",
    "ink-testing-library": "^4.0.0",
    "tsdown": "^0.12.0",
    "typescript": "^6.0.3",           // 与 apps/cli 对齐
    "vitest": "^4.1.5"
  }
}
```

`apps/cli/package.json`（增量）：

```jsonc
{
  "dependencies": {
    "commander": "^14.0.3",
    "@first-tree/auto": "workspace:*"
  },
  "devDependencies": {
    "tsdown": "^0.12.0",
    // ... 现有
  },
  "scripts": {
    "build": "tsdown",                                              // 切换自 "tsc -p tsconfig.json"
    "typecheck": "tsc -b --noEmit",                                 // 切换自 "tsc -p ..."（详见 §9.2）
    "prepack": "pnpm run build && node scripts/copy-auto-assets.mjs", // 已校正自 v3：必须先 build；与 main `package.json:6 "prepack": "pnpm build"` 同模式
    "test": "pnpm run build && vitest run",
    "test:coverage": "pnpm run build && vitest run --coverage"
  }
}
```

**为什么 prepack 必须显式带 build**：npm `prepack` lifecycle 不会自动触发 build；干净 checkout 上直接 `pnpm pack --filter first-tree` 时 `apps/cli/dist/` 不存在，仅复制 assets 会产出残缺/空 tarball（这是 v3 的硬错误，已修正）。

### 9.2 TypeScript 链路：`tsconfig.base.json` + 根 manifest + `tsc -b`（已重写）

> **背景（已校正自 v3）**：v3 §9.2 仅说"`apps/cli/tsconfig.json` 增 references"，但当前 worktree **根目录不存在 `tsconfig.json`**，且 `apps/cli/package.json:scripts.typecheck` 是 `tsc -p ... --noEmit`——`tsc -p` 即使读到 references 也**不会自动 build referenced project**，必须用 `tsc -b`（build mode）。需要补全完整链路：base config + 根 manifest + 切换到 `-b`。

新增 worktree 根 `tsconfig.base.json`（草案，~15 行）：

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "composite": true,                    // 启用 references 必需
    "incremental": true                   // 配合 *.tsbuildinfo 加速 -b
  }
}
```

新增 worktree 根 `tsconfig.json`（manifest，仅作 -b 入口，不直接 emit）：

```jsonc
{
  "files": [],
  "references": [
    { "path": "./apps/cli" },
    { "path": "./packages/auto" }
  ]
}
```

`apps/cli/tsconfig.json` 改造：

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
    // composite: true 由 base 继承
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../../packages/auto" }
  ]
}
```

`packages/auto/tsconfig.json` 同样 extends 根 base，设 `outDir: "./dist"`（仅供 typecheck，**发布物不依赖此 dist**——发布物全部走 apps/cli 的 tsdown bundler 内联 + prepack 资源复制）。

根 `package.json:scripts.typecheck` 改为：

```jsonc
{
  "scripts": {
    "typecheck": "tsc -b --noEmit"        // 切换自 "pnpm -r typecheck"
  }
}
```

**关键差异**：
- `tsc -b`（build mode）会按 references 拓扑序自动 build / typecheck 依赖项；`tsc -p` 不会。
- `composite: true` 是 references 必备项，不能省。
- 切换风险见 §7 R13。

### 9.3 bundle 产物

apps/cli 的 `tsdown.config.ts`（新增）：

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "auto-statusline": "../../packages/auto/src/statusline.ts",
  },
  format: "esm",
  target: "node22",
  platform: "node",
  external: [/^node:/],
  noExternal: [/^@first-tree\//],     // 把 @first-tree/auto 全部内联进 dist
  outDir: "dist",
  // ... 其他与 main tsdown.config.ts 对齐
});
```

产出：

- `apps/cli/dist/index.js`（主 CLI，含从 `@first-tree/auto` 来的代码全量内联）
- `apps/cli/dist/auto-statusline.js`（独立零依赖 bundle，**Claude Code statusline hook 入口**）

### 9.4 prepack 资源复制脚本

`apps/cli/scripts/copy-auto-assets.mjs`（新增，~30 行 Node 脚本）：

- 从 `packages/auto/assets/dashboard.html` → `apps/cli/dist/assets/dashboard.html`
- 从 `packages/auto/skills/auto/SKILL.md` → `apps/cli/dist/skills/auto/SKILL.md`
- 从 `packages/auto/VERSION` → `apps/cli/dist/VERSION`

由 `pnpm pack --filter first-tree` 自动触发（npm `prepack` lifecycle）。

### 9.5 `files` 字段

`apps/cli/package.json:files` 维持 **`["dist"]`**——所有可发布物都先聚到 `dist/` 由 prepack 完成；不需要在 files 字段额外列出顶层目录。

### 9.6 不发布的部分

- `packages/auto`（`private: true`）
- 仓库顶层 `skills/`（不存在，本方案不在仓库顶层创建）
- 仓库顶层 `assets/`（不存在，本方案不在仓库顶层创建）
- 根 `package.json`（`private: true`，从来不发布）

### 9.7 版本号

- `packages/auto/VERSION` 沿用 main 的 `0.3.0`（与 `package.json:version` 同步，由 main 上 `scripts/sync-version.js` 等价物维护——此脚本本身在 P0–P7 范围之外，沿用 main 行为）。
- `apps/cli/package.json:version` 维持 refactor 线现状 `0.3.1-alpha`。两版本号独立 SemVer，不联动。

## 10. 不在范围内（重申）

- 不动 main 分支。
- 不重写、不优化 breeze 业务逻辑。
- 不引入新功能、新子命令、新协议。
- 不迁移 gardener / tree / shared。
- 不解决 refactor 线现存 hub / init / tree placeholder 的真实化。
- 不引入新 CI 平台（沿用现有）。
- 不修改 root package.json 之外的全局工具配置（eslint / prettier / editorconfig 仅在影响新文件 lint 时调整）。
- 不升级 commander framework 以支持选项 A 风格（推后到独立 PR）。
- 不发布 `@first-tree/auto` 到 npm。

## 11. 估算

- **代码增量**：~12k 行（业务）+ ~5k 行（测试）+ ~50 行（apps/cli 适配 catch-all）+ ~30 行（prepack 脚本）+ ~150 行（tsdown / package.json / tsconfig 配置）。
- **PR 数**：8（P0 文档 + P1–P7 实施）。
- **单人工时**：6–12 工作日（v3 起引入 tsdown + prepack 流程略增，v4 沿用）。关键路径仍在 P3（daemon 层）。
- **review 工时**：每 PR 30–90 分钟（已分阶段，单 PR ≤1500 行 diff）。

## 12. Review 检查清单（v4）

- [ ] **路线 A 边界例外**：§0.1 的理由是否充分？是否需要 update [`AGENTS.md`](../../AGENTS.md) 写明 product package 例外？
- [ ] **范围**：§2 in/out scope 是否完整？
- [ ] **决策点**：D1–D15 推荐值是否合理？特别是：
  - D4（端口默认 7879 vs ephemeral）
  - D7（apps/cli 切到 tsdown）
  - D11（catch-all 而非每子命令独立注册）
  - D14（bundler 内联 vs prepack 复制 vs 发布 packages/auto）
- [ ] **分阶段 plan**：§6 phase 切分是否合理？P3 daemon 层一个 PR 是否过大？
- [ ] **风险**：R1–R13 是否有遗漏？特别是 R9（tsdown 兼容性）、R10（React/Ink + 工具链 + typescript ^6.0.3 实际可解析性）、R11（private 包必须被完全内联）、R12（commander v14 默认 help 截获）、R13（TS composite/references 编排）。
- [ ] **构建链**：§9 tsdown 配置 + prepack 脚本是否可执行？是否需要在 P0 阶段先做一个 spike（实测 tsdown 内联 React+Ink 的产物大小、冷启动）？
- [ ] **commander 适配**：§4.4 选项 B 在用户体验上能否接受（`first-tree --help` 不列出 auto 的子命令）？
- [ ] **本地回归**：§13 清单是否覆盖完整？是否有 main 上 breeze 的关键场景在本地无法验证？per-phase 子集（§13.10）切分是否合理？

## 13. 本地回归验收流程

本章描述 **不依赖 CI、不依赖远端 GitHub Actions** 的开发者本地端到端回归路径。

- **目的**：每个 phase 收尾时本地必须能跑通的验收清单；P7 合入前必须在至少一台 macOS + 一台 Linux 主机上把 §13.1–§13.9 全部跑通。
- **交付物**：P7 范围内提供 `apps/cli/scripts/regression-auto.sh`（自动化部分，覆盖 §13.1–§13.6 + §13.9）+ 本章手册（人工 / 跨平台部分，§13.7、§13.8）。
- **前置条件**：
  - **运行时**：Node 22+、pnpm 10.32+。
  - **认证**：部分 daemon smoke 需要 `gh auth login` 已完成 + 一个允许写入的测试 repo（例：`yuezengwu/first-tree-auto-smoke`，由 reviewer 提供或临时创建）；不需要时自动跳过。
  - **本地工具**（**已校正自 v3**：v3 仅列 Node/pnpm/gh，遗漏脚本依赖）：
    - 必备：`curl`、`jq`、`lsof`、`pgrep`、`grep`、`awk`、`sed`。
    - macOS：`brew install jq coreutils`（`coreutils` 提供 GNU `gtimeout` / `timeout`，BSD 自带 `timeout` 行为不兼容）；`launchctl` 系统自带。
    - Linux：发行版包管理装 `jq`、`lsof`、`procps`（含 `pgrep`）、`coreutils`（GNU `timeout` 自带）。
    - Windows：仅跑 §13.7 的 `MINGW` 分支（build + help），其余工具不要求。
  - **平台分工**：macOS 主机用于 launchd smoke；Linux 主机用于 detached spawn smoke；Windows 仅 build/help smoke。
- **隔离**：所有命令一律通过 `AUTO_DIR=$(mktemp -d)` 隔离 HOME，运行结束后 `rm -rf "$AUTO_DIR"`，**不污染** `~/.first-tree/auto/`。

> **失败处理通用规则**：任一步退出码非 0、或 `grep` 命中非预期内容、或 `curl` 非 2xx 响应 → 整个回归流标记为 RED，先定位再继续。脚本以 `set -euo pipefail` 起手。

### 13.0 Capability check（`scripts/regression-auto.sh` 顶端模板）

回归脚本第一段必须做工具自检，在缺失时给出 macOS / Linux 各自的安装提示，不直接进入业务 smoke：

```bash
#!/usr/bin/env bash
set -euo pipefail

required=(node pnpm gh curl jq lsof pgrep)
missing=()
for tool in "${required[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if (( ${#missing[@]} )); then
  echo "missing tools: ${missing[*]}" >&2
  case "$(uname)" in
    Darwin) echo "  install: brew install ${missing[*]}" >&2 ;;
    Linux)  echo "  install: <distro pkg manager> install ${missing[*]}" >&2 ;;
  esac
  exit 1
fi

# GNU timeout 在 SSE smoke 用到；macOS 默认 BSD timeout 不兼容
TIMEOUT_CMD=""
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
else
  echo "warn: no GNU timeout; SSE smoke (§13.4) will degrade to head-based limit" >&2
fi
export TIMEOUT_CMD
```

`§13.4` 中 `timeout 3 curl ...` 改为 `${TIMEOUT_CMD:-} 3 curl ...`，缺失时 fallback 到 `head -3`（参见 §13.4 注释）。

**关于 smoke 端口选取**：§13 各段一律 `export AUTO_HTTP_PORT=7990` 覆盖默认 `7879`（默认值见 §4.3 / §5 D4），目的是避免 dev 主机已长驻的默认端口 daemon 被 smoke 流程误关或抢占。要验证"默认端口生效"的断言（§13.8 与 main breeze 共存）则显式说明端口选取理由——main breeze 仍占 7878，auto 默认 7879，smoke 用 7990 不与任何一方冲突。

### 13.1 命名扫描（最快、纯静态）

| 验收点 | 期望 | 命令 |
|---|---|---|
| `packages/auto/` 全树不残留 `breeze` 字样 | 0 匹配 | `! grep -rni "breeze\|BREEZE" packages/auto/src packages/auto/tests packages/auto/assets packages/auto/skills` |
| `apps/cli/src/commands/auto` 不残留 `breeze` | 0 匹配 | `! grep -rni "breeze\|BREEZE" apps/cli/src/commands/auto` |
| `dist/` 产物不残留 `breeze`（防 string literal 漏改） | 0 匹配 | `! grep -i "breeze\|BREEZE" apps/cli/dist/index.js apps/cli/dist/auto-statusline.js` |

如需在迁移注释中保留 "原 breeze ..." 的 trace，使用白名单标记 `// keep: original breeze ref`，扫描脚本对此放行。

### 13.2 包级测试

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r build                          # tsc + tsdown 链
pnpm -r test                           # workspace 全部 vitest
pnpm --filter @first-tree/auto test    # 包级过滤，dev loop 用
```

期望：全绿；无 `console.warn`、无 `unhandledRejection`；`@first-tree/auto` 全部 **34 个测试文件**（runtime 13 + daemon 16 + commands 5）所含的 vitest case 全 pass。

### 13.3 CLI 行为 smoke（不依赖外部网络）

```bash
export AUTO_DIR=$(mktemp -d)

# Help 与子命令路由
node apps/cli/dist/index.js --help                # 必须包含 "auto"
node apps/cli/dist/index.js auto --help           # 由 packages/auto 的 AUTO_USAGE 输出
node apps/cli/dist/index.js auto                  # 等同于 --help

# 不需要真启动 daemon 的子命令
node apps/cli/dist/index.js auto doctor           # 检查 gh / Node 版本，输出 OK / 缺失项
node apps/cli/dist/index.js auto status           # 无 daemon 时报 "daemon not running" 或等价

# 错误路径（注：§13.0 设了 `set -e`，故此处用 `!` 反转退出码而非 `cmd; test $? -ne 0`，
# 否则首句非 0 退出会被 `set -e` 直接 abort，永远到不了校验那一行）
! node apps/cli/dist/index.js auto unknown-sub
! node apps/cli/dist/index.js auto start                   # 缺 --allow-repo 应失败

rm -rf "$AUTO_DIR"
```

### 13.4 HTTP / SSE / Dashboard smoke（需要 `gh auth login` + 测试 repo）

```bash
export AUTO_DIR=$(mktemp -d)
export AUTO_HTTP_PORT=7990
export AUTO_REPO="yuezengwu/first-tree-auto-smoke"

node apps/cli/dist/index.js auto install --allow-repo "$AUTO_REPO"
node apps/cli/dist/index.js auto start --allow-repo "$AUTO_REPO"
sleep 2

# 7 条 HTTP route（与 main 对齐）
curl -fsS "http://127.0.0.1:7990/healthz"           | grep -q ok
curl -fsS "http://127.0.0.1:7990/inbox"             | jq . >/dev/null
curl -fsS "http://127.0.0.1:7990/activity"          | head -c 1024 >/dev/null
curl -fsS "http://127.0.0.1:7990/dashboard"         | grep -q "<html"
curl -fsS "http://127.0.0.1:7990/index.html"        | grep -q "<html"
curl -fsS "http://127.0.0.1:7990/"                  | grep -q "<html"
${TIMEOUT_CMD:-} 3 curl -fsSN "http://127.0.0.1:7990/events" | head -3   # SSE 头部；macOS 需 brew install coreutils 提供 gtimeout（参 §13.0），缺失时仅靠 head -3 限行

node apps/cli/dist/index.js auto stop
rm -rf "$AUTO_DIR"
```

期望：所有端点 2xx；`/dashboard` 返回 HTML；`/events` 立刻有 keep-alive frame；`auto stop` 后端口空闲。

### 13.5 Statusline 独立 bundle smoke

```bash
# 冷启动时间（5 次取 min，应 < 30ms）
for i in 1 2 3 4 5; do
  /usr/bin/time -p node apps/cli/dist/auto-statusline.js < /dev/null 2>&1 | awk '/real/ {print $2}'
done

# 文件大小 < 100KB（与 main breeze-statusline 同量级）
test "$(wc -c < apps/cli/dist/auto-statusline.js)" -lt 102400

# 零运行时外部依赖（仅 node:* import 允许）
node -e '
  const src = require("fs").readFileSync("apps/cli/dist/auto-statusline.js", "utf8");
  const leak = (src.match(/from ["'\''](?!node:)[a-z@][^"'\'']+["'\'']/g) || []);
  if (leak.length) { console.error("external imports leaked:", leak.slice(0,5)); process.exit(1); }
'
```

### 13.6 发布物 smoke（pnpm pack + 干净环境安装）

```bash
# 在 apps/cli 下打包
( cd apps/cli && pnpm pack )
TARBALL="$PWD/apps/cli/$(ls -1 apps/cli/first-tree-*.tgz | head -1 | xargs basename)"

# 干净临时环境安装
TMP=$(mktemp -d)
( cd "$TMP" && npm init -y >/dev/null && npm i "$TARBALL" )

# dist 完整性
test -f "$TMP/node_modules/first-tree/dist/index.js"
test -f "$TMP/node_modules/first-tree/dist/auto-statusline.js"
test -f "$TMP/node_modules/first-tree/dist/assets/dashboard.html"
test -f "$TMP/node_modules/first-tree/dist/skills/auto/SKILL.md"
test -f "$TMP/node_modules/first-tree/dist/VERSION"

# bin 可执行
"$TMP/node_modules/.bin/first-tree" --help | grep -q auto
"$TMP/node_modules/.bin/ft" --version

# 关键：私有 @first-tree/auto 必须**已被内联**，不能在 node_modules 中存在
test ! -d "$TMP/node_modules/@first-tree"

rm -rf "$TMP"
rm -f apps/cli/first-tree-*.tgz
```

期望：所有断言通过；尤其最后一条防御 R11（private 包未被 bundler 内联会让运行时崩溃）。

### 13.7 平台条件 smoke（人工 + 脚本结合）

```bash
case "$(uname)" in
  Darwin)
    export AUTO_DIR=$(mktemp -d)
    export AUTO_HTTP_PORT=7990
    node apps/cli/dist/index.js auto start --allow-repo "$AUTO_REPO"
    sleep 2

    # plist 写入路径
    ls "$AUTO_DIR"/runner/launchd/com.first-tree.auto.*.plist
    # launchctl 注册
    launchctl list | grep com.first-tree.auto

    node apps/cli/dist/index.js auto stop
    sleep 1
    # bootout 后 launchctl 应清掉
    launchctl list | grep com.first-tree.auto && exit 1 || true
    rm -rf "$AUTO_DIR"
    ;;
  Linux)
    export AUTO_DIR=$(mktemp -d)
    export AUTO_HTTP_PORT=7990
    node apps/cli/dist/index.js auto start --allow-repo "$AUTO_REPO"
    sleep 2

    ls "$AUTO_DIR"/runner/locks/
    pgrep -f "first-tree.*auto.*daemon"

    node apps/cli/dist/index.js auto stop
    sleep 1
    pgrep -f "first-tree.*auto.*daemon" && exit 1 || true
    rm -rf "$AUTO_DIR"
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    # Windows fallback 仅验证 build + help（detached spawn 行为不同，不在本方案首发支持）
    node apps/cli/dist/index.js --help | grep -q auto
    node apps/cli/dist/index.js auto --help
    ;;
esac
```

### 13.8 与 main breeze 共存 smoke（仅当机器上同时装有 main breeze）

```bash
# 假设 main breeze 已在跑（占用 ~/.breeze + 7878）
ls ~/.breeze >/dev/null 2>&1 && echo "main breeze present"
curl -fsS http://127.0.0.1:7878/healthz >/dev/null 2>&1 && echo "main breeze daemon up"

# auto 用独立 HOME + 端口启动
export AUTO_DIR=$(mktemp -d)
export AUTO_HTTP_PORT=7990
node apps/cli/dist/index.js auto start --allow-repo "$AUTO_REPO"
sleep 2

# 双 daemon 并存
curl -fsS http://127.0.0.1:7878/healthz   # main breeze
curl -fsS http://127.0.0.1:7990/healthz   # auto

# 文件系统隔离断言
test -e "$AUTO_DIR"/inbox.json
test ! -e ~/.breeze/inbox.json.modified-by-auto    # auto 不写 main HOME

# 关闭 auto，确认 main breeze 不受影响
node apps/cli/dist/index.js auto stop
sleep 1
curl -fsS http://127.0.0.1:7878/healthz   # main breeze 仍然 up

rm -rf "$AUTO_DIR"
```

### 13.9 清理与隔离断言（每段末尾必跑）

```bash
# 强制 stop 所有遗留 auto daemon（不影响 main breeze）
node apps/cli/dist/index.js auto stop 2>/dev/null || true

# 临时目录清理
test -n "${AUTO_DIR-}" && rm -rf "$AUTO_DIR"

# 端口未占用（如果 7990 仍 LISTEN，说明 stop 未生效）
! lsof -iTCP:7990 -sTCP:LISTEN 2>/dev/null

# 测试 repo 上不应留下任何 auto 创建的 issue/comment（人工 spot-check）
echo "Manual: visit https://github.com/$AUTO_REPO/issues 确认无新增噪声"
```

### 13.10 per-phase 子集（与 §6 联动）

| Phase | 必跑 §13 子集 | 期望产出 |
|---|---|---|
| **P1** | §13.1（仅 src/index.ts 阶段也要跑）+ §13.2（build / typecheck） | bootstrap 包能 build；`first-tree auto` 退出码 1 |
| **P2** | + §13.2（runtime 测试加入）+ §13.3 doctor / status 子集 | runtime 测试全绿 |
| **P3** | + §13.4 HTTP smoke（用 `runAuto(["daemon"])` direct invoke；commands 层尚未实施，**暂不通过 `auto start` CLI 入口**） | daemon 起 server，HTTP routes 响应 |
| **P4** | §13.1 + §13.2 + §13.3 + §13.4 完整 + §13.7 平台对应分支（首次能跑 `auto install` / `auto start` 完整 CLI 路径） | 11 条 `AUTO_USAGE` 子命令路径全通；macOS launchd 注册 / Linux lockfile 工作 |
| **P5** | + §13.5 statusline bundle | bundle < 100KB / 冷启动 < 30ms / 零外部依赖 |
| **P6** | + §13.6 发布物 smoke | tarball 在干净环境可装可跑、私包未泄漏 |
| **P7** | §13.1–§13.9 **全部**，至少 macOS + Linux 各一台（+ Windows 跑 §13.7 的 `MINGW` 分支） | 三平台 GREEN，CI matrix 同步全绿 |

### 13.11 退出条件

整套回归 GREEN 的定义：

1. §13.1–§13.6 在 macOS + Linux 两台主机都通过；
2. §13.7 各自平台分支通过；
3. §13.8 在至少一台同装两套的主机通过；
4. §13.9 清理后无残留进程 / 端口 / 临时目录；
5. CI 三平台 matrix 同步全绿（与本地回归互为冗余）。

任一不满足即 RED，回到对应 phase 重做。

---

明确"通过"或具体反馈后进入 P0 → P1。
