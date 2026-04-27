# First Tree Hub — SaaS Onboarding 设计文档

> 本文档定义将 First Tree Hub 从 self-host 工具转型为 SaaS 服务的 onboarding 端到端体验。范围限定为"用户从首次访问到第一个 agent 跑起来 + 邀请队友"。

---

## 1. 背景与目标

### 1.1 现状

- First Tree Hub 当前以 self-host 部署为中心:`server start` / `admin:create` / Docker Postgres 自启,由 [@baixiaohang](https://github.com/baixiaohang) 在 2026-03 引入([#17](https://github.com/agent-team-foundation/first-tree-hub/pull/17)、[#33](https://github.com/agent-team-foundation/first-tree-hub/pull/33)、[#37](https://github.com/agent-team-foundation/first-tree-hub/pull/37)、[#57](https://github.com/agent-team-foundation/first-tree-hub/pull/57))
- Web 端只有 `/login` 用户名密码登录,**无注册、无引导向导**
- CLI `onboard` 假设管理员已为用户创建账号
- **多租户底座已就位**:`organizations` / `users` / `members` / `agents` / `clients` 表齐全([#160](https://github.com/agent-team-foundation/first-tree-hub/pull/160) 完成 `organizationId` scope),member JWT 已统一([#95](https://github.com/agent-team-foundation/first-tree-hub/pull/95)、[#108](https://github.com/agent-team-foundation/first-tree-hub/pull/108))
- 缺的是**入口**:公开注册、引导向导、官方域名、connect token 的 web 生成路径

### 1.2 目标

1. 新用户从访问 `https://hub.first-tree.ai` 到第一个 agent online,**< 5 分钟**
2. 邀请队友:admin 生成链接 → 通过任意 IM 渠道发出 → 队友点链接自助加入,**无需联系发起人**
3. 现有 self-host 命令对终端用户隐藏(代码保留供运维 / 内部使用)

### 1.3 范围

**In Scope**
- Web:GitHub OAuth 注册、`/setup`、引导向导、邀请管理
- 后端:schema 改造(`users.email` + `auth_providers` + `invitations`)、auth 新路由
- CLI:简化 `connect` 命令,默认指向官方域名

**Out of Scope**(本期不做)
- Email OTP / magic link 等邮箱认证(2.1)
- **任何邮件投递通道**(welcome / 邀请邮件 / OTP / nudge — 都不做)
- 付费 / Stripe / 计费配额(2.2)
- 邀请 link 的 rotate / expiry / 多 link / per-recipient 单次使用(2.3 — 都是 v2)
- 邀请发送时直接给 admin 角色(2.3 — admin 提权由 Settings → Members 完成)
- "登录后自动检测 pending invitations"(2.3 — 路径 3 模型不支持)
- Activation funnel 埋点(2.6)
- Cookie banner / GDPR 合规
- Cross-device session 管理 / 远程登出

### 1.4 成功定义

- 新用户 onboarding 完成率 ≥ 70%(注册 → 第一个 agent online)
- 受邀人无需联系发起人即可加入 workspace
- 0 用户因被锁在 self-host 配置外而流失

---

## 2. 核心设计决策

### 2.1 用户认证

| 决策 | 选择 | 理由 |
|---|---|---|
| 认证方式 | **仅 GitHub OAuth**(无密码、无 OTP)| 目标用户是工程师,GitHub 是默认装备;一键登录最顺;省去邮件服务依赖。"Continue with GitHub" 单按钮,决策疲劳为 0 |
| `users.email` 字段 | 保留,从 GitHub 回调取 primary email,UNIQUE NOT NULL | 给后续扩展(notification、邮件邀请 v2、SCIM 等)留路;不主动用,但白存 |
| 账号归并 | 一 GitHub 账号 = 一 user 记录;按 GitHub `provider_user_id` 归并 | 同人不会有两个账号;email 仅作辅助标识 |

### 2.2 组织 / Workspace 模型

| 决策 | 选择 | 理由 |
|---|---|---|
| 用户面术语 | **workspace**(DB 仍叫 `organizations`)| 跟 Slack / Linear / Notion / Multica 一致;DB 内部不动避免 schema rename |
| 注册与 workspace 解耦 | 注册只建 user;workspace 由用户**显式** Create / Join | 不自动建避免僵尸 workspace + 用户感受被塞;符合"诚实"原则 |
| Plan 配额 | 暂不做付费,所有用户同 plan;仅依赖现有 `organizations.maxAgents` 软限 | 减少 onboarding 复杂度 |

### 2.3 邀请

| 决策 | 选择 | 理由 |
|---|---|---|
| 形态 | **每个 workspace 一条公共 share link**(多次使用),角色固定 member | 像 Discord / Slack 的 workspace 邀请 link;admin 复制一次即可在 IM 群里发广播,小团队场景最顺 |
| 角色 | 固定 **member**;不支持邀请时直接给 admin | v1 简化:admin 提权场景不常见;新成员 join 后由 workspace admin 在 Settings 提权即可 |
| 字段 | 仅 `token`,无 email、无 GitHub username、无 label、无 expiry、无 single-use | 简化到极致;v2 再加 rotate / expiry |
| Token 生成时机 | workspace 创建时立即生成,持久化在 `organizations.invite_token` 字段 | lazy 也行,但 eager 更简单(admin 任何时候去 Settings → Members 直接能 copy)|
| Rotate(轮换 token)| **本期不做**;token 一旦泄露暂时只能容忍 | v2 再做 |
| 自动检测 pending | **不做**(无 per-recipient 概念,也没东西可"自动检测")| 受邀人只能通过 admin 给的链接 access |
| 接受时校验 | token 与某 workspace 的 `invite_token` 匹配即可 | 任何登录用户拿到有效链接即可 accept |
| 谁能看 invite link | 仅 workspace admin 可见(Settings → Members 页)| member 看不到 → 不能未经 admin 同意拉外人入伙 |

### 2.4 Agent Runtime

| 决策 | 选择 | 理由 |
|---|---|---|
| 当前支持 | 用户本机 Claude Code(唯一已实现的 agent CLI) | "连机器"是必经路径 |
| 未来扩展 | Codex / OpenCode 等显示 coming soon | UI 占位,云端 runtime 更晚 |
| OS 支持 | macOS + Linux 一键安装;Windows 显式不支持(banner 提示走 WSL) | 对齐现有 daemon 限制 |

### 2.5 引导向导(Wizard)

| 决策 | 选择 | 理由 |
|---|---|---|
| 屏数 | **仅 2 屏**:Connect computer → Create your first agent → 进 Workspace | 越少越好;每屏一个动作,完成即推进;不显示"还剩几步" |
| 进度条 | **不做** | 跟"屏数极少"配合,用户感觉是被引导而非被压迫 |
| Workspace setup | **不算 wizard 屏**,`/setup` 是 wizard 之前的强制前置门槛 | cross-workspace 动作,概念不同 |
| Invite teammates | **不算 wizard 屏**,通过 Settings → Members 入口 | 邀请是日常运营,不是初次入门必经路径;`organizations.invite_token` 在 workspace 创建时已生成,admin 任何时候都能 copy |
| 实现形式 | `/setup` 路由作 modal 载体;新用户和老用户(开第二个 workspace 时)共用同一个 modal | 单组件复用;UI 一致 |

### 2.6 基础设施

| 决策 | 选择 | 理由 |
|---|---|---|
| 域名 | `hub.first-tree.ai`,Web/API/WS/邀请同主域 | 跟产品名严格对齐;同域免 CORS 配置 |
| 默认语言 | 英文,中文按 `Accept-Language` 兜底 | 产品定位海外为主 |
| Self-host 命令 | 保留代码,从 CLI help 隐藏(Commander `hidden: true`) | 给内部运维 + 未来 enterprise 留口子 |
| 埋点 | 本期不接 | 流量小,先跑通比看数据重要;后续可选 PostHog |

---

## 3. 用户画像

| 角色 | 描述 | 进入路径 |
|---|---|---|
| **Alex** — 创始人 / admin | 创业团队工程师;本机已装 Claude Code、Node 22、有 GitHub 账号 | 自主注册 → Create workspace → 走 wizard → 邀请队友 |
| **Bob** — 被邀请的成员 | Alex 的同事;Slack 收到 Alex 发的邀请链接 | 点链接 → GitHub OAuth → 自动 accept → 走 wizard |

---

## 4. 用户旅程

### 4.1 总览图

```
[官网 hub.first-tree.ai] → /signup → "Continue with GitHub" → GitHub OAuth
                                                                  ↓
                                                          回调检查 next 参数
                                                                  ↓
                                       ┌──────────────────────────┴──────────────────────────┐
                                       ↓                                                     ↓
                              next=/invite/<token>                                  无 invite 上下文
                                       ↓                                                     ↓
                                加入 workspace                                            跳 /setup
                                       ↓                                                     ↓
                                       ↓                                          modal 弹出 (Create / Join)
                                       ↓                                                     ↓
                                       └──────────────── 进 /welcome ────────────────────────┘
                                                            (wizard 仅 2 屏,无进度条)
                                                                  ↓
                                                       Connect your computer
                                                                  ↓
                                                       Create your first agent
                                                                  ↓
                                                       [ Workspace 日常(已完成 onboarding)]
```

### 4.2 注册账号 · `/signup`

注册只产生 user 账号,**不创建 workspace、不创建 member、不创建 agent**。

1. 用户打开 `https://hub.first-tree.ai`,落地页 → 点 `Get Started` → `/signup?next=<optional>`
2. 页面只有一个大按钮:**Continue with GitHub**
3. 点击 → 跳 GitHub OAuth → 用户授权(scopes:`read:user` + `user:email`)→ 回调到 `/api/v1/auth/github/callback?code=xxx&state=xxx`
4. 后端处理回调:
   - 用 code 换 access_token
   - 拿 GitHub user info(login、id、primary email)
   - 按 `auth_providers.provider_user_id` 查 → 不存在则建 `users` 行(`email = github primary` 或 noreply 兜底)+ `auth_providers` 行
   - 颁发 access/refresh JWT,写 cookie
5. **路由判定**(关键):
   - 如果 `next` 参数指向 `/invite/<token>` → 见 §4.3 直接走 accept 分支
   - 否则 → 跳 `/setup`,弹 Create/Join modal

### 4.3 路径 A · 通过邀请链接进入(被邀请人)

```
Bob 在 Slack 看到 Alex 发的链接:https://hub.first-tree.ai/invite/abc123
                                          ↓
                                     点击,落到 /invite/abc123
                                          ↓
                          后端按 token 查 organizations.invite_token
                                          ↓
                                 找到对应 workspace
                                          ↓
                              ┌──── Bob 是否登录? ────┐
                              ↓                       ↓
                            未登录                  已登录
                              ↓                       ↓
              跳 /signup?next=/invite/abc123          ↓
                              ↓                       ↓
                         GitHub OAuth                 ↓
                              ↓                       ↓
                       回调检测 next 参数              ↓
                              ↓                       ↓
                              └─────────┬─────────────┘
                                        ↓
                                 加入 workspace
                                        ↓
                            建 members(role=member)
                            + Bob 在该 workspace 的 human agent
                                        ↓
                                 跳进 /welcome
                                 (不弹 /setup modal)
```

**边界**:
- token 不匹配任何 workspace → 落地页给错误文案 "This invite link isn't valid. Ask your admin for the correct link."
- Bob 已经是该 workspace 的 member → 跳进该 workspace 的 `/`(不重复加入)
- Bob 已经有别的 workspace → 加入完成后该 workspace 加到他的列表,顶部 dropdown 切换

### 4.4 路径 B · 主动注册(创建者)· `/setup` modal

适用于:Alex 这种自主访问 hub 注册的用户。GitHub OAuth 完成后,后端检测 next 无 invite,跳 `/setup`。

`/setup` 是一个**承载 modal 的路由**,modal 强制弹出,不能 dismiss(用户必须 Create 或 Join,否则没有 workspace 进不了 `/`)。

```
┌────────────────────────────────────────────────────────┐
│   Get started with First Tree Hub 👋                   │
│                                                        │
│   ────  I'm the admin · Create our workspace  ────     │
│                                                        │
│   Workspace name                                       │
│   [ Acme Engineering                            ]      │
│   ↳ acme-engineering · ✅ available                    │
│                                                        │
│            [ Create workspace ]                        │
│                                                        │
│   ─────────────────  or  ───────────────────────       │
│                                                        │
│   ────  I was invited · Join my team  ────             │
│                                                        │
│   Paste the invite link your admin shared              │
│   [ https://hub.first-tree.ai/invite/...        ]      │
│                                                        │
│            [ Join workspace ]                          │
│                                                        │
└────────────────────────────────────────────────────────┘
```

**Create 提交**:
1. 实时校验 name → slug 冲突自动建议(`acme-engineering` 已占 → 建议 `acme-engineering-7f2x`)
2. 提交 → 后端事务建 `organizations` + `members(role=admin)` + 当前 user 的 human `agents` 行
3. 跳 `/welcome`(进 wizard)

**Join 提交**(兜底场景:Bob 拿到链接但没直接点而是先来注册):
1. 用户粘贴**完整 URL** 或裸 token,前端正则提取
2. 提交 → 后端等价于 `/invite/<token>` accept 流程(§4.3 后半段)
3. 跳 `/welcome`(进 wizard)

**老用户访问 `/setup`**:dropdown 里点 [ + Create another workspace ] / [ + Join with link ] → 同一个 modal,作为 dialog 渲染在当前页面之上(不导航走);成功后进入新 workspace。

**错误文案**:

| 场景 | 文案 |
|---|---|
| 名字太短 | `Workspace name must be at least 2 characters` |
| 名字太长 | `Workspace name must be under 50 characters` |
| slug 已占 | `This name is taken. Try acme-eng-7f2x?`(自动建议变体)|
| 含非法字符 | `Use letters, numbers, spaces, and hyphens only` |
| 链接格式错 | `Doesn't look like a valid invite link` |
| token 不存在 / 不匹配任何 workspace | `This invite link isn't valid. Ask your admin for the correct link.` |

### 4.5 `/welcome` Wizard

**仅 2 屏 · 无进度条**。屏幕中央展示当前屏内容,顶部显示 workspace 名,右上角 logout 入口。屏底只有 `[ Continue ]` 按钮。

#### 4.5.1 Connect your computer

1. **介绍**:"First Tree Hub 通过你机器上的 agent CLI(目前 Claude Code,Codex 等接入中)执行任务"
2. **Prerequisite 双检查**:`node -v && claude --version && claude auth status`
   - 任一失败按 OS 给修复命令(brew / apt / nvm + Claude Code 官方安装脚本)
   - macOS / Linux 一键命令;Windows 显式不支持,banner 提示走 WSL
3. **Web 生成 connect token**(10–15 分钟有效)+ 一键复制完整命令:
   ```bash
   npm install -g @agent-team-foundation/first-tree-hub
   first-tree-hub connect --token eyJhbG...
   ```
4. CLI 单条命令完成:token 兑换 → 写 `client.yaml` → 装后台服务 → 启动 daemon → WS 连官方 hub
5. **Web 实时反馈**:"Waiting for your computer..." → 检测到 `clients` 行 `status=connected` → "✅ Alex's MacBook Air 已连接" → `[ Continue ]` 按钮亮起

**失败恢复**(P0):
- 60s 没连上 → 展开 troubleshoot 折叠面板
- token 过期 → 自动 [ Generate new token ]
- CLI 端连接错误 → 回写 server,Web 拉来显示人话错误

> **复用代码**:[connect.ts](../packages/command/src/commands/connect.ts)、[resolver.ts](../packages/shared/src/config/resolver.ts) 的 `client.yaml` 写入、launchd/systemd 服务安装(已有)
> **新增**:Web 上的 connect token 生成 UI、轮询 client 上线、`first-tree-hub connect` 默认指向官方域名

#### 4.5.2 Create your first agent

复用 [`NewAgentDialog`](../packages/web/src/components/new-agent-dialog.tsx) 内嵌进 wizard:

1. **Agent name**(自动 slugify);冲突时实时提示并自动建议附加 4 位随机短码
2. **Where it runs**:上一屏 connect 的 client(自动选中);多机器时给下拉
3. **Powered by**:Claude Code(默认 / 当前唯一);Codex / OpenCode disabled · "coming soon"
4. **高级**(可折叠):model、prompt 模板。默认值用 PR [#161](https://github.com/agent-team-foundation/first-tree-hub/pull/161) 引入的 opus + 通用 prompt
5. 提交 → 后端创建 `agents` 行 → server 推 `agent:pinned` → daemon 拉起 Claude Code → Web 显示 "✅ Agent online" → `[ Continue ]` 按钮亮起

**Agent 状态机**:`creating → pinning → starting → online / failed`,失败把 daemon 错误翻译成人话。

#### 4.5.3 进入 Workspace(wizard 结束)

第二屏 `[ Continue ]` 后:

1. 直接进入 Workspace 主面板(`/`),左侧已选中刚创建的 agent
2. `members.onboarding_state.current_step = 'completed'`,wizard 不再触发
3. 输入框 `placeholder` 写 `Try: "介绍一下你能做什么"` — 仅 hint,不强制

> **本期 wizard 不追求 aha**,先跑通流程;v2 升级方向:agent 主动 seed 欢迎消息 / 任务示例卡片 / 对话式配置 agent

### 4.6 日常使用

Wizard 关闭后:
- **Web 是主舞台**:agent 列表、对话、邀请队友、配 prompt/model
- **CLI 第一次 connect 之后不再用**,后台 service 永久运行
- **邀请队友**:Settings → Members → Copy invite link
- **加机器**:Settings → Computers → `Add another computer` → 重复 Connect 屏流程
- **切 workspace**:顶部 dropdown;加新 workspace 通过 `/setup` modal(dropdown [ + Create / Join ])
- **重新走向导**:Settings → `[ Restart onboarding ]`(P2-15)
- **绑外部 IM**:Feishu / Slack adapter(已存在,不在 onboarding 范围)

---

## 5. 数据模型变更(M0 前置)

### 5.1 `users` — 改造

| 字段 | 改动 | 说明 |
|---|---|---|
| `email` | **新增** UNIQUE NOT NULL | 从 GitHub primary email 取;UNIQUE 防同人多账号;暂不主动用,留扩展 |
| `username` | 保留,降级为可选 display handle | 不再作为登录标识 |
| `password_hash` | 保留(self-host 兼容)+ SaaS 流程不写入 | 已有自部署用户兼容 |

### 5.2 `auth_providers` — 新增

记录第三方 provider 与 user 的绑定关系。

```
auth_providers (
  id              uuid v7 PK
  user_id         uuid → users.id
  provider        text             -- 'github' | (future: 'google' | 'feishu')
  provider_user_id text            -- GitHub numeric ID
  email_at_link   text             -- 链接时 provider 返回的邮箱(审计用)
  created_at, updated_at
  UNIQUE(provider, provider_user_id)
)
```

### 5.3 `organizations.invite_token` — 新增字段

每个 workspace 一条公共 share link,token 持久化在 `organizations` 表上。**不再需要独立的 `invitations` 表**。

| 字段 | 改动 | 说明 |
|---|---|---|
| `invite_token` | **新增** TEXT UNIQUE NOT NULL | url-safe base64(32 字节随机),workspace 创建时自动生成 |
| `invite_token_created_at` | **新增** timestamptz | 审计用,记录 token 何时生成;rotate 时更新(本期不做 rotate)|

`/invite/<token>` 落地时按 `organizations WHERE invite_token = ?` 单查找;命中即为有效 link,workspace 即邀请目标,角色固定 member。

> v2 扩展空间:rotate(更新 token + invite_token_created_at)、expiry(加 invite_token_expires_at)、多 link(改回独立 `invitations` 表)。本期都不做。

### 5.4 `members.onboarding_state` — 新增字段

| 字段 | 改动 | 说明 |
|---|---|---|
| `onboarding_state` | **新增** JSONB nullable | `{ current_step: 'connect' \| 'create_agent' \| 'completed', dismissed_at }`。**按 user × workspace 维度**(P0-5)。Bob 在 Acme 走完 Connect 屏后被邀进 Beta,Beta 的 state 为空但他机器已连过,可在 Beta 的 wizard 跳过 Connect 屏 |

### 5.5 数据迁移

存量自部署用户(`users` 已有记录但无 email)→ 迁移脚本不一次性回填;首次升级后,登录时引导补 GitHub 绑定。SaaS 新用户从开始就走新流程。

**影响面**:
- 后端:`packages/server/src/db/schema/{users,members,organizations}.ts`、`packages/server/src/services/auth.ts`、`packages/server/src/services/organization.ts`、`packages/server/src/api/auth.ts`
- 共享:`packages/shared/src/schemas/{user,auth,member,organization}.ts`
- 前端:`packages/web/src/auth/auth-context.tsx` 的 user / member 类型

---

## 6. 风险与对策

### 6.1 P0 · 必修(不修产品挂)

| # | 风险 | 对策 |
|---|---|---|
| P0-1 | Connect 屏没检查 Claude Code 已 `claude login` → 进 Workspace 后第一句对话直接挂,无线索 | Prerequisite 双检查 `claude --version` + `claude auth status`,失败给具体修复命令 |
| P0-2 | Admin 找不到 workspace 的 invite link | Settings → Members 显示当前 invite link + [ Copy link ] 按钮(rotate 本期不做)|
| P0-3 | Onboarding 中途关浏览器后回来从头开始或被跳过 | `members.onboarding_state` 持久化进度,Web 进 `/` 时 reroute 回 wizard |
| P0-4 | Connect 屏 token 过期 / 超时 / firewall 拦截无恢复路径 | 60s 没连上展开 troubleshoot 面板 + token 过期自动 [ Generate new token ];CLI 错误回写 server |
| P0-5 | 老用户被邀进新 workspace 时**重复看到 Connect 屏**(他在前一个 workspace 已经装过 CLI 连过机器) | onboarding_state 按 **user × workspace** 维度,挂 `members` 表;Bob 的 Beta workspace 自动跳过 Connect 屏直接到 Create Agent |

### 6.2 P1 · 强烈建议(本期做)

| # | 风险 | 对策 |
|---|---|---|
| P1-6 | Prerequisite 没装时提示太干 | OS 自动给 `brew` / `apt` / `nvm` + Claude Code 官方安装脚本 |
| P1-7 | Create Agent 屏完成到进 Workspace 之间,agent 还在 starting 几秒钟 | Agent 状态机 + 启动失败时把 daemon 错误翻译成人话 |
| P1-8 | Workspace name / agent name 冲突 | 实时校验 + 自动建议(附加 4 位随机短码)|
| P1-9 | 多 workspace 顶部 switcher 缺失 | 顶部 dropdown:列出所有 workspace + `+ Create another` / `+ Join with link` 入口 |
| P1-10 | 进 Workspace 时 agent 还在 starting,先显示"No agents"再突然出现 | "Your agent is starting..." spinner 直到 `agent.status === 'online'` |
| P1-11 | 用户直接访问 `/`(workspace 主面板)但还没 workspace(理论上不应发生但要兜底) | 后端检测 → 自动 redirect 到 `/setup` |

### 6.3 P2 · 次重要(本期最小占位)

| # | 风险 | 对策 |
|---|---|---|
| P2-12 | 移动端打开做不下去 | Banner "Best experienced on desktop";不阻断登录 |
| P2-13 | ToS / Privacy 未链接 | 注册按钮下加 "By continuing you agree to [ToS] / [Privacy]" 占位页 |
| P2-14 | Workspace 隐私说明缺失("我的代码会被发到哪") | Workspace 折叠 "Privacy & Data Flow" 短文 + 链到独立页 |
| P2-15 | 跳过向导后无重启入口 | Settings 加 `[ Restart onboarding ]` 按钮 |
| P2-16 | CLI 长期升级路径不明 | Web 顶部检测过期 banner;自动升级延后 |

### 6.4 推迟 · 本期不做

- Activation funnel 埋点(decision 2.6)
- Cross-device session 管理(查活跃登录 / 远程登出)
- Welcome / nudge / re-engage 任何邮件序列(本期完全无邮件通道)
- Cookie banner / GDPR 合规
- 邀请 link rotate / expiry / 多 link / per-recipient 单次(全部 v2,decision 2.3)
- "登录后自动检测 pending invitations"(decision 2.3,纯 share link 模型不支持)

---

## 7. 实施计划

### 7.1 里程碑

| M | 内容 | 工程量 |
|---|---|---|
| **M0** | Schema 迁移:`users.email` + `auth_providers` + `organizations.invite_token` + `members.onboarding_state` | 后端 1d |
| **M1** | 注册路径:GitHub OAuth 路由 + callback 处理 + `next` 参数支持 + JWT 颁发 | 后端 1.5d |
| **M2** | `/setup` 路由 + Create / Join modal + 老用户复用入口(顶部 dropdown 弹同一个 modal)+ `/` 0-workspace 兜底 redirect(P1-11)| 前端 1.5d + 后端 0.5d |
| **M3** | `/welcome` Wizard 第 1 屏 Connect:Web token + CLI 简化 + prerequisite 双检查(P0-1, P1-6)+ 失败恢复(P0-4)| 前后端 2d |
| **M4** | Wizard 第 2 屏 Create Agent:复用 NewAgentDialog + agent 状态机 + 启动 spinner(P1-7, P1-10)+ name 冲突建议(P1-8)| 前后端 1.5d |
| **M5** | 进 Workspace + Workspace empty / loading 态 spinner(P1-10)+ wizard 完成态写入 onboarding_state | 前端 0.5d |
| **M6** | Settings → Members 页面显示 workspace invite link + Copy(P0-2)| 前端 0.5d |
| **M7** | Onboarding 状态持久化:`members.onboarding_state` 读写 + 跨 workspace 跳过逻辑(P0-3, P0-5)+ 顶部 workspace switcher(P1-9)| 前后端 2d |
| **M8** | 收尾:ToS 占位 + 移动端 banner + 隐私说明 + CLI 版本提示 + 重启入口(P2 全部)| 1.5d |
| **M9** | 隐藏 self-host 命令(Commander `hidden: true`)| 0.5d |

**合计**:**~11.5 工程日**(单人全力 ~2.5 周)

### 7.2 上线策略

- **必须串行**:M0 → M1 → M2 → M3
- **可并行**:M4 / M5 / M6 / M7 在 M3 之后可分头推进
- **收尾**:M8 / M9 在主流程稳定后并入

### 7.3 与 Multica 的对照

| 维度 | Multica | First Tree Hub(本方案) |
|---|---|---|
| 注册 | OAuth via browser | 仅 GitHub OAuth |
| 一行命令 | `multica setup` | `first-tree-hub connect --token=...` |
| Runtime 探测 | daemon 自动探测 | 同样自动探测 |
| Agent 创建 | Web Settings → Agents | Web wizard 第 2 屏(复用 NewAgentDialog)|
| 第一个任务 | 创建 issue 分配给 agent | Workspace 直接对话(本期最低成本版)|
| Web vs CLI | Web 主,CLI 是 daemon | 同样 Web 主导 |

---

## 8. 开放问题

| # | 问题 | 阻塞里程碑 |
|---|---|---|
| Q1 | **GitHub OAuth App 申请**:运维侧创建 dev / staging / prod 各一份;callback URL `https://hub.first-tree.ai/api/v1/auth/github/callback`;scopes `read:user` + `user:email` | M1 |
| Q2 | **域名 DNS 配置**:`hub.first-tree.ai` 的 A/AAAA 记录 | 上线前 |

---

## 附录 · 关键代码引用

| 路径 | 用途 |
|---|---|
| [packages/command/src/commands/connect.ts](../packages/command/src/commands/connect.ts) | CLI connect 入口(Connect 屏复用)|
| [packages/shared/src/config/resolver.ts](../packages/shared/src/config/resolver.ts) | `client.yaml` 写入、`FIRST_TREE_HUB_HOME` |
| [packages/web/src/components/new-agent-dialog.tsx](../packages/web/src/components/new-agent-dialog.tsx) | Create Agent 屏复用 |
| [packages/web/src/components/last-step-modal.tsx](../packages/web/src/components/last-step-modal.tsx) | Connect 屏复用(token 生成 + 轮询)|
| [packages/web/src/auth/auth-context.tsx](../packages/web/src/auth/auth-context.tsx) | Auth state(需扩 user / memberships)|
| [packages/server/src/services/agent.ts](../packages/server/src/services/agent.ts) | Rule R-RUN(`clients.user_id == jwt.userId` 强制,2.1 服务端兜底)|
