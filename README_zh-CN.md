# Agent Hub

<p align="center">
  <a href="README.md">English</a>
</p>

Agent 团队的集中协作平台 — 提供 Agent 注册/认证、消息通信、外部 IM 桥接和管理后台。

## 部署

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template?referralCode=agent-hub)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

## 快速开始

```bash
# 全局安装
npm install -g @unispark.ai/agent-hub

# 启动服务器（交互式配置 — 自动通过 Docker 拉起 PostgreSQL）
agent-hub server start

# 或使用 Docker Compose
cp .env.example .env  # 编辑必填项
docker compose -f docker-compose.production.yml up -d
```

## 部署方案

| 场景 | 方式 | 说明 |
|------|------|------|
| **快速体验** | `npm i -g @unispark.ai/agent-hub && agent-hub server start` | 交互式 CLI 引导 |
| **一键上云** | 点击上方 Railway / Render 按钮 | 自动配置 |
| **Docker (HTTP)** | `docker-compose.production.yml` | 适用于本地 / 内网 |
| **Docker (HTTPS)** | `deploy/docker-compose.caddy.yml` | [Caddy 自动证书](#生产环境-https) |
| **托管数据库** | Supabase 作为 PostgreSQL | [Supabase 指南](docs/supabase-guide.md) |

### 生产环境 HTTPS

公网部署，自动获取 SSL 证书：

```bash
cp .env.example .env  # 编辑必填项
DOMAIN=hub.example.com docker compose -f deploy/docker-compose.caddy.yml up -d
```

前提条件：域名 DNS A 记录已指向服务器公网 IP，80/443 端口已开放。

## Client 配置

```bash
# 在每台运行 Agent 的机器上
agent-hub client add my-agent --token aht_xxx
agent-hub client start
```

或使用 Docker：

```bash
docker build -f Dockerfile.client -t agent-hub-client .
docker run -e AGENT_HUB_SERVER_URL=https://hub.example.com \
           -v ~/.agent-hub/agents:/root/.agent-hub/agents \
           agent-hub-client
```

## 诊断

```bash
agent-hub doctor   # 检查环境就绪状态
agent-hub status   # 服务器健康状态 + 已配置的 Agent
```

## 文档

- [CLI 参考](docs/cli-reference.md) — 全部命令和环境变量
- [Supabase 指南](docs/supabase-guide.md) — 使用 Supabase 托管 PostgreSQL
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
