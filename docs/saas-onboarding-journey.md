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
2. 邀请队友:发邮件 → 队友点链接 → 自助完成 onboarding,**无需联系发起人**
3. 现有 self-host 命令对终端用户隐藏(代码保留供运维 / 内部使用)

### 1.3 范围

**In Scope**
- Web:注册、登录、`/workspaces`、引导向导、邀请管理
- 后端:schema 改造(email-based identity)、auth 新路由、invitations 表
- CLI:简化 `connect` 命令,默认指向官方域名

**Out of Scope**(本期不做)
- 付费 / Stripe / 计费配额(2.2)
- 任意人可接受的 share link(2.3)
- Activation funnel 埋点(2.5)
- Cookie banner / GDPR 合规
- Cross-device session 管理 / 远程登出

### 1.4 成功定义

- 新用户 onboarding 完成率 ≥ 70%(Stage 0 → Stage 3)
- 受邀人无需联系发起人即可加入 org
- 0 用户因被锁在 self-host 配置外而流失

---

## 2. 核心设计决策

### 2.1 用户认证

| 决策 | 选择 | 理由 |
|---|---|---|
| 认证方式 | GitHub OAuth + Email OTP(6 位验证码)并存 | **无密码方案**:不存 bcrypt,每次登录都是一次性 token。OAuth 主推(`/signup` 大按钮),OTP 兜底。OTP 比 magic link 在国内邮件场景更稳(避开 QQ/微信邮箱链接拦截) |
| 账号归并 | 一邮箱 = 一账号(UNIQUE);GitHub 与 OTP 按 email 自动归并 | 同人不会有两个账号;GitHub 作为已绑定 provider 共存 |

### 2.2 组织模型

| 决策 | 选择 | 理由 |
|---|---|---|
| 注册与组织解耦 | 注册只建 user;创建/加入 org 是后续动作 | 数据模型本就是 user × org 多对多;被邀请用户不必先建废 org;0 org 用户允许存在(先看看再说) |
| Plan 配额 | 暂不做付费,所有用户同 plan;仅依赖现有 `organizations.maxAgents` 软限 | 减少 onboarding 复杂度;到需要收费时再加 |

### 2.3 邀请

| 决策 | 选择 | 理由 |
|---|---|---|
| 形态 | 仅邮件邀请(`invitations.email NOT NULL`);**不做** "Generate share link"(任意人可接受) | 简化心智 + 防错邀让陌生人加入 |
| 角色默认 | member;admin 须显式选 | 低权默认 |
| 邮箱匹配 | 严格匹配:`invitation.email == 登录账号.email` 才能 accept | 防陌生人(同邮箱被回收 / 错邀)意外加入 |
| Pending 自动展示 | 登录后 `/workspaces` 按 user.email 自动查 pending invitations 并显示 | 不依赖邮件触达 — 邮件被拦截也能看到。Linear / Notion / Vercel 标配 |
| 链接复制 | 已发出的 invitation 仍可"复制邀请链接"到 Slack/微信 | 安全模型不变(接受时仍要求邮箱匹配),只是触达多渠道 |

### 2.4 Agent Runtime

| 决策 | 选择 | 理由 |
|---|---|---|
| 当前支持 | 用户本机 Claude Code(唯一已实现的 agent CLI) | Stage 1 的 `first-tree-hub connect` 是必经路径 |
| 未来扩展 | Codex / OpenCode 等显示 coming soon | UI 占位,云端 runtime 更晚 |
| OS 支持 | macOS + Linux 一键安装;Windows 显式不支持(banner 提示走 WSL) | 对齐现有 daemon 限制 |

### 2.5 基础设施

