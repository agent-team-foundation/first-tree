---
title: "Agent Hub 部署与配置设计"
status: draft
owners: [baixiaohang]
soft_links:
  - proposals/agent-hub-overview.20260320.md
  - proposals/agent-hub-web-design.20260323.md
  - proposals/agent-hub-server-detailed-design.20260320.md
---

# Agent Hub 部署与配置设计

本文档定义 Agent Hub 的部署架构、统一 CLI 设计、配置系统和端到端用户体验。

---

## 1. 设计目标

| 目标 | 说明 |
|------|------|
| **一条命令启动** | `npx agent-hub server start` — 1 分钟内从零到可用，无需配置文件，无需交互 |
| **单一产物** | Server + Web + Client 打包为一个 npm 包（`@agent-team-foundation/agent-hub`），通过子命令区分 |
| **仅依赖 PostgreSQL** | 用户提供 PG URL **或** CLI 通过 Docker 自动拉起 |
| **默认安全** | 无默认密码，凭证自动生成，密钥不入数据库 |
| **配置一次，处处使用** | 统一配置抽象 — 业务代码只调 `getConfig()`，不直接读 env / 文件 |
| **本地优先** | 无需联网即可完整使用；公网访问是用户的基础设施选择 |

---

## 2. 架构概览

### 2.1 没有"层级"概念

Agent Hub 只有**一种启动 server 的方式**和**一种启动 client 的方式**：

```bash
agent-hub server start                 # 启动 server（始终是原生 Node.js 进程）
agent-hub client start                 # 启动 client（一个进程，管理本机所有 agent）
```

其余一切 — 公网访问、进程守护、Docker — 都是**应用外部的基础设施**，不是应用的不同模式。

```
Agent Hub 管的事情：                     用户管的事情（基础设施）：
─────────────────────────              ──────────────────────────────────────
Server 进程（Node.js）                  反向代理（Caddy / Nginx）
PostgreSQL 供给                         TLS 证书（Let's Encrypt）
数据库迁移                              隧道（Cloudflare Tunnel）
Agent 运行时                            进程守护（systemd / Docker）
配置管理                                防火墙、DNS
```

### 2.2 部署场景

所有场景使用同样的 `server start` / `client start` 命令，区别在于基础设施：

| 场景 | PostgreSQL | 公网访问 | 进程管理 | 耗时 |
|------|-----------|---------|---------|------|
| **本地 / 评估** | 自动拉起（Docker） | 无（localhost） | 前台运行 | 1 分钟 |
| **单台 VPS** | 自动拉起或托管 | Caddy 自动 HTTPS | systemd | 15 分钟 |
| **家庭服务器** | 自动拉起 | Cloudflare Tunnel | systemd | 15 分钟 |
| **云平台** | 托管（Neon 等） | 平台提供 | 平台管理 | 10 分钟 |

`agent-hub server deploy-template` 可生成 Docker Compose / Caddy / systemd 模板作为便利工具，但**不是必需的**。

### 2.3 包架构

```
@agent-team-foundation/agent-hub (~50 MB)
├── SDK（编程接口）           import { AgentHubClient } from '@agent-team-foundation/agent-hub'
├── CLI（命令行）             npx agent-hub <command>
├── 内嵌 Server 代码          Fastify 应用（通过 `server start` 在进程内运行）
├── 内嵌 Web 静态文件          React 构建产物（由 server 提供服务）
└── 部署模板                   docker-compose.yml、Caddyfile、systemd unit 模板
```

Server 始终以原生 Node.js 进程运行（npm 包中内嵌的 Fastify 应用）。Server 本身不需要 Docker 镜像。

---

## 3. 统一 CLI 设计

### 3.1 命令结构

```
agent-hub
│
├── server
│   ├── start [--port] [--database-url]   # 启动 server（进程内 Node.js）
│   ├── stop                               # 停止 server + 托管的 PG 容器
│   ├── status                             # Server 健康状态 + 已连接 agent
│   ├── configure                          # 交互式配置 server
│   └── deploy-template                    # 生成 Docker/Caddy/systemd 模板
│
├── client
│   ├── start [--config-dir]               # 启动 client（一个进程，管所有 agent）
│   ├── stop                               # 停止 client
│   ├── status                             # 所有 agent 实例状态
│   ├── configure                          # 交互式配置 client
│   ├── add [name] [--token]               # 添加 agent（交互式或命令式）
│   ├── remove <name>                      # 移除 agent
│   └── list                               # 列出已配置的 agent
│
├── config
│   ├── set [-s|-c|-a <name>] <key> <val>  # 设置配置值
│   ├── get [-s|-c|-a <name>] <key>        # 读取配置值
│   └── list [-s|-c|-a <name>]             # 列出所有配置 + 来源标注
│
├── db
│   ├── migrate                            # 运行数据库迁移
│   └── backup [--output]                  # pg_dump 备份
│
├── admin
│   └── create                             # 创建管理员账户（交互式）
│
└── status                                 # 全局概览
```

