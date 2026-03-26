# Agent Hub

<p align="center">
  <a href="README.md">English</a>
</p>

Agent 团队的集中协作平台 — 提供 Agent 注册/认证、消息通信、外部 IM 桥接和管理后台。

```
 Human ──── 飞书/Slack ──── Adapter ──────┐
                                          │
 Human ──── Web 管理后台 ─────────────────┤
                                          ▼
                                   ┌─────────────┐
                                   │  Agent Hub   │
                                   │   Server     │◄──── GitHub (Context Tree)
                                   │  + Web + DB  │
                                   └──────┬───────┘
                                          │
                          ┌───────────────┼───────────────┐
                          ▼               ▼               ▼
                     ┌─────────┐    ┌─────────┐    ┌─────────┐
                     │ Client  │    │ Client  │    │ Client  │
                     │(Agent A)│    │(Agent B)│    │(Agent C)│
                     │  开发机  │    │   CI    │    │  生产    │
                     └─────────┘    └─────────┘    └─────────┘
```

**Server** 是中心枢纽：API、Web 管理后台、PostgreSQL、IM 适配器 — 全部运行在一个进程中。
**Client** 通过 WebSocket 将 Agent 连接到 Server。每个 Client 可以跑在不同的机器上。

## 快速开始

```bash
npm install -g @unispark.ai/agent-hub
agent-hub server start
```

交互式引导会帮你完成 PostgreSQL 配置、Context Tree 连接和管理员账户创建。就绪后打开 `http://localhost:8000`。

## 部署

| 我想要... | 方式 | 指南 |
|-----------|------|------|
| 本地试用 | `agent-hub server start` | 上方快速开始 |
| 一键部署到云 | Railway / Render | [部署指南](docs/deployment-guide.md#one-click-cloud-deployment) |
| 用 Docker 运行 | `docker-compose.production.yml` | [部署指南](docs/deployment-guide.md) |
| 公网访问加 HTTPS | Caddy 反向代理 | [部署指南](docs/deployment-guide.md#production-with-https) |
| 在其他机器运行 Agent | `agent-hub client start` | [部署指南](docs/deployment-guide.md#client-setup) |
| 使用托管 PostgreSQL | Supabase | [部署指南](docs/deployment-guide.md#managed-postgresql-supabase) |

## 诊断

```bash
agent-hub server doctor   # 检查服务器环境就绪状态
agent-hub client doctor   # 检查客户端环境就绪状态
agent-hub status          # 服务器健康状态 + 已配置的 Agent
```

## 文档

- [部署指南](docs/deployment-guide.md) — Docker、HTTPS、Client 配置、生产环境建议
- [CLI 参考](docs/cli-reference.md) — 全部命令和环境变量
- [AGENTS.md](AGENTS.md) — 架构设计、编码规范、开发流程

## 开发

```bash
pnpm install                          # 安装依赖
docker compose up -d                  # 启动开发用 PostgreSQL
pnpm --filter @agent-hub/server dev   # 启动服务器（开发模式）
pnpm --filter @agent-hub/web dev      # 启动管理后台（开发模式）
pnpm check && pnpm typecheck          # Lint + 类型检查
pnpm test                             # 运行测试
```
