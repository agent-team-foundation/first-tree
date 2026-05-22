# First Tree

<p align="center">
  <a href="README.md">English</a> | 中文
</p>

**First Tree** 是构建和运营 Agent 团队的统一 CLI。一个二进制覆盖三件事：

- **Context Tree** — 由 Agent 和人类共同维护的树状知识库。每个节点都是一个领域、一项决策、一份设计。
- **GitHub Scan** — 监听 GitHub 通知并把每个任务派发给对应 Agent runner 的后台 daemon。
- **Hub Agent 协作** — 多 Agent 团队需要的身份、消息、外部 IM 桥接（原 `first-tree-hub` CLI 的功能集）。

这个 repo 是把 `first-tree-hub` 和 `first-tree@0.4.x` 两份代码合并成单一源树的产物，v1.0.0 是合并后的首个发布版本。本仓库现在**就是** First Tree —— 不再是某个生态的子项目，所有 CLI 入口、Server、Web 控制台都在这里。合并历史的 anchor 见 [`docs/development/git-history.md`](docs/development/git-history.md)。

## 安装

```bash
npm install -g first-tree
first-tree --help
```

二进制名为 `first-tree`；同时安装短别名 `ft`。

## 顶层命令树

```
first-tree
├── login <token>           把当前机器登入 Hub
├── logout                  退出 Hub
├── status                  CLI / daemon / Hub / auth 一屏概览
├── doctor                  跨子系统就绪检查
├── upgrade                 升级到最新发布版本
├── agent ...               Agent 管理（配置、绑定、消息）
├── chat ...                聊天与消息（list / history / send / open）
├── org ...                 组织级操作
├── daemon ...              后台 daemon(hub-client 生命周期)
├── config ...              查看 / 修改本机 client.yaml
├── tree ...                Context Tree 接入、校验、自动化
└── github scan ...         GitHub Scan daemon 与 inbox 运行时
```

每个 namespace 跑 `first-tree <namespace> --help` 看完整子命令。

## 仓库结构

- `apps/cli/` — 发布的 CLI 包(`first-tree` / `ft`)
- `packages/shared/` — Zod schema、类型、配置系统(`@first-tree/shared`)
- `packages/server/` — Fastify API server(`@first-tree/server`；通过 Docker 部署为 Hub SaaS)
- `packages/client/` — Agent SDK + Runtime(`@first-tree/client`)
- `packages/web/` — React 管理后台(`@first-tree/web`)
- `packages/github-scan/` — GitHub Scan daemon(`@first-tree/github-scan`)
- `packages/e2e/` — 黑盒 e2e 测试框架(`@first-tree/e2e`)
- `skills/` — 单 skill 的 markdown payload(`first-tree`、`first-tree-cloud`、`first-tree-github-scan`、`first-tree-sync`、`first-tree-write` 等)

## 文档

- [CLI Reference](docs/cli-reference.md) — 所有命令和环境变量
- [docs/tree/](docs/tree/) — Context Tree 概念与历史迁移
- [docs/migration/](docs/migration/) — 从旧 CLI 名迁移到 v1.0.0
  - [from-first-tree-hub.md](docs/migration/from-first-tree-hub.md) — 给原 `first-tree-hub` 用户(旧的协作 CLI)
  - [from-first-tree-v0.md](docs/migration/from-first-tree-v0.md) — 给原 `first-tree@0.4.x` 用户(旧的 Context Tree CLI)
- [docs/development/git-history.md](docs/development/git-history.md) — 如何在 repo-merge 边界两侧追溯 git 历史

## 开发

```bash
pnpm install                                # 安装依赖
docker compose up -d                        # 启动开发用 PostgreSQL
pnpm --filter @first-tree/server dev        # Server(dev 模式)
pnpm --filter @first-tree/web dev           # 管理后台(dev 模式)
pnpm check && pnpm typecheck                # Lint + 类型检查
pnpm test                                   # 运行测试
```

架构、约定、按 package 的开发流程详见 [AGENTS.md](AGENTS.md)。