两个核心动词：**`server start`** 和 **`client start`**。其余都是辅助。

### 3.2 `agent-hub server start`

一条命令从零到可用：

```
$ npx agent-hub server start

  Agent Hub v0.1.0

  PostgreSQL ............. 未找到
  → 通过 Docker 启动 PostgreSQL...
  → 容器 agent-hub-postgres 已启动（端口 5432）
  ✓ PostgreSQL 就绪

  数据库 ................. 空
  → 运行迁移...
  ✓ 数据库已初始化（14 张表）

  管理员 ................. 未找到
  → 创建默认管理员...
  ✓ 管理员已创建
    用户名: admin
    密码: xK9mP2vL8nQ4  （请保存 — 仅显示一次）

  Server ................. 启动中
  ✓ Server 运行在 http://localhost:8000

  在浏览器中打开 http://localhost:8000 开始使用。
  按 Ctrl+C 停止。
```

**内部流程：**

```
1. 加载配置（见 §4 配置系统）
   CLI 参数 > 环境变量 > ~/.agent-hub/server.yaml > 自动生成 > 默认值

2. 解析 PostgreSQL（见 §5）
   --database-url 或 DATABASE_URL → 直接使用
   都没有 → 自动通过 Docker 拉起

3. 运行数据库迁移（Drizzle）

4. 检查管理员账户
   已存在 → 跳过
   不存在 → 自动生成密码创建，打印一次

5. 启动 Fastify server（进程内）
   /api/v1/* → API 路由
   /*        → Web SPA（内嵌静态文件）

6. 收到 Ctrl+C（SIGINT）时：
   优雅关闭 Fastify
   PG 容器保持运行（用 `server stop` 停止）
```

**参数：**

```
agent-hub server start
  --port <number>          Server 端口（默认: 8000，被占用时自动递增）
  --database-url <url>     使用已有 PostgreSQL（跳过 Docker 拉起）
  --host <address>         绑定地址（默认: 127.0.0.1）
  --no-open                不自动打开浏览器
```

### 3.3 `agent-hub client start`

一个进程管理本机所有 agent：

```
$ agent-hub client start

  连接到 http://localhost:8000...
  ✓ code-reviewer: 已连接（inbox: polling + websocket）
  ✓ scheduler: 已连接（inbox: polling + websocket）

  2 个 agent 运行中。按 Ctrl+C 停止。
```

Client 进程：
1. 读取 `~/.agent-hub/client.yaml` 获取 server URL
2. 扫描 `~/.agent-hub/agents/*/agent.yaml` 获取 agent 配置
3. 为每个 agent 建立连接
4. 将 inbox 消息路由到 agent session

### 3.4 `agent-hub server configure` / `client configure`

交互式向导，用于首次配置。底层写入的是与 `config set` 相同的 YAML 文件：

```
$ agent-hub server configure

  ? PostgreSQL:
    ❯ 通过 Docker 自动拉起
      提供连接 URL

  ? 连接 URL: postgres://user:pass@host:5432/db

  ✓ 已保存到 ~/.agent-hub/server.yaml

  # 等价于：
  # agent-hub config set -s database.provider external
  # agent-hub config set -s database.url postgres://user:pass@host:5432/db
```

```
$ agent-hub client add

  ? Agent 名称: code-reviewer
  ? Token: aht_xxxxx

  ✓ 已创建 ~/.agent-hub/agents/code-reviewer/agent.yaml

  # 等价于：
  # agent-hub client add code-reviewer --token aht_xxxxx
```

### 3.5 `agent-hub config set/get/list`

命令式配置操作 — 可脚本化，CI/CD 友好：

```bash
# 设置值（写入 YAML 文件）
agent-hub config set -s database.url postgres://...      # -s = server.yaml
agent-hub config set -s server.port 9000
agent-hub config set -s contextTree.repo org/first-tree
agent-hub config set -c server.url https://hub.example.com  # -c = client.yaml
agent-hub config set -a code-reviewer token aht_xxx      # -a = agent.yaml

# 读取值
agent-hub config get -s database.url
# → postgres://... (来源: server.yaml)

# 列出所有配置 + 来源标注（调试友好）
agent-hub config list -s
#   database.url          postgres://...@localhost:5432   (自动生成)
#   database.provider     docker                          (默认值)
#   server.port           9000                            (环境变量: PORT)
#   secrets.jwtSecret     ***                             (server.yaml)
#   contextTree.repo      org/first-tree                  (server.yaml)
#   github.token          ***                             (环境变量: GITHUB_TOKEN)

# 显示明文密钥（需显式 opt-in）
agent-hub config list -s --show-secrets
```