| 决策 | 选择 | 理由 |
|---|---|---|
| 域名 | `hub.first-tree.ai`,Web/API/WS/邀请同主域 | 跟产品名严格对齐;同域免 CORS 配置;邮件发件 `noreply@hub.first-tree.ai` |
| 默认语言 | 英文,中文按 `Accept-Language` 兜底 | 产品定位海外为主 |
| Self-host 命令 | 保留代码,从 CLI help 隐藏(Commander `hidden: true`) | 给内部运维 + 未来 enterprise 留口子 |
| 邮件发件服务商 | 待定(Resend / SES / Postmark) | 见开放问题 §8 |
| 埋点 | 本期不接 | 流量小,先跑通比看数据重要;后续可选 PostHog |

---

## 3. 用户画像

| 角色 | 描述 | 进入路径 |
|---|---|---|
| **Alex** — 创始人 / admin | 创业团队工程师;本机已装 Claude Code、Node 22、有 GitHub 账号 | 主动注册,创建 org,邀请队友 |
| **Bob** — 被邀请的成员 | Alex 的同事;可能已注册或未注册;自己机器需装 CLI | 收到 Alex 的邀请邮件,或自主注册后看到 pending invitation |

---

## 4. 用户旅程

### 4.1 总览图

```
[官网] ─→ /signup ─→ GitHub OAuth / Email OTP ─→ user 账号建好
                              ↓
                    ┌──── /workspaces ────┐
                    ↓                     ↓
              [创建 org]      [pending invitation 卡片]
                    └──── ↓ (跳进 /welcome) ────┘
                          │
   Stage 1 · 连接电脑 → Stage 2 · 创建 Agent →
   Stage 3 · 进入 Workspace → Stage 4 · 邀请(可跳过) →
                          ↓
                  [Workspace 日常]

(邀请也可来自:点邮件/Slack 链接 → /invite/<token> → /workspaces)
```

### 4.2 Stage 0 · 注册账号

注册只产生 user 账号,**不强制创建 org**。

1. Alex 打开 `https://hub.first-tree.ai`,落地页 → 点 "Get Started" → `/signup`
2. 选择登录方式:
   - **Continue with GitHub**(主):跳转 GitHub 授权 → 回调拿 primary email + provider id → 后端按 email 查 `users`;不存在就建,存在就关联 GitHub 到 `auth_providers`
   - **Continue with Email**(次):填邮箱 → 收 6 位 OTP(5 分钟有效)→ 回填 → 同上邮箱归并
3. 落到 `/workspaces`

> **后端事务**:仅写 `users`(+ `auth_providers` 若 GitHub 路径)。**不**创建 org / member / agent

### 4.3 Stage 0.5 · 选择工作空间(`/workspaces`)

进入此页时,**后端必查一次** `invitations WHERE email=user.email AND status=pending`,把待接受邀请展示在顶部(decision 2.3)。

| 用户状态 | UI 表现 |
|---|---|
| 0 个 membership,**有** pending | 顶部高亮 `Acme invited you to join as member · [ Accept ] [ Decline ]`(多条堆叠);下方仍可 `[ + 创建组织 ]` |
| 0 个 membership,**无** pending | 主面板单卡 `[ + 创建组织 ]`;底部小字 "Expecting an invitation? Make sure you logged in with the same email it was sent to." |
| 1 个 membership,无 pending | 自动跳转进 `/`(单 org 不停留) |
| 1+ 个 membership,有 pending | 顶部 pending 卡片 + 下方 org 列表,**不**自动跳转 |
| N 个 membership | 列出每个 org(name + role + 上次进入时间);顶部 `+ Create organization` |

#### 4.3.1 路径 A · 创建 org

1. 点 `[ 创建组织 ]` → 弹窗:Organization name + (可选)Your role
2. 提交 → 后端事务:`organizations` + `members(role=admin)` + 当前 user 的 human `agents` 行
3. 跳进 `/welcome` 走向导(Stage 1–4)

#### 4.3.2 路径 B · 接受邀请

两个入口都汇合到同一份 invitation:

