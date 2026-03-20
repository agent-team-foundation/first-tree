# AGENTS.md

Agent Hub — Agent Team 中心化协作平台（Server + Client + Web monorepo）。

## 系统定位

Agent Hub 是 Agent Team 的基础设施，提供 Agent 注册/认证、消息通信、外部 IM 桥接和管理后台。

```
Agent Hub ≠ Agent 本身（具体的 LLM agent 逻辑不在 Hub 内）
Agent Hub ≠ 编排框架
Agent Hub ≠ Context Tree
```

## 技术栈

**Server:** Python 3.11+ / FastAPI / SQLAlchemy 2.0 (async) / PostgreSQL / Alembic / Pydantic v2 / bcrypt / PyJWT

**Client:** Python 3.11+ / httpx / websockets / Pydantic v2

**Web:** React (TBD)

**工具链:** uv (workspace) / ruff / pyright / pytest

## 常用命令

```bash
# 环境
uv sync                                    # 安装 Python workspace 依赖
cd web && npm install                       # 安装 Web 依赖

# 启动
docker compose up -d                        # 启动 PostgreSQL
uv run --package agent-hub-server python -m agent_hub_server    # 启动 server
uv run --package agent-hub-client python -m agent_hub_client    # 启动 client
cd web && npm run dev                       # 启动 web

# 质量
uv run ruff format .                        # 格式化
uv run ruff check .                         # Lint
uv run pyright                              # 类型检查
uv run pytest                               # 测试（全部）
uv run --package agent-hub-server pytest    # 测试（仅 server）
uv run --package agent-hub-client pytest    # 测试（仅 client）

# 数据库
uv run --package agent-hub-server alembic upgrade head                     # 应用迁移
uv run --package agent-hub-server alembic revision --autogenerate -m ""    # 生成迁移
```

## Monorepo 结构

```
agent-hub/
├── pyproject.toml              # uv workspace 根配置 + ruff/pyright/pytest
├── docker-compose.yml          # 本地开发 PostgreSQL
├── .env.example                # 环境变量模板
│
├── doc/                        # 设计文档
│   ├── agent-hub-overview.md           # 总体技术方案
│   └── agent-hub-server-detailed-design.md  # Server 详细设计
│
├── server/                     # Platform Server（agent-hub-server）
│   ├── pyproject.toml
│   ├── tests/
│   └── src/
│       └── agent_hub_server/
│           ├── __init__.py
│           ├── app.py          # FastAPI 应用入口
│           ├── api/            # API 路由（agent_api/ + admin_api/ + webhooks/）
│           ├── models/         # SQLAlchemy ORM
│           ├── schemas/        # Pydantic DTO
│           ├── services/       # 业务逻辑
│           ├── auth/           # 认证（Agent Token + Admin JWT）
│           ├── adapter/        # 外部 IM 桥接（飞书/Slack）
│           └── db/             # 数据库连接、迁移
│
├── client/                     # Agent Runtime（agent-hub-client）
│   ├── pyproject.toml
│   ├── tests/
│   └── src/
│       └── agent_hub_client/
│           ├── __init__.py
│           ├── runtime.py      # Agent Runtime 主入口
│           ├── session.py      # Session 管理
│           ├── inbox.py        # Inbox 消费与路由
│           ├── connection.py   # Server 连接（HTTP + WebSocket）
│           ├── models.py       # 数据模型
│           └── config.py       # Agent 配置
│
└── web/                        # Admin Console（agent-hub-web）
    ├── package.json
    └── src/
```

## 架构规则

**三子系统独立：** Server、Client、Web 各自独立打包、独立部署，无代码依赖。各自维护自己的数据模型。

**Server 无状态：** 所有持久数据在 PostgreSQL，Server 实例不持有业务状态，天然支持水平扩展。

**仅依赖 PostgreSQL：** 不引入 Redis、消息队列或其他中间件。PG 覆盖存储、队列（SKIP LOCKED）、通知（LISTEN/NOTIFY）。

**双轨认证隔离：**
- Agent Token（Bearer）→ Agent API — 机器凭证
- Admin JWT → Admin API — 人类凭证
- 两套认证**完全隔离**，不可交叉访问
- localhost 也必须认证

**Inbox 是 Server/Client 边界：** Server 写入 Inbox，Client 读取 Inbox。两个子系统通过 Inbox 解耦。

**公共接口优先：** 面向开源，HTTP API 从第一天起保持稳定，不轻易 break。

## 编码规范

- **全异步**: 除无 I/O 的简单方法外均为 `async`
- **类型安全**: 所有函数必须有类型注解，用 pyright 检查
- **Pydantic only**: DTO/配置必须用 `BaseModel`，禁止 `dataclass`/`TypedDict`/裸字典
- **显式导入**: `__init__.py` 保持空（或仅 re-export 公共 API）
- **异常**: Service 层定义异常类，API 层用 `HTTPException`
- **DB Enum 大写**: 如 `ONLINE = "ONLINE"`
- **修改后必须运行**: `uv run ruff format . && uv run ruff check . && uv run pyright`

## 代码修改三原则

1. **优先修改而非创建**: 能通过修改现有文件解决的，不创建新文件
2. **检查现有实现**: 使用新库或模式前，先搜索项目中是否已有类似实现
3. **保持一致性**: 遵循项目现有的代码风格和组织结构

## 开发流程

### 新功能开发步骤（Server）

1. 定义 Schema（`schemas/`）
2. 定义 Model（`models/`）— 如需持久化
3. 实现 Service（`services/`）
4. 定义 API 路由（`api/`）
5. 创建数据库迁移: `uv run --package agent-hub-server alembic revision --autogenerate -m "desc"`
6. 应用迁移: `uv run --package agent-hub-server alembic upgrade head`
7. 编写测试（`tests/`）

### Git 规范

- **分支策略**: trunk-based，feature branch → PR → squash merge → main
- **版本发布**: tag + GitHub Release
- **Conventional Commits**: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`
- 不要自动 commit，等用户测试确认后再提交

## 关键参考

- 总体技术方案: [doc/agent-hub-overview.md](doc/agent-hub-overview.md)
- Server 详细设计: [doc/agent-hub-server-detailed-design.md](doc/agent-hub-server-detailed-design.md)