**Scope 标志：**

| 标志 | 范围 | 文件 |
|------|------|------|
| `-s` / `--server` | Server 配置 | `~/.agent-hub/server.yaml` |
| `-c` / `--client` | Client 配置 | `~/.agent-hub/client.yaml` |
| `-a <name>` / `--agent <name>` | Agent 配置 | `~/.agent-hub/agents/<name>/agent.yaml` |

### 3.6 `agent-hub server deploy-template`

生成基础设施模板 — 不封装 `docker compose`：

```
$ agent-hub server deploy-template

  ? 需要哪些模板？
    ✓ Docker Compose（server + PostgreSQL）
    ✓ Caddyfile（自动 HTTPS 反向代理）
      Cloudflare Tunnel（Docker 服务）
    ✓ systemd unit（进程管理）
      .env 文件（用于 Docker Compose）

  ? Caddy 域名: hub.example.com

  ✓ 已生成 docker-compose.yml
  ✓ 已生成 Caddyfile
  ✓ 已生成 agent-hub-server.service

  这些是起点模板 — 请根据需要审查和调整。
```

这些模板引用同一个 `~/.agent-hub/` 配置。它们是脚手架，不是托管部署。

---

## 4. 配置系统

### 4.1 配置目录结构

```
~/.agent-hub/                          # 统一根目录（权限: 0700）
├── server.yaml                        # Server 配置（本机跑 server 时存在）
├── client.yaml                        # Client 配置（本机跑 client 时存在）
├── agents/                            # Agent 实例配置（client 管理）
│   ├── code-reviewer/
│   │   └── agent.yaml
│   ├── scheduler/
│   │   └── agent.yaml
│   └── monitor/
│       └── agent.yaml
└── data/                              # 运行时数据
    └── postgres/                      # 托管 PG 容器数据（仅 server）
```

Server 和 Client 共用同一根目录，同一台机器上自然共存。

**不同角色的机器目录示例：**

```
机器 A（本地全套）：               机器 B（仅 server）：          机器 C（仅 client）：
~/.agent-hub/                     ~/.agent-hub/               ~/.agent-hub/
├── server.yaml     ✓             ├── server.yaml   ✓         ├── client.yaml    ✓
├── client.yaml     ✓             └── data/postgres/ ✓        └── agents/
├── agents/         ✓                                             ├── monitor/
│   ├── code-reviewer/                                            └── deployer/
│   └── scheduler/
└── data/postgres/  ✓
```

### 4.2 配置解析：四个来源，一条优先级链

```
优先级（高 → 低）：

  ① CLI 参数            --port 9000, --database-url postgres://...
        ↓
  ② 环境变量            DATABASE_URL, JWT_SECRET, PORT
        ↓
  ③ 配置文件            ~/.agent-hub/server.yaml
        ↓
  ④ 自动生成            首次运行时：密钥、PG 密码
        ↓
  ⑤ 内置默认值          port: 8000, host: '127.0.0.1'
```

每个字段独立走这条链，取到第一个非空值就停。

**四种方式写入配置，一种方式读取：**

```
                    ┌──────────────────────────┐
  交互式向导        │                          │
  (configure)  ────>│                          │
                    │    Config Store           │
  CLI 命令         │    （读写 YAML 文件）      │
  (config set) ────>│                          │
                    │                          │
  直接编辑文件 ────>│    ~/.agent-hub/*.yaml   │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │    Config Resolver        │
                    │                          │
                    │  CLI 参数 > 环境变量 > 文件│
                    │  > 自动生成 > 默认值      │
                    │                          │
                    │  → Zod 校验               │
                    │  → Object.freeze()       │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │    getConfig()            │
                    │    （类型安全的单例）       │
                    │                          │
                    │  server/client 业务代码   │
                    │  只用这个，不碰其他来源    │
                    └──────────────────────────┘
```

### 4.3 配置 Schema 定义

Schema 使用 Zod + 字段元数据（环境变量映射、自动生成策略）：

```typescript
// shared/src/config/server-config.ts

export const serverConfigSchema = defineConfig({
  database: {
    url:      field(z.string(), { env: 'DATABASE_URL', auto: 'docker-pg' }),
    provider: field(z.enum(['docker', 'external']).default('docker')),
  },
  server: {
    port: field(z.number().default(8000), { env: 'PORT' }),
    host: field(z.string().default('127.0.0.1'), { env: 'HOST' }),
  },
  secrets: {
    jwtSecret:     field(z.string(), { env: 'JWT_SECRET', auto: 'random:base64url:32', secret: true }),
    encryptionKey: field(z.string(), { env: 'ENCRYPTION_KEY', auto: 'random:hex:32', secret: true }),
  },
  contextTree: optional({
    repo:         field(z.string(), { env: 'CONTEXT_TREE_REPO' }),
    branch:       field(z.string().default('main')),
    syncInterval: field(z.number().default(60)),
  }),
  github: optional({
    token: field(z.string(), { env: 'GITHUB_TOKEN', secret: true }),
  }),
});
```

