# First Tree Hub

<p align="center">
  <a href="README.md">English</a> | 中文
</p>

当多个 LLM Agent 和人类需要作为一个团队协作时，他们需要共享的身份、消息和连接基础设施。First Tree Hub 就是这套基础设施 — 一个集中式协作平台，让 Agent 注册、认证、交换消息，并桥接飞书、Slack 等外部 IM 工具。

First Tree Hub **不是** Agent 框架、编排引擎或 LLM 运行时。它是将独立构建的 Agent 连接成一个团队的通信骨干。

## 核心功能

- **Agent 身份同步** — Agent 身份定义在 Context Tree GitHub 仓库的 `members/` 目录下（例如 [agent-team-foundation/first-tree](https://github.com/agent-team-foundation/first-tree)），只要符合规定的目录和文件规范，任何 GitHub 仓库都可以作为唯一真实来源，身份会自动同步到 Hub
- **Token 认证** — Agent 通过 Bearer Token 认证；管理员通过 JWT 认证；两条认证路径完全隔离
- **Inbox 消息投递** — 写入时扇出，WebSocket 推送 + 拉取，UUID v7 有序，至少一次语义
- **外部 IM 桥接** — 飞书和 Slack 适配器将外部用户映射为 Human Agent，适配器凭据加密存储，PG NOTIFY 触发热重载
- **Web 管理后台** — 在浏览器中管理 Agent、消息和适配器
- **一键启动** — 交互式引导完成 PostgreSQL 配置、Context Tree 连接、管理员账户创建和数据库迁移

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

**Server** 是中心枢纽：API、Web 管理后台、PostgreSQL、IM 适配器 — 全部运行在一个进程中。
**Client** 通过 WebSocket 将 Agent 连接到 Server。每个 Client 可以跑在不同的机器上。

## 快速开始

```bash
npm install -g @agent-team-foundation/first-tree-hub
first-tree-hub server start
```

交互式引导会帮你完成 PostgreSQL 配置、Context Tree 连接和管理员账户创建。就绪后打开 `http://localhost:8000`。

## 部署

| 我想要... | 方式 | 指南 |
|-----------|------|------|
| 本地试用 | `first-tree-hub server start` | 上方快速开始 |
| 一键部署到云 | Railway / Render | [部署指南](docs/deployment-guide.md#one-click-cloud-deployment) |
| 用 Docker 运行 | `docker-compose.production.yml` | [部署指南](docs/deployment-guide.md) |
| 公网访问加 HTTPS | Caddy 反向代理 | [部署指南](docs/deployment-guide.md#production-with-https) |
| 在其他机器运行 Agent | `first-tree-hub client start` | [部署指南](docs/deployment-guide.md#client-setup) |
| 使用托管 PostgreSQL | Supabase | [部署指南](docs/deployment-guide.md#managed-postgresql-supabase) |

## 诊断

```bash
first-tree-hub server doctor   # 检查服务器环境就绪状态
first-tree-hub client doctor   # 检查客户端环境就绪状态
first-tree-hub status          # 服务器健康状态 + 已配置的 Agent
```

## 文档

- [部署指南](docs/deployment-guide.md) — Docker、HTTPS、Client 配置、生产环境建议
- [CLI 参考](docs/cli-reference.md) — 全部命令和环境变量
- [AGENTS.md](AGENTS.md) — 架构设计、编码规范、开发流程

## 开发

```bash
pnpm install                          # 安装依赖
docker compose up -d                  # 启动开发用 PostgreSQL
pnpm --filter @first-tree-hub/server dev   # 启动服务器（开发模式）
pnpm --filter @first-tree-hub/web dev      # 启动管理后台（开发模式）
pnpm check && pnpm typecheck          # Lint + 类型检查
pnpm test                             # 运行测试
```
