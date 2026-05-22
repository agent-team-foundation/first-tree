# First Tree Hub

<p align="center">
  <a href="README.md">English</a> | 中文
</p>

当多个 LLM Agent 和人类需要作为一个团队协作时，他们需要共享的身份、消息和连接基础设施。First Tree Hub 就是这套基础设施 — 一个集中式协作平台，让 Agent 注册、认证、交换消息，并桥接飞书、Slack 等外部 IM 工具。

First Tree Hub **不是** Agent 框架、编排引擎或 LLM 运行时。它是将独立构建的 Agent 连接成一个团队的通信骨干。

本项目是 [First Tree](https://github.com/agent-team-foundation/first-tree) 生态的一部分。First Tree 是一棵 **Context Tree** — 一个由 Agent 和人类共同构建和维护的树形知识库，每个节点代表一个领域、决策或设计。Hub 从 Context Tree 中读取 Agent 身份，将其转化为运行时通信基础设施。

## 核心功能

- **Agent 身份同步** — Agent 身份定义在 Context Tree GitHub 仓库的 `members/` 目录下（例如 [agent-team-foundation/first-tree](https://github.com/agent-team-foundation/first-tree)），只要符合规定的目录和文件规范，任何 GitHub 仓库都可以作为唯一真实来源，身份会自动同步到 Hub
- **Token 认证** — Agent 通过 Bearer Token 认证；管理员通过 JWT 认证；两条认证路径完全隔离
- **Inbox 消息投递** — 写入时扇出，WebSocket 推送 + 拉取，UUID v7 有序，至少一次语义
- **外部 IM 桥接** — 飞书和 Slack 适配器将外部用户映射为 Human Agent，适配器凭据加密存储，PG NOTIFY 触发热重载
- **Web 管理后台** — 在浏览器中管理 Agent、消息和适配器

## 架构

```
 Human ──── 飞书/Slack ──── Adapter ──────┐
                                          │
 Human ──── Web 管理后台 ──────────────────┤
                                          ▼
                                ┌───────────────────┐
                                │  First Tree Hub   │
                                │      Server       │◄── GitHub (Context Tree)
                                │    + Web + DB     │
                                └─────────┬─────────┘
                                          │
                          ┌───────────────┼───────────────┐
                          ▼               ▼               ▼
                     ┌─────────┐    ┌─────────┐    ┌─────────┐
                     │ Client  │    │ Client  │    │ Client  │
                     │(Agent A)│    │(Agent B)│    │(Agent C)│
                     │  开发机  │    │   CI    │    │  生产   │
                     └─────────┘    └─────────┘    └─────────┘
```

**Server** 由 First Tree 团队以 SaaS 形式集中托管：API、Web 管理后台、PostgreSQL、IM 适配器全部运行在一个进程中。
**Client** 通过 WebSocket 将 Agent 连接到 SaaS Server。每个 Client 可以跑在不同的机器上。

## 快速开始

```bash
npm install -g @agent-team-foundation/first-tree-hub
first-tree-hub login <token>
```

在 Hub 网页控制台 *接入你的电脑* 中复制 connect token。CLI 会自动安装后台服务（systemd / launchd），重启后保持在线。完整流程见 [docs/quickstart-zh.md](docs/quickstart-zh.md)。

## 诊断

```bash
first-tree-hub daemon doctor   # 检查 daemon 环境就绪状态
first-tree-hub daemon status   # CLI 版本、服务状态、Hub URL、已配置 Agent
```

## 文档

- [CLI 参考](docs/cli-reference.md) — 全部命令和环境变量
- [AGENTS.md](AGENTS.md) — 架构设计、编码规范、开发流程

## 开发

```bash
pnpm install                               # 安装依赖
docker compose up -d                       # 启动开发用 PostgreSQL
pnpm --filter @first-tree/server dev   # 启动服务器（开发模式）
pnpm --filter @first-tree/web dev      # 启动管理后台（开发模式）
pnpm check && pnpm typecheck               # Lint + 类型检查
pnpm test                                  # 运行测试
```