```typescript
// shared/src/config/client-config.ts

export const clientConfigSchema = defineConfig({
  server: {
    url: field(z.string(), { env: 'AGENT_HUB_SERVER_URL' }),
  },
  logLevel: field(z.enum(['debug', 'info', 'warn', 'error']).default('info'), { env: 'LOG_LEVEL' }),
});
```

```typescript
// shared/src/config/agent-config.ts

export const agentConfigSchema = defineConfig({
  token: field(z.string(), { secret: true }),
  // 未来扩展: tools, skills, model 等
});
```

### 4.4 `field()` 类型定义

```typescript
type FieldOptions = {
  env?: string;       // 对应的环境变量名
  auto?: string;      // 自动生成策略（值缺失时触发）
  secret?: boolean;   // 在 `config list` 输出中掩码显示（默认: false）
};

function field<T extends z.ZodType>(schema: T, options?: FieldOptions): FieldDef<z.infer<T>>;
```

`field()` 是纯声明式的 — 只在 Zod schema 上附加元数据。所有解析逻辑在 `initConfig` 中统一处理。

### 4.5 配置初始化（CLI 入口调用）

```typescript
// 启动时调用一次，位于 CLI 入口

// Server 启动时：
const config = await initConfig({
  schema: serverConfigSchema,
  role: 'server',                  // → 读取 ~/.agent-hub/server.yaml
  configDir: '~/.agent-hub',
  cliArgs: { port: 9000 },        // 来自 commander.js
});

// Client 启动时：
const config = await initConfig({
  schema: clientConfigSchema,
  role: 'client',                  // → 读取 ~/.agent-hub/client.yaml
  configDir: '~/.agent-hub',
  cliArgs: {},
});
```

**`initConfig` 内部流程：**

```
initConfig({ schema, role, configDir, cliArgs })
  │
  ├── 1. 确定文件路径: {configDir}/{role}.yaml
  │
  ├── 2. 读取 YAML 文件（不存在则 {}）
  │
  ├── 3. 读取环境变量（按 schema 的 env 映射）
  │
  ├── 4. 合并: CLI 参数 > 环境变量 > 文件 > 默认值
  │
  ├── 5. 自动生成缺失字段
  │      遍历带 `auto` 元数据的字段:
  │      ├── 'random:base64url:32' → crypto.randomBytes(32).toString('base64url')
  │      ├── 'random:hex:32'       → crypto.randomBytes(32).toString('hex')
  │      └── 'docker-pg'           → 生成 PG URL + 容器名 + 密码
  │
  ├── 6. Zod 校验
  │      通过 → 继续
  │      失败 → 抛出可读错误，列出缺少的必填字段
  │
  ├── 7. 将自动生成的值回写到 YAML 文件
  │      （下次启动时复用，不重新生成）
  │      设置文件权限 0600（含密钥）
  │
  └── 8. 冻结 + 存为单例
         Object.freeze(config)
         后续 getConfig() 返回此实例
```

### 4.6 业务代码使用配置

```typescript
// server 或 client 代码中任意位置：
import { getConfig } from '@agent-hub/shared/config';

const config = getConfig();
config.database.url          // string — 保证存在，已校验
config.secrets.jwtSecret     // string — 可能是自动生成的
config.server.port           // number — 有默认值
config.contextTree?.repo     // string | undefined — 可选区块
```

**业务代码绝不：**
- 直接读 `process.env`
- 读取文件
- 解析 YAML
- 检查值是否缺失

### 4.7 Agent 配置加载

Agent 配置是多实例的（N 个 agent 目录），单独加载：

```typescript
// Client 启动时扫描 agents 目录：
const agents = await loadAgents({
  schema: agentConfigSchema,
  agentsDir: '~/.agent-hub/agents',
});

// 返回: Map<string, AgentConfig>
// key = 目录名（agent 名称）
// value = 解析后的 agent.yaml
```

### 4.8 配置文件格式

**`~/.agent-hub/server.yaml`**（首次 `server start` 时自动生成）：

```yaml
# 由 agent-hub 自动生成，可按需编辑。
# 文档: https://github.com/agent-team-foundation/agent-hub

database:
  provider: docker
  url: postgresql://agenthub:xK9mP2vL8n@127.0.0.1:5432/agenthub

server:
  port: 8000
  host: 127.0.0.1

secrets:
  jwtSecret: auto-generated-base64url
  encryptionKey: auto-generated-hex

# 可选: Context Tree 同步
# contextTree:
#   repo: org/first-tree
#   branch: main
#   syncInterval: 60

# GitHub token（也可通过 GITHUB_TOKEN 环境变量设置）
# github:
#   token: ghp_xxxx
```

