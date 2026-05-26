# First-Tree

<p align="center">
  <a href="README.md">English</a> | 中文
</p>

**Agent 团队在 First-Tree 上运行。**

first-tree 把工作分派给合适的 Agent，给它和团队同一份上下文，只在
规则要求时把人类拉进流程。常驻在你的 GitHub 里。开源。

## 安装

```bash
npm install -g first-tree
first-tree --help
```

二进制名为 `first-tree`；同时安装短别名 `ft`。

## 顶层命令树

```
first-tree
├── login <token>           把当前机器登入服务端
├── logout                  停止 daemon 并清除凭证
├── status                  CLI / daemon / 服务端 / auth 一屏概览
├── doctor                  跨子系统就绪检查
├── upgrade                 升级到最新发布版本
├── agent ...               Agent 管理（配置、绑定、消息）
├── chat ...                聊天与消息（list / history / send / open）
├── org ...                 组织级操作
├── daemon ...              后台 daemon 生命周期
├── config ...              查看 / 修改本机 client.yaml
├── tree ...                Context Tree 接入、校验、自动化
└── github scan ...         GitHub Scan daemon 与 inbox 运行时
```

每个 namespace 跑 `first-tree <namespace> --help` 看完整子命令。

## 仓库结构

- `apps/cli/` — 发布的 CLI 包（`first-tree` / `ft`）
- `packages/shared/` — Zod schema、类型、配置系统（`@first-tree/shared`）
- `packages/server/` — Fastify API server（`@first-tree/server`；通过 Docker 部署为 SaaS）
- `packages/client/` — Agent SDK + Runtime（`@first-tree/client`）
- `packages/web/` — React 管理后台（`@first-tree/web`）
- `packages/github-scan/` — GitHub Scan daemon（`@first-tree/github-scan`）
- `packages/e2e/` — 黑盒 e2e 测试框架（`@first-tree/e2e`）
- `skills/` — 单 skill 的 markdown payload（`first-tree`、`first-tree-cloud`、`first-tree-github-scan`、`first-tree-sync`、`first-tree-write`、`first-tree-onboarding`、`github-scan`）

## 文档

- [Quickstart](docs/quickstart.md) — 从注册到第一条对话
- [Onboarding Guide](docs/onboarding-guide.md) — CLI 流程、SDK、故障排查
- [CLI Reference](docs/cli-reference.md) — 所有命令和环境变量
- [Observability](docs/observability.md) — 日志与 OpenTelemetry traces
- [docs/development/](docs/development/) — 贡献者参考（HTTP / JWT、dev 隔离）
- [docs/troubleshooting/](docs/troubleshooting/) — 环境相关问题排查
- [docs/migration/](docs/migration/) — 从 `first-tree@0.4.x` 升级

## 开发

```bash
pnpm install                                # 安装依赖
docker compose up -d                        # 启动开发用 PostgreSQL
pnpm --filter @first-tree/server dev        # Server（dev 模式）
pnpm --filter @first-tree/web dev           # 管理后台（dev 模式）
pnpm check && pnpm typecheck                # Lint + 类型检查
pnpm test                                   # 运行测试
```

架构、约定、按 package 的开发流程详见 [AGENTS.md](AGENTS.md)。PR 流程
详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[Apache 2.0](LICENSE)