**B1 · 点链接(主动)** — 来源:邮件 / Slack / 微信 / 口述粘贴
1. 点 `https://hub.first-tree.ai/invite/<token>` → 后端读 invitation
2. 未登录 → 跳 `/signup?next=/invite/<token>`,登录/注册后回此页
3. 已登录,email 严格匹配 → 一键 `[ Accept ]`
4. 已登录,email 不匹配 → 提示 "This invitation was sent to `bob@acme.com`. `[ Switch to that account ]`"(无"用当前账号接受"逃生口,decision 2.3)

**B2 · 登录后自动看到(被动)**
1. 用 `bob@acme.com` 登录 → 落到 `/workspaces`
2. 后端按 email 查 pending → 顶部高亮卡片
3. 点 `[ Accept ]` / `[ Decline ]`

**Accept 后续(B1/B2 共用)**:后端事务 `invitations.status='accepted' + accepted_by/at` + `members(role=invitation.role)` + 给 user 在该 org 起一个 human `agents` 行 → 跳进 `/welcome`

### 4.4 Stage 1 · 向导 1/4 · 连接你的电脑

进度条 `1 / 4 · Connect Computer`。

1. **介绍**:"First Tree Hub 通过你机器上的 agent CLI(目前 Claude Code,Codex 等接入中)执行任务"
2. **Prerequisite 双检查**:`node -v && claude --version && claude auth status`
   - 任一失败按 OS 给修复命令(brew / apt / nvm + Claude Code 安装脚本)
   - macOS / Linux 一键命令;Windows 显式不支持,banner 提示走 WSL
3. **Web 生成 connect token**(10–15 分钟有效)+ 一键复制完整命令:
   ```bash
   npm install -g @agent-team-foundation/first-tree-hub
   first-tree-hub connect --token eyJhbG...
   ```
4. CLI 单条命令完成:token 兑换 → 写 `client.yaml` → 装后台服务 → 启动 daemon → WS 连官方 hub
5. **Web 实时反馈**:"Waiting for your computer..." → 检测到 `clients` 行 `status=connected` → "✅ Alex's MacBook Air 已连接"

**失败恢复**(P0):60s 没连上展开 troubleshoot 折叠面板;token 过期自动 `[ Generate new token ]`;CLI 端错误回写 server,Web 拉来显示人话错误

> **复用代码**:[connect.ts](../packages/command/src/commands/connect.ts)、[resolver.ts](../packages/shared/src/config/resolver.ts) 的 `client.yaml` 写入、launchd/systemd 服务安装(已有)
> **新增**:Web 上的 connect token 生成 UI、轮询 client 上线、`first-tree-hub connect` 默认指向官方域名

### 4.5 Stage 2 · 向导 2/4 · 创建第一个 Agent

进度条 `2 / 4 · Create Agent`。复用 [`NewAgentDialog`](../packages/web/src/components/new-agent-dialog.tsx),内嵌进向导:

