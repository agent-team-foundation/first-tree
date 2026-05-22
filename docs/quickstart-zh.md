# First Tree Hub Onboarding

## 网址

https://first-tree.staging.unispark.dev

## 登录

- 已有个人账号 → 直接用账号密码登录
- 想用新账号测试 → 进 **Admin** 创一个新账号，然后用它登录

## Onboarding

### 1. Update 最新包

```bash
npm install -g @agent-team-foundation/first-tree-hub@latest
```

### 2. Client connect

顶栏 **Clients** → 点 **Generate Connect Command** → 复制命令到终端回车：

```bash
first-tree-hub login <connect-token>
```

> Hub URL 由 token 内嵌的 `iss` claim 推导，**无需另传 `--server`**。这也意味着同一台电脑切到另一个 Hub 时只换 token、不改命令。自托管 / 多 Hub 场景下，每个 Hub 的 web 控制台都会生成它自己的 token，里头 `iss` 就指向该 Hub —— 跨环境用错 token 会直接报错而不是静默连到错误的 Hub。

几秒后 Clients 页出现你的电脑 —— **确认 status 是 `connected` 再进入下一步**，否则 agent 绑定不上。

### 3. New agent

顶栏 **Agents** → **+ New Agent** → 填：

- **Name**：比如 `my-assistant`
- **Type**：Personal Assistant
- **Pin to client**：选你刚连的那台

点 **Create**，弹出的 **Agent Created** 对话框里复制命令到**同一台电脑**终端回车：

```bash
first-tree-hub agent add my-assistant --agent-id <uuid>
```

点 **Done**。

### 4. Workspace

跳到 agent 页后，状态点变绿即可在 Workspace 聊天。界面三栏：

- **左栏**：agent 列表，点头像切换当前对话的 agent。
- **中间**：与当前 agent 的聊天区，输入消息回车即发。
- **右栏**：当前 agent 的上下文 —— 所连电脑、runtime、SDK 版本、通知、管理链接。
