# First Tree Core CLI Reference

## Commands

```
first-tree-core
├── server
│   ├── start [--port] [--host] [--database-url] [--no-interactive]
│   ├── stop
│   └── status
├── client
│   ├── start [--no-interactive]
│   ├── stop
│   ├── status
│   ├── add [name] [--token]
│   ├── remove <name>
│   └── list
├── config
│   ├── setup [-s|-c]
│   ├── set [-s|-c|-a <name>] <key> <value>
│   ├── get [-s|-c|-a <name>] <key> [--show-secrets]
│   └── list [-s|-c|-a <name>] [--show-secrets]
├── db
│   └── migrate
├── admin
│   └── create [-u <username>] [-p <password>]
├── status
├── register
└── pull [-l <limit>] [-a]
```

## server start

启动 Server（API + Web 管理后台，同一端口）。

```bash
first-tree-core server start
first-tree-core server start --port 9000
first-tree-core server start --database-url postgresql://user:pass@host:5432/db
first-tree-core server start --no-interactive  # Docker/CI 部署用
```

首次启动时，缺失的必填配置会进入交互式引导（选择 PG 方式、输入 Context Tree 仓库等）。

`--no-interactive` 或无 TTY 环境（Docker/CI）会跳过交互式引导。缺失配置时报错退出，列出缺失项及对应环境变量名。

## config

```bash
# 交互式配置向导
first-tree-core config setup -s          # Server
first-tree-core config setup -c          # Client

# 命令式操作
first-tree-core config set -s server.port 9000
first-tree-core config get -s server.port
first-tree-core config list -s
first-tree-core config list -s --show-secrets

# Scope 标志
#   -s / --server    → ~/.first-tree-core/server.yaml
#   -c / --client    → ~/.first-tree-core/client.yaml
#   -a <name>        → ~/.first-tree-core/agents/<name>/agent.yaml
```

## client

```bash
# 添加 agent（交互式或命令式）
first-tree-core client add
first-tree-core client add my-agent --token aht_xxx

# 管理
first-tree-core client list
first-tree-core client remove my-agent
first-tree-core client status

# 启动（连接所有配置的 agent 到 server）
first-tree-core client start
```

## Environment Variables

所有环境变量统一使用 `FIRST_TREE_` 前缀。设置了环境变量后，交互式 prompt 会自动跳过对应字段。

### Server

| 环境变量 | 用途 | 默认值 |
|---------|------|--------|
| `FIRST_TREE_DATABASE_URL` | PostgreSQL 连接 URL | auto: Docker 拉起 |
| `FIRST_TREE_PORT` | 服务端口 | `8000` |
| `FIRST_TREE_HOST` | 绑定地址 | `127.0.0.1` |
| `FIRST_TREE_JWT_SECRET` | JWT 签名密钥 | auto: 随机生成 |
| `FIRST_TREE_ENCRYPTION_KEY` | Adapter 凭证加密密钥 | auto: 随机生成 |
| `FIRST_TREE_CONTEXT_TREE_REPO` | Context Tree 仓库（URL 或 owner/repo） | 交互式输入 |
| `FIRST_TREE_GITHUB_TOKEN` | GitHub API token | 交互式输入 |
| `FIRST_TREE_WEB_DIST_PATH` | Web 静态文件路径 | 自动发现 |

### Client

| 环境变量 | 用途 | 默认值 |
|---------|------|--------|
| `FIRST_TREE_SERVER_URL` | Server 地址 | 交互式输入 |
| `FIRST_TREE_LOG_LEVEL` | 日志级别 (`debug`/`info`/`warn`/`error`) | `info` |

## Config Directory

```
~/.first-tree-core/
├── server.yaml              # Server 配置
├── client.yaml              # Client 配置
├── agents/                  # Agent 实例
│   ├── my-agent/agent.yaml
│   └── another/agent.yaml
└── data/
    └── postgres/            # Docker PG 数据
```

## Config Resolution Order

优先级从高到低：

1. CLI 参数（`--port 9000`）
2. 环境变量（`FIRST_TREE_PORT=9000`）
3. 配置文件（`~/.first-tree-core/server.yaml`）
4. 自动生成（secrets、Docker PG URL）
5. 内置默认值（`port: 8000`）