**`~/.agent-hub/client.yaml`**：

```yaml
server:
  url: http://localhost:8000

logLevel: info
```

**`~/.agent-hub/agents/code-reviewer/agent.yaml`**：

```yaml
token: aht_xxxxxxxxxxxxxxxxxxxxx
```

### 4.9 配置模块在 Monorepo 中的位置

```
packages/shared/src/config/
├── index.ts              # 公共 API: defineConfig, field, initConfig, getConfig, loadAgents
├── schema.ts             # defineConfig(), field() — 纯声明
├── resolver.ts           # initConfig() — 合并 + 校验 + 自动生成 + 回写
├── singleton.ts          # getConfig() — 单例存取
├── server-config.ts      # serverConfigSchema
├── client-config.ts      # clientConfigSchema
└── agent-config.ts       # agentConfigSchema
```

放在 `shared` 中，因为：
- Schema 定义本身就是 shared 的职责
- Server 和 Client 都需要 `initConfig` + `getConfig`
- 不引入额外依赖（仅 Zod + Node.js fs/crypto）

---

## 5. PostgreSQL 供给

### 5.1 两条路径

```
                    ┌─────────────────────────────────┐
                    │   PostgreSQL 从哪来？             │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
             用户提供 URL                    CLI 自动拉起
          (--database-url 参数              （默认行为）
           或 DATABASE_URL 环境变量               │
           或 config set)                   docker run postgres:16-alpine
                    │                       （独立容器）
                    ▼                             │
             直接使用。                           ▼
             不创建容器。                    由 CLI 管理。
```

### 5.2 路径 A：用户提供

```bash
# 通过 CLI 参数
agent-hub server start --database-url postgresql://user:pass@host:5432/db

# 通过环境变量
DATABASE_URL=postgresql://... agent-hub server start

# 通过配置命令
agent-hub config set -s database.url postgresql://user:pass@host:5432/db
agent-hub config set -s database.provider external
agent-hub server start
```

CLI 在启动前验证连接。备份和可用性由用户负责。

**推荐的托管 PG 服务：**

| 服务 | 免费层 | 说明 |
|------|--------|------|
| **Neon** | 0.5 GB, 100 CU-hr/月 | Serverless PG，scale-to-zero |
| **Supabase** | 500 MB, 2 个项目 | 全套 BaaS，PG URL 可单独使用 |
| **任何 PostgreSQL 15+** | N/A | 自行管理 |

### 5.3 路径 B：CLI 通过 Docker 自动拉起（默认）

未提供 DATABASE_URL 时，CLI 管理一个独立的 Docker 容器：

```bash
# CLI 内部执行：
docker run -d \
  --name agent-hub-postgres \
  -e POSTGRES_DB=agenthub \
  -e POSTGRES_USER=agenthub \
  -e POSTGRES_PASSWORD=<自动生成> \
  -p 127.0.0.1:5432:5432 \
  -v agent-hub-pgdata:/var/lib/postgresql/data \
  --health-cmd "pg_isready -U agenthub" \
  --restart unless-stopped \
  postgres:16-alpine
```

| 行为 | 详情 |
|------|------|
| **容器名** | `agent-hub-postgres`（固定，单例） |
| **端口** | `127.0.0.1:5432`（5432 被占用时自动检测下一个空闲端口） |
| **数据卷** | Docker named volume `agent-hub-pgdata`（跨重启持久化） |
| **密码** | 自动生成，存储在 `server.yaml` 中 |
| **生命周期** | Server 的 `Ctrl+C` 不会停止容器。仅 `agent-hub server stop` 会停止。 |
| **复用** | 容器已存在且运行中 → 复用。已停止 → 重启。 |

### 5.4 Docker 前置条件处理

```
agent-hub server start（无 DATABASE_URL，无 Docker）
  │
  ▼
  ✗ Docker 不可用。

  Agent Hub 需要 PostgreSQL。有两种方式：

  1. 安装 Docker → https://docs.docker.com/get-docker/
     然后重新运行: agent-hub server start

  2. 提供已有的 PostgreSQL URL:
     agent-hub server start --database-url postgresql://user:pass@host:5432/db
```

### 5.5 安全性

- **端口仅绑定 `127.0.0.1`** — PG 不暴露到网络
- **自动生成密码** — `crypto.randomBytes(24).toString('base64url')`
- **凭证存储在 server.yaml** — 文件权限 0600

### 5.6 备份

```bash
$ agent-hub db backup
  ✓ 备份已保存到 ./backups/agenthub-20260324-143000.sql.gz (2.1 MB)
```

