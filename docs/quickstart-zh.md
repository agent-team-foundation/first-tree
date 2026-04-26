# First Tree Hub Onboarding

本指南分本地（自己机器跑）和托管（连别人架好的 Hub）两种场景。本地场景已经定稿；托管场景沿用既有的 Web + CLI 流程，将在后续修订中重写。

## 本地：自己机器跑

### 前置条件

- Node.js ≥ 22.16
- Docker Engine 或 Docker Desktop 已启动

### 1. 安装（一次）

```bash
npm install -g @agent-team-foundation/first-tree-hub
```

### 2. 启动（前台）

```bash
first-tree-hub start
```

执行流程一次性搞定：Docker 预检 → 拉起 Postgres 容器 → 跑 migrations → 自动建本机管理员（用户名/密码不会显示） → 嵌入式 Client 启动 → 浏览器自动打开 `http://127.0.0.1:8000`。

终端保持运行，按 `Ctrl+C` 停 server + client（Postgres 容器保留；要一并停：`first-tree-hub server stop`）。

> 想让 Hub 持续后台运行 / 重启后自动起？后台服务模式（`--service`，macOS launchd / Linux systemd-user）正在实现中。

### 3. 在 Web 里建第一个 agent

浏览器进入 Workspace（你已自动登录）→ **Agents** → **+ New Agent** → 填名字（比如 `my-assistant`）→ **Create**。

后台流程（无需在终端做任何事）：
1. Web 看到本机已有连接的 client，自动 pin agent 到本机。
2. 服务端推送 `agent:pinned` 事件，本地 ClientRuntime 自动写 `agent.yaml` 并启动 slot。
3. Web 检测到 agent 已上线，路由到 Workspace。

整个过程 1–2 秒，没有终端介入步骤。

### 4. Workspace 聊天

界面三栏：

- **左栏**：agent 列表，点头像切换当前对话的 agent。
- **中间**：与当前 agent 的聊天区，输入消息回车即发。
- **右栏**：当前 agent 的上下文 —— 所连电脑、runtime、SDK 版本、通知、管理链接。

### 5. 关闭 / 离开

- 直接 `Ctrl+C`（前台模式）：停 server + client；Postgres 容器保留。
- 关终端：等同 `Ctrl+C`（SIGHUP 关掉父进程，所有子进程一并退出）。

### 6. 后续启动

```bash
first-tree-hub start
```

`hasUser()` 已经返回 true，跳过自动建管理员；浏览器再次打开 `http://127.0.0.1:8000`，Web 端 auth guard 看到 localStorage 里的 JWT 仍有效（或自动通过 loopback 重铸），直接进 Workspace。

### 恢复

打开 `http://127.0.0.1:8000`。如果 localStorage 的 JWT 过期或不存在，Web `/login` 路由会自动调 loopback-only 的 `local-bootstrap` 端点重铸一对新的 token —— 不需要任何 CLI 命令。

### 升级

```bash
npm install -g @agent-team-foundation/first-tree-hub@latest
first-tree-hub start
```

第二行重启 server，并应用任何新 migration。

## 托管：连别人架好的 Hub

### 网址

https://first-tree.staging.unispark.dev

### 登录

- 已有个人账号 → 直接用账号密码登录
- 想用新账号测试 → 进 **Admin** 创一个新账号，然后用它登录

### 1. Update 最新包

```bash
npm install -g @agent-team-foundation/first-tree-hub@latest
```

### 2. Client connect

顶栏 **Clients** → 点 **Generate** → 复制命令到终端回车：

```bash
first-tree-hub client connect https://first-tree.staging.unispark.dev --token <jwt>
```

几秒后 Clients 页出现你的电脑 —— **确认 status 是 `connected` 再进入下一步**，否则 agent 绑定不上。

### 3. New agent

顶栏 **Agents** → **+ New Agent** → 填：

- **Name**：比如 `my-assistant`
- **Where it runs**：Claude Code

点 **Create**。如果你的本机 Client 已连接，agent 会自动 pin 到本机；如果没连，弹出的 **Last step — connect your computer** 对话框里给一条组合命令复制到终端跑。

### 4. Workspace

跳到 agent 页后，状态点变绿即可在 Workspace 聊天，界面同本地场景。
