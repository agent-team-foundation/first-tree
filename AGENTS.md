# AGENTS.md

Agent Hub — Agent Team 中心化协作平台（Server + Client + Command + Shared + Web monorepo）。

## 系统定位

Agent Hub 是 Agent Team 的基础设施，提供 Agent 注册/认证、消息通信、外部 IM 桥接和管理后台。

```
Agent Hub ≠ Agent 本身（具体的 LLM agent 逻辑不在 Hub 内）
Agent Hub ≠ 编排框架
Agent Hub ≠ Context Tree
```

## 技术栈

**Server:** Fastify / Drizzle ORM / PostgreSQL / Zod / bcrypt / jose / @fastify/websocket / @fastify/rate-limit

**Client:** fetch + ws（SDK + AgentRuntime 运行时 + 可插拔 Handler）

**Command:** Commander.js / @inquirer/prompts（统一 CLI）

**Shared:** Zod schemas + TypeScript 类型 + 配置系统（三端共享）

**Web:** React 19 / Vite

**工具链:** pnpm (workspace) / Turborepo / Biome / Vitest / tsdown / tsc

**Node.js:** 最低 22.16，推荐 24

## 常用命令

```bash
# 环境
pnpm install                          # 安装全部依赖
docker compose up -d                  # 启动 PostgreSQL（开发用）

# 一键启动（CLI 方式，含交互式配置、自动迁移、Web 内嵌）
pnpm --filter @unispark.ai/agent-hub dev -- server start

# 分别启动（传统开发方式）
pnpm --filter @agent-hub/server dev   # 启动 server（tsx watch，需 .env）
pnpm --filter @agent-hub/web dev      # 启动 web（Vite dev server）

# 质量
pnpm check                            # Biome lint + format 检查
pnpm format                           # Biome 格式化
pnpm typecheck                        # tsc --noEmit
pnpm test                             # Vitest
pnpm --filter @agent-hub/server test  # 测试（仅 server）

# 构建
pnpm build                            # Turborepo 编排全量构建

# 数据库
pnpm --filter @agent-hub/server db:generate    # 生成迁移
pnpm --filter @agent-hub/server db:migrate     # 应用迁移
pnpm --filter @agent-hub/server db:studio      # Drizzle Studio
```

> CLI 完整命令和环境变量参考：[docs/cli-reference.md](docs/cli-reference.md)

## Monorepo 结构

```
agent-hub/
├── package.json               # pnpm workspace 根配置
├── pnpm-workspace.yaml        # workspace 成员
├── turbo.json                 # Turborepo 任务编排
├── tsconfig.json              # 根 tsconfig（项目引用）
├── biome.json                 # Biome lint + format
├── docker-compose.yml         # 本地开发 PostgreSQL
│
├── docs/                          # 文档
│   ├── cli-reference.md          # CLI 命令 + 环境变量参考
│   └── claim-agent-guide.md      # Claim Agent 配置指南
│
├── packages/
│   ├── shared/                # @agent-hub/shared — 共享 Zod schema + 类型 + 配置系统
│   ├── server/                # @agent-hub/server — Fastify API 服务
│   ├── client/                # @agent-hub/client — Agent SDK + Runtime
│   ├── command/               # @unispark.ai/agent-hub — 统一 CLI（发布包）
│   └── web/                   # @agent-hub/web — React 管理后台
```

## 架构规则

**五包独立，Shared 共享：** Server、Client、Command、Web 独立打包部署，通过 `@agent-hub/shared` 共享类型、Zod schema 和配置系统。Command 包是统一 CLI 入口，依赖 Server 和 Client。

**Server 无状态：** 所有持久数据在 PostgreSQL，Server 不持有业务状态。

**仅依赖 PostgreSQL：** 不引入 Redis / MQ。PG 覆盖存储、队列（SKIP LOCKED）、通知（LISTEN/NOTIFY）。