Docker 托管的 PG：在容器内执行 `pg_dump`。用户提供的 PG：直接连接。

### 5.7 未来考虑：嵌入式 PostgreSQL（PGlite）

当前不适用。Agent Hub 依赖 LISTEN/NOTIFY 和 FOR UPDATE SKIP LOCKED，PGlite 不支持这两个特性。待 PGlite 支持这些功能，或 Agent Hub 提供进程内降级方案时重新评估。

---

## 6. Client 架构

### 6.1 一个进程，多个 Agent

一台机器运行**一个 client 进程**，管理**所有本地 agent 实例**：

```
agent-hub client start
  │
  ├── 读取 ~/.agent-hub/client.yaml       → server URL, 日志级别
  ├── 扫描 ~/.agent-hub/agents/*/agent.yaml → agent 配置
  │
  ├── 对每个 agent:
  │   ├── 用 Agent Token 向 server 认证
  │   ├── 建立 WebSocket 接收 inbox 通知
  │   ├── 启动 inbox 轮询（兜底）
  │   └── 将消息路由到 agent session
  │
  └── 作为一个进程管理所有 agent 生命周期
```

### 6.2 Agent 管理

```bash
# 交互式
agent-hub client add
  → 提示输入 name 和 token

# 命令式
agent-hub client add code-reviewer --token aht_xxxxx
  → 创建 ~/.agent-hub/agents/code-reviewer/agent.yaml

# 移除
agent-hub client remove code-reviewer
  → 删除 ~/.agent-hub/agents/code-reviewer/

# 列出
agent-hub client list
  → code-reviewer  (token: aht_***xx)
    scheduler      (token: aht_***yy)
```

### 6.3 Agent 增删需要重启（P0）

P0 阶段，修改 `agents/` 目录后需要重启 client 进程。热加载（watch 目录变化）放到 P2。

### 6.4 守护进程运行方式

| 方式 | 适用场景 | 配置 |
|------|---------|------|
| **前台运行** | 开发 / 评估 | `agent-hub client start` |
| **systemd** | Linux 生产 | `agent-hub server deploy-template` 生成 unit 文件 |
| **Docker** | Docker 化基础设施 | Dockerfile / Compose（将配置目录挂载为 volume） |

systemd unit 模板（由 `deploy-template` 生成）：

```ini
[Unit]
Description=Agent Hub Client
After=network.target

[Service]
ExecStart=/usr/bin/agent-hub client start
Restart=always
User=agent-hub
Environment=HOME=/home/agent-hub

[Install]
WantedBy=multi-user.target
```

---

## 7. Context Tree 同步

### 7.1 方案：GitHub GraphQL API

单次请求获取所有 member 的 NODE.md 内容，不受 member 数量影响：

```graphql
query($owner: String!, $name: String!, $expr: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expr) {
      ... on Tree {
        entries {
          name
          type
          object {
            ... on Tree {
              entries {
                name
                object { ... on Blob { text } }
              }
            }
          }
        }
      }
    }
  }
}
```

### 7.2 为什么选 GraphQL

| 方案 | API 调用数 | Docker 友好 | 扩展性 |
|------|-----------|------------|--------|
| **GraphQL** | **1** | **是（仅 fetch）** | **优秀** |
| REST Contents | N+1（50 member = 51 次） | 是 | 受 rate limit 限制 |
| gh CLI | N+1 | 否（需安装 gh） | 受限 |
| Tarball | 1 | 是 | 差（下载整个仓库） |

### 7.3 配置

```yaml
# server.yaml 中：
contextTree:
  repo: org/first-tree          # GitHub owner/repo
  branch: main
  syncInterval: 60              # 秒

# GitHub token 通过环境变量（推荐）或配置设置：
# GITHUB_TOKEN=ghp_xxx agent-hub server start
```

### 7.4 行为

| 方面 | 设计 |
|------|------|
| **HTTP client** | 原生 `fetch`，不引入 `@octokit/rest` |
| **认证** | `Authorization: Bearer ${GITHUB_TOKEN}` |
| **调度** | `setInterval` + 启动时同步 |
| **幂等** | 以 `members/{name}` 为 key upsert `agents` 表 |
| **Token 未配置** | Context Tree 同步静默跳过，server 正常启动 |
| **错误处理** | 记录错误 + 停止同步，不崩溃 |

---

## 8. Docker 镜像

为偏好容器化部署的用户发布官方 Docker 镜像：

```
ghcr.io/agent-team-foundation/agent-hub:latest
```

```dockerfile
FROM node:22-slim AS base
RUN corepack enable pnpm

FROM base AS build
WORKDIR /build
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-slim AS production
RUN addgroup --system app && adduser --system --ingroup app app
WORKDIR /app
COPY --from=build /build/packages/server/dist ./dist
COPY --from=build /build/packages/web/dist ./web-dist
COPY --from=build /build/packages/server/node_modules ./node_modules
COPY --from=build /build/packages/server/package.json ./

ENV NODE_ENV=production
ENV WEB_DIST_PATH=/app/web-dist
USER app
EXPOSE 8000
CMD ["node", "dist/index.js"]
```