1. **Agent name**(自动 slugify);冲突时实时提示并自动建议附加 4 位随机短码
2. **Where it runs**:Stage 1 的 client(自动选中);多机器时给下拉
3. **Powered by**:Claude Code(默认 / 当前唯一);Codex / OpenCode disabled · "coming soon"
4. **高级**(可折叠):model、prompt 模板。默认值用 PR [#161](https://github.com/agent-team-foundation/first-tree-hub/pull/161) 引入的 opus + 通用 prompt
5. 提交 → 后端创建 `agents` 行 → server 推 `agent:pinned` → daemon 拉起 Claude Code → Web 显示 "✅ Agent online"

**Agent 状态机**:`creating → pinning → starting → online / failed`,失败把 daemon 错误翻译成人话

### 4.6 Stage 3 · 向导 3/4 · 进入 Workspace

进度条 `3 / 4 · Workspace`。**最低成本版本**:不要求用户真发消息,进 Workspace 就算完成。

1. Stage 2 完成 → 直接进 Workspace,左侧已选中刚创建的 agent
2. 输入框 `placeholder` 写 `Try: "介绍一下你能做什么"` — 仅 hint,不强制
3. **进 Workspace 那一刻就算 Stage 3 完成**:`onboarding_state.current_step = 'invite_team'` 自动推进
4. 顶部出现 `[ Continue → Invite Team ]` 按钮

> **本期不追求 aha**,先跑通流程;v2 升级方向:agent 主动 seed 欢迎消息 / 任务示例卡片(类 Claude.ai)/ 对话式配置 agent 生成 append system prompt

### 4.7 Stage 4 · 向导 4/4 · 邀请队友(可跳过)

进度条 `4 / 4 · Invite Team`。

1. 邮箱输入框(支持多邮箱)+ 角色默认 member + 点 `Send invites`
2. 后端为每邮箱建一行 `invitations(email NOT NULL, role, token, expires_at = now+7d)` → 发邮件
3. 受邀人路径走 §4.3.2(B1 / B2 任一)
4. `Skip for now` 完成向导 → 关闭进度条 → 进入正常 Workspace

### 4.8 Stage 5 · 日常使用

向导关闭后:
- **Web 是主舞台**:agent 列表、对话、邀请新成员、配 prompt/model
- **CLI 第一次 connect 之后不再用**,后台 service 永久运行
- **加机器**:Settings → Computers → `Add another computer` → 重复 Stage 1
- **切 org**:顶部 org switcher;加新 org 只能通过邮件邀请
- **重新走向导**:Settings → `[ Restart onboarding ]`(P2-18)
- **绑外部 IM**:Feishu / Slack adapter(已存在,不在 onboarding 范围)

---

## 5. 数据模型变更(M0 前置)

### 5.1 `users` — 改造

| 字段 | 改动 | 说明 |
|---|---|---|
| `email` | **新增** UNIQUE NOT NULL | 账号主标识,所有登录方式按 email 归并 |
| `email_verified_at` | **新增** timestamptz nullable | OTP 验证 / GitHub 已校验 email 时设置 |
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

email OTP 不进 auth_providers(它本身就是 email 一致性校验,等价于本地 provider)。

### 5.3 `invitations` — 新增

每行必须绑定具体邮箱(decision 2.3)。

```
invitations (
  id               uuid v7 PK
  organization_id  uuid → organizations.id
  email            text NOT NULL    -- 目标邮箱;accept 时必须与登录账号 email 匹配
  token            text UNIQUE      -- url-safe base64,邀请链接里的 <token>
  role             text             -- 'admin' | 'member'
  invited_by       uuid → users.id
  expires_at       timestamptz      -- 默认 7 天
  accepted_at      timestamptz nullable
  accepted_by      uuid → users.id nullable
  status           text             -- 'pending' | 'accepted' | 'expired' | 'revoked'
  created_at
  INDEX(organization_id, status), INDEX(email, status)
)
```

### 5.4 `members.onboarding_state` — 新增字段

| 字段 | 改动 | 说明 |
|---|---|---|
| `onboarding_state` | **新增** JSONB nullable | `{ current_step, completed_steps[], dismissed_at }`。**按 user × org 维度**,而非按 user(P0-5)。Bob 在 Acme 走完 Stage 1 后被邀进 Beta,Beta 的 state 为空,但他可共享已连过的机器跳过 Stage 1 |

### 5.5 数据迁移

存量自部署用户(`users` 已有记录但无 email)→ 迁移脚本不一次性回填;首次升级后引导补 email + OTP 验证。SaaS 新用户从开始就走新流程,不受影响。

**影响面**:
- 后端:`packages/server/src/db/schema/{users,members}.ts`、`packages/server/src/services/auth.ts`、`packages/server/src/api/auth.ts`
- 共享:`packages/shared/src/schemas/{user,auth,member}.ts`
- 前端:`packages/web/src/auth/auth-context.tsx` 的 user / member 类型

---

## 6. 风险与对策

### 6.1 P0 · 必修(不修产品挂)

| # | 风险 | 对策 |
|---|---|---|
| P0-1 | Stage 1 没检查 Claude Code 已 `claude login` → Stage 3 第一句对话直接挂,无线索 | Prerequisite 双检查 `claude --version` + `claude auth status`,失败给具体修复命令 |
| P0-2 | 邀请发出后无入口看待接受 / revoke / resend | Settings → Members → Pending Invitations 列表 + revoke / resend / 复制链接 |
| P0-3 | Onboarding 中途关浏览器后回来从头开始或被跳过 | `members.onboarding_state` 持久化进度,Web 进 `/` 时 reroute 回向导 |
| P0-4 | Stage 1 token 过期 / 超时 / firewall 拦截无恢复路径 | 60s 没连上展开 troubleshoot 面板 + token 过期自动 `[ Generate new token ]`;CLI 错误回写 server |
| P0-5 | 老用户被邀进新 org 时**重复看到全部向导**(他在前一个 org 已经走过 Stage 1 装 CLI) | onboarding_state 按 **user × org** 维度,挂 `members` 表;Bob 的 Beta org 自动跳过 Stage 1 |
| P0-6 | 当前 Layout 假设有 currentOrg,**0 membership 用户页面崩** | RequireAuth 后按 membership 数量分流(0 → `/workspaces`;1 → 自动进;>1 → switcher) |

### 6.2 P1 · 强烈建议(本期做)

| # | 风险 | 对策 |
|---|---|---|
| P1-7 | Prerequisite 没装时提示太干 | OS 自动给 `brew` / `apt` / `nvm` + Claude Code 官方安装脚本 |
| P1-8 | Stage 2 → 3 之间 agent 启动几秒延迟 + 失败处理 | Agent 状态机 + 启动失败时把 daemon 错误翻译成人话 |
| P1-9 | Org name / agent name 冲突 | 实时校验 + 自动建议(附加 4 位随机短码) |
| P1-10 | Welcome email 缺失 | 1 封 welcome 邮件;nudge / re-engage 后续迭代再加 |
| P1-11 | 多 org 顶部 switcher 缺失 | 顶部下拉 + `+ Create organization` 入口 |
| P1-12 | Stage 2 → 3 跳转时 agent 还在 starting,先显示"No agents"再突然出现 | "Your agent is starting..." spinner 直到 `agent.status === 'online'` |

### 6.3 P2 · 次重要(本期最小占位)

| # | 风险 | 对策 |
|---|---|---|
| P2-13 | 移动端打开做不下去 | Banner "Best experienced on desktop";不阻断登录 |
| P2-14 | ToS / Privacy 未链接 | 注册按钮下加 "By continuing you agree to [ToS] / [Privacy]" 占位页 |
| P2-15 | Workspace 隐私说明缺失("我的代码会被发到哪") | Workspace 折叠 "Privacy & Data Flow" 短文 + 链到独立页 |
| P2-16 | CLI 长期升级路径不明 | Web 顶部检测过期 banner;自动升级延后 |
| P2-17 | 跳过向导后无重启入口 | Settings 加 `[ Restart onboarding ]` 按钮 |

### 6.4 推迟 · 本期不做

- Activation funnel 埋点(decision 2.5)
- Cross-device session 管理(查活跃登录 / 远程登出)
- Welcome 之外的 nudge 邮件序列(stuck-at-stage / re-engage)
- Cookie banner / GDPR 合规

---

## 7. 实施计划

### 7.1 里程碑

| M | 内容 | 工程量 |
|---|---|---|
| **M0** | Schema 迁移:`users.email` + `auth_providers` + `invitations` + `members.onboarding_state` | 后端 1d |
| **M1** | Stage 0 注册:GitHub OAuth + Email OTP API + welcome email(P1-10) | 后端 2d |
| **M2** | Stage 0.5 `/workspaces`:创建 org / pending invitations 卡片 + 顶部 org switcher(P1-11) + Layout 0 membership 分流(P0-6) | 前端 2d |
| **M3** | Stage 1 Connect 向导:Web token + CLI 简化 + prerequisite 双检查(P0-1, P1-7)+ 失败恢复(P0-4) | 前后端 2d |
| **M4** | Stage 2 Agent 向导:复用 NewAgentDialog + agent 状态机 + 启动 spinner(P1-8, P1-12)+ name 冲突建议(P1-9) | 前后端 1.5d |
| **M5** | Stage 3 Workspace + Stage 4 邀请发送 | 前端 1d |
| **M6** | 邀请管理:Pending Invitations 列表 + revoke/resend(P0-2) | 前后端 1.5d |
| **M7** | Onboarding 状态持久化:`members.onboarding_state` 读写 + 跨 org 跳过逻辑(P0-3, P0-5) | 前后端 1.5d |
| **M8** | 收尾:ToS 占位 + 移动端 banner + 隐私说明 + CLI 版本提示 + 重启入口(P2 全部) | 1.5d |
| **M9** | 隐藏 self-host 命令(`hidden: true`) | 0.5d |

**合计**:~14 工程日(单人全力 ~3 周)

### 7.2 上线策略

- **必须串行**:M0 → M1 → M2 → M3(schema → auth → workspaces → connect)
- **可并行**:M4 / M5 / M6 / M7 在 M3 之后可分头推进
- **收尾**:M8 / M9 在主流程稳定后并入

### 7.3 与 Multica 的对照

| 维度 | Multica | First Tree Hub(本方案) |
|---|---|---|
| 注册 | OAuth via browser | GitHub OAuth + Email OTP |
| 一行命令 | `multica setup` | `first-tree-hub connect --token=...` |
| Runtime 探测 | daemon 自动探测 | 同样自动探测 |
| Agent 创建 | Web Settings → Agents | Web 向导 Stage 2(复用 NewAgentDialog) |
| 第一个任务 | 创建 issue 分配给 agent | Workspace 直接对话(本期最低成本版) |
| Web vs CLI | Web 主,CLI 是 daemon | 同样 Web 主导 |

---

## 8. 开放问题

| # | 问题 | 阻塞里程碑 |
|---|---|---|
| Q1 | **邮件发件服务商**选型(Resend / SES / Postmark)+ 发件域 SPF/DKIM/DMARC 配置 | M1(welcome email)、M5(邀请邮件) |
| Q2 | **GitHub OAuth App 申请**:运维侧创建 dev / staging / prod 各一份;callback URL `https://hub.first-tree.ai/api/v1/auth/github/callback`;scopes `read:user` + `user:email` | M1 |
| Q3 | **域名 DNS 配置**:`hub.first-tree.ai` 的 A/AAAA + 邮件 MX 记录 | 上线前 |

---

## 附录 · 关键代码引用

| 路径 | 用途 |
|---|---|
| [packages/command/src/commands/connect.ts](../packages/command/src/commands/connect.ts) | CLI connect 入口(Stage 1 复用) |
| [packages/shared/src/config/resolver.ts](../packages/shared/src/config/resolver.ts) | `client.yaml` 写入、`FIRST_TREE_HUB_HOME` |
| [packages/web/src/components/new-agent-dialog.tsx](../packages/web/src/components/new-agent-dialog.tsx) | Stage 2 复用 |
| [packages/web/src/components/last-step-modal.tsx](../packages/web/src/components/last-step-modal.tsx) | Stage 1 复用(token 生成 + 轮询) |
| [packages/web/src/auth/auth-context.tsx](../packages/web/src/auth/auth-context.tsx) | Auth state(需扩 user / memberships) |
| [packages/server/src/services/agent.ts](../packages/server/src/services/agent.ts) | Rule R-RUN(`clients.user_id == jwt.userId` 强制,2.1 服务端兜底) |