**双轨认证隔离：**
- Agent Token（Bearer）→ Agent API — 机器凭证
- Admin JWT → Admin API — 人类凭证
- 两套认证**完全隔离**，localhost 也必须认证

**Inbox 是 Server/Client 边界：** Server 写入 Inbox（fan-out on write），Client 拉取/WebSocket 通知。at-least-once 投递，Client 负责去重。

**Context Tree 是 Agent 身份唯一来源：** Server 通过 GitHub GraphQL API 从 Context Tree 仓库同步 Agent 身份（启动 + 定时 + 手动触发）。Server 只读树不写回；成员消失时 suspend 而非 delete；Token 管理保持手动。PG Advisory Lock 保证同步单实例运行。

**Adapter 1:1 身份绑定：** 外部 IM 用户（飞书/Slack）映射到 human agent。Adapter 凭证 AES-256-GCM 应用层加密存储。PG NOTIFY 触发 Adapter 配置热加载。

**UUID v7 作为 Message ID：** 时间有序，消息不可变。

## 编码规范

- **禁止 `any`**: 用 `unknown` + 类型收窄
- **禁止 `as` 断言**: 除非与第三方库交互无法避免，需注释原因
- **禁止 `enum`**: 用 `as const` 对象替代，保持与 Zod 兼容
- **类型导入**: `import type { Foo } from ...`
- **优先 `type`**: 需要 `extends` / `implements` 时才用 `interface`
- **公共 API 必须标注返回类型**, 内部函数可推导
- **Barrel 导出**: 每个包 `src/index.ts` 为唯一公共出口
- **Zod 单一来源**: DTO 用 Zod 定义，`z.infer<typeof schema>` 派生类型
- **Schema 命名**: schema camelCase（`createAgentSchema`），类型 PascalCase（`CreateAgent`）
- **Drizzle 迁移不手动编辑**: `drizzle-kit generate` 生成，`drizzle-kit migrate` 应用
- **自定义错误类**: Service 层抛异常，API 层映射为 HTTP 状态码；禁止空 `catch {}`
- **命名**: 文件 `kebab-case.ts`，类型 `PascalCase`，变量/函数 `camelCase`，常量 `UPPER_SNAKE_CASE`
- **注释和文档字符串使用英文**: 代码中的注释、JSDoc、TODO 等一律用英文
- **修改后必须运行**: `pnpm check && pnpm typecheck`

## 开发流程

### 新功能开发步骤（Server）

1. 定义 Zod Schema（`shared/src/schemas/`）
2. 定义 Drizzle 表结构（`server/src/db/schema/`）— 如需持久化
3. 实现 Service（`server/src/services/`）
4. 定义 API 路由（`server/src/api/`）
5. 生成迁移: `pnpm --filter @agent-hub/server db:generate`
6. 应用迁移: `pnpm --filter @agent-hub/server db:migrate`
7. 编写测试（`server/src/__tests__/`）

### 新功能开发步骤（Client）

1. 如需新 SDK 方法 → 在 `client/src/sdk.ts` 中添加
2. 如需新 Handler 类型 → 在 `client/src/handlers/` 中实现并注册
3. Runtime 层变更 → `client/src/runtime/`（AgentRuntime / AgentSlot / SessionManager）
4. 如涉及共享类型 → 先更新 `shared/src/schemas/`

### 新功能开发步骤（Command）

1. 在 `command/src/commands/` 下添加命令模块
2. 在 `command/src/cli/index.ts` 中注册命令
3. 如涉及配置 → 更新 `shared/src/config/` 中的 schema

### Git 规范

- **分支策略**: trunk-based，feature branch → PR → squash merge → main
- **分支命名**: `feat/xxx`、`fix/xxx`、`refactor/xxx`、`test/xxx`、`docs/xxx`、`chore/xxx`
- **Commit 消息**: Conventional Commits — `feat: xxx`、`fix: xxx`、`refactor: xxx`、`test: xxx`、`docs: xxx`
- **版本发布**: tag + GitHub Release
- 不要自动 commit，等用户测试确认后再提交