此镜像运行的 server 代码与 `agent-hub server start` 相同，只是在容器内运行。配置通过环境变量注入。

---

## 9. 部署模板

`agent-hub server deploy-template` 生成以下模板作为起点。CLI **不管理**这些模板 — 用户自行维护和定制。

### 9.1 Docker Compose（Server + PostgreSQL）

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    ports:
      - "127.0.0.1:5432:5432"
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-agenthub}
      POSTGRES_USER: ${POSTGRES_USER:-agenthub}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-agenthub}"]
      interval: 10s
      timeout: 3s
      retries: 5
    networks: [internal]

  server:
    image: ghcr.io/agent-team-foundation/agent-hub:${VERSION:-latest}
    restart: unless-stopped
    ports:
      - "127.0.0.1:8000:8000"
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-agenthub}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-agenthub}
      JWT_SECRET: ${JWT_SECRET}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
    depends_on:
      postgres:
        condition: service_healthy
    networks: [internal, external]
    security_opt:
      - no-new-privileges:true

networks:
  internal:
    internal: true
  external:
```

### 9.2 Caddyfile（自动 HTTPS 反向代理）

```
{$DOMAIN} {
    reverse_proxy server:8000
}
```

在 docker-compose.yml 中添加 Caddy 服务：

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./data/caddy:/data
    depends_on: [server]
    networks: [external]
```

### 9.3 Cloudflare Tunnel

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on: [server]
    networks: [external]
```

### 9.4 systemd Unit

```ini
[Unit]
Description=Agent Hub Server
After=network.target docker.service

[Service]
Type=simple
ExecStart=/usr/bin/agent-hub server start
Restart=always
RestartSec=5
User=agent-hub
Environment=HOME=/home/agent-hub

[Install]
WantedBy=multi-user.target
```

---

## 10. 安全

### 10.1 密钥管理

| 密钥 | 生成方式 | 存储位置 | 入库？ |
|------|---------|---------|--------|
| `POSTGRES_PASSWORD` | `crypto.randomBytes(24).toString('base64url')` | server.yaml | 否 |
| `JWT_SECRET` | `crypto.randomBytes(32).toString('base64url')` | server.yaml | 否 |
| `ENCRYPTION_KEY` | `crypto.randomBytes(32).toString('hex')` | server.yaml | 否 |
| `GITHUB_TOKEN` | 用户提供 | 环境变量或 server.yaml | 否 |
| 管理员密码 | 用户提供或自动生成 | DB 中 bcrypt hash | 仅 hash |
| Agent token | 通过 Admin API 生成 | DB 中 bcrypt hash | 仅 hash |
| Adapter 凭证 | 用户通过 Web 后台提供 | DB 中加密 JSONB | 加密存储 |

**原则：基础设施密钥不入数据库。** 只有应用层凭证（hash/加密后）存储在 PG 中。

### 10.2 应用安全

继承自 Server 详细设计：

- **双轨认证** — Agent Token 和 Admin JWT 完全隔离
- **无默认凭证** — 管理员密码自动生成或用户提供，绝不硬编码
- **localhost 也必须认证** — 不基于网络位置信任
- **输入校验** — 所有端点使用 Zod schema 校验
- **频率限制** — 认证端点使用 `@fastify/rate-limit`
- **安全头** — `@fastify/helmet`
- **配置文件权限** — server.yaml 设为 0600（含密钥）

### 10.3 Docker 安全（使用模板时）

```yaml
services:
  server:
    security_opt: [no-new-privileges:true]
    read_only: true
    tmpfs: [/tmp]
    user: "1000:1000"

  postgres:
    networks: [internal]               # 不在外部网络上
    ports: ["127.0.0.1:5432:5432"]     # 绝不 0.0.0.0
```

---

## 11. 构建与发布

### 11.1 npm 包

```
pnpm build
  → shared:build     （Zod schemas + 类型 + 配置模块）
  → web:build         （React → dist/ 静态文件）
  → server:build      （Fastify → dist/ bundle）
  → client:build      （SDK + CLI → dist/）
    └── 将 server dist + web dist 打入 client 包
```

```json
{
  "name": "@agent-team-foundation/agent-hub",
  "files": ["dist", "templates"]
}
```

### 11.2 Docker 镜像

GitHub Actions 在 tag push 时构建：

```yaml
on:
  push:
    tags: ["v*"]

jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: |
            ghcr.io/agent-team-foundation/agent-hub:${{ github.ref_name }}
            ghcr.io/agent-team-foundation/agent-hub:latest
```

### 11.3 发布产物

1. **npm 包** — `@agent-team-foundation/agent-hub@x.y.z`
2. **Docker 镜像** — `ghcr.io/agent-team-foundation/agent-hub:x.y.z`
3. **GitHub Release** — changelog + 迁移说明

---

## 12. 升级

```bash
# 更新 CLI
npm install -g @agent-team-foundation/agent-hub@latest

# 运行迁移
agent-hub db migrate

# 重启
agent-hub server start   # 或通过 systemd 重启
```

Server 无状态 — 重启耗时约 2-5 秒。Client 通过 WebSocket 重连 + 轮询兜底自动恢复。

---

## 13. 端到端用户旅程

### 13.1 本地评估（1 分钟）

```bash
npx agent-hub server start
  ✓ PostgreSQL 就绪
  ✓ 数据库已初始化
  ✓ 管理员已创建 (admin / xK9mP2vL8nQ4)
  ✓ Server 运行在 http://localhost:8000

# 在浏览器中：登录 → 创建 agent → 生成 token

# 在另一个终端：
agent-hub client add code-reviewer --token aht_xxx
agent-hub client start
```

### 13.2 VPS + Caddy 部署（15 分钟）

```bash
# 在 VPS 上（域名 DNS 已指向此处）：
npm install -g @agent-team-foundation/agent-hub

# 配置
agent-hub server configure           # 或: config set -s ...
agent-hub server start               # 先启动一次测试
agent-hub admin create

# 生成生产模板
agent-hub server deploy-template     # → docker-compose.yml + Caddyfile + systemd unit

# 审查、调整、部署
sudo cp agent-hub-server.service /etc/systemd/system/
sudo systemctl enable --now agent-hub-server

# 在 agent 机器上：
npm install -g @agent-team-foundation/agent-hub
agent-hub config set -c server.url https://hub.example.com
agent-hub client add code-reviewer --token aht_xxx
agent-hub client start
```

### 13.3 使用已有 PostgreSQL（2 分钟）

```bash
npx agent-hub server start --database-url postgresql://user:pass@db.example.com:5432/agenthub
```

---

## 14. 监控

### 14.1 健康检查

```
GET /api/v1/health → { status, version, database, uptime_seconds }
```

### 14.2 `agent-hub status`

```
$ agent-hub status

  Server:     ✓ 运行中 (v0.1.0, 运行时间: 1d 2h)
  Database:   ✓ 已连接 (PostgreSQL 16.2, 42 MB)
  Agents:     3 个已注册, 2 个在线
  Adapters:   1 个活跃 (feishu)
```

---

## 15. 实现路线图

| 阶段 | 范围 | 优先级 |
|------|------|--------|
| **P0** | 配置系统: `defineConfig`, `field`, `initConfig`, `getConfig` | 必须 |
| **P0** | `server start`（自动 PG 拉起 + `--database-url`） | 必须 |
| **P0** | `server stop` + `status` | 必须 |
| **P0** | `db migrate` + `admin create` | 必须 |
| **P0** | `config set/get/list`（`-s/-c/-a` scope） | 必须 |
| **P1** | `client start/stop/status` + `client add/remove/list` | v0.2 |
| **P1** | `server configure` + `client configure`（交互式） | v0.2 |
| **P1** | Context Tree 同步（GraphQL） | v0.2 |
| **P2** | `server deploy-template`（Docker Compose / Caddy / systemd） | v0.3 |
| **P2** | Docker 镜像构建 + 发布流水线 | v0.3 |
| **P2** | `db backup` | v0.3 |
| **P2** | Client 热加载 agents/ 目录变化 | v0.3 |
| **P3** | PGlite 嵌入式模式（重新评估可行性） | v0.4+ |

---

## 16. 待定问题

| 问题 | 选项 | 建议 |
|------|------|------|
| npm 包大小（约 50 MB） | 内嵌 server+web vs 仅 Docker | **内嵌。** 与 `next`（50 MB）相当。使 `server start` 无需拉取 Docker 镜像。 |
| 配置文件格式 | YAML vs TOML vs JSON | **YAML。** 广泛使用，支持注释，适合嵌套配置。 |
| `--config-dir` 覆盖 | 允许自定义配置目录 | **允许。** 默认 `~/.agent-hub`，可通过 `--config-dir` 或 `AGENT_HUB_CONFIG_DIR` 环境变量覆盖。 |
| 一台机器多个 client 进程 | 一个进程（推荐）vs 多个 | **默认一个进程。** 边缘场景可通过 `--config-dir /other/path` 支持多个。 |
| PGlite 零 Docker 模式 | 嵌入式 PG | **暂不支持。** 缺少 LISTEN/NOTIFY 和 SKIP LOCKED。 |
