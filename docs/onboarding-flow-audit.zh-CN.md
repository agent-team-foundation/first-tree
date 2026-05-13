# Onboarding 流程现状梳理与优化建议

> 范围：First-Tree Hub 当前线上 (`origin/main` @ `e03f410`) 的 onboarding 完整流程、核心 UI、admin/member 差异，以及在审阅过程中识别出的问题与改进建议。
>
> 阅读对象：参与 onboarding/Settings 改造的产品与工程同学。
>
> 关联文档：
> - `docs/new-user-onboarding-design.md` — 早期设计文档（部分细节已演进）
> - `docs/team-page-product-design.zh-CN.md` — Team 页设计
> - `docs/user-facing-context-tree-ui-design.zh-CN.md` — Context Tree 设计

---

## 第一部分 — 当前完整 Onboarding 流程

### 1. 总体架构

#### 1.1 两套并行的状态变量

| 变量 | 存储 | 写入方 | 控制 |
|---|---|---|---|
| `onboardingStep` | **不持久化**，server 每次 `/me` 现算 | 推断自 `clients` / `agents` 表 | 渲染哪一步内容 |
| `users.onboarding_dismissed_at` | DB `users` 表 timestamptz | 用户点 ✕ 或 "I'll do it later" | 是否显示 stepper |

**关键解耦**：Step 2 完成后 `onboardingStep` 已经是 `"completed"`，但 Step 3 还要走完——靠 `dismissed_at` 单独控制 stepper 显示。

#### 1.2 `onboardingStep` 推断规则

`packages/server/src/api/me.ts` `inferOnboardingStep()`：

```
无 client                     → "connect"
有 client，无 agent           → "create_agent"
有 client，有 non-human agent  → "completed"
```

#### 1.3 Step 枚举

`packages/shared/src/schemas/me-extras.ts`：

```ts
z.enum(["connect", "create_agent", "completed"])
```

#### 1.4 sessionStorage 瞬态标记

`packages/web/src/utils/onboarding-flags.ts`：

| Key | 含义 |
|---|---|
| `onboarding:joinPath` | `"solo"` 或 `"invite"`，决定走 admin 还是 member 流程 |
| `onboarding:step1Confirmed` | Step 1 已确认 |
| `onboarding:agentUuid` | Step 2 创建的 agent UUID（Step 3 找回用） |
| `onboarding:draft:{scope}` | 表单草稿恢复 |

---

### 2. 入口分叉：Solo vs Invite

OAuth 回调时 server 决定路径，写入 redirect URL fragment：

```
#access=...&refresh=...&joinPath=solo|invite
```

| joinPath | 触发 | role |
|---|---|---|
| `solo` | 新用户走 GitHub OAuth，自动建 `{login}'s team` | **admin** |
| `invite` | 用户点邀请链接 → `/organizations/join?token=...` | **member** |

`OAuthCompletePage` 把 `joinPath` 写入 sessionStorage，`OnboardingView` 挂载时读出来用。

---

### 3. Step 1 — Name Your Team

| 维度 | Admin（solo） | Member（invite） |
|---|---|---|
| 是否显示 | ✅ | ❌ 跳过 |
| Gate 代码 | `onboardingStep === "connect" && !step1Confirmed && joinPath !== "invite" && role === "admin"` | 条件不满足 |
| UI | 单输入框 + Continue 按钮 | 直接进 Step 2 |
| 默认值 | `{login}'s team`（auto-generated） | — |

**提交流程**：
1. 名字若变更 → `PATCH /orgs/{id} { displayName }`
2. `writeStep1Confirmed(true)` → sessionStorage flag
3. URL 去掉 `?step=team` 参数
4. `OnboardingView` 重渲染进 Step 2

**Telemetry**：`reportOnboardingEvent("team_renamed")` if name differs from seed

---

### 4. Step 2 — Set Up Your Agent

**Admin 和 member 行为完全相同**，仅文案差异。

#### 4.1 Phase A — Form

显示两个输入区：

1. **Agent Name**
   - 默认 "Assistant"
   - 支持草稿恢复

2. **Connect Computer**
   - 显示 CLI 命令：
     ```
     npm install -g @agent-team-foundation/first-tree-hub
     first-tree-hub connect <TOKEN>
     ```
   - 后台每 3s 轮询 `listClients()`
   - 连上后自动检测 capabilities
   - Runtime 自动选：Claude Code > Codex > 第一个可用

**Create 按钮可点条件**：
```
agentName.trim() && connectedClient && selectedRuntime && phase === "form"
```

#### 4.2 Phase B — Creating

- `POST /agents { type: "personal_assistant", displayName, name, clientId, runtimeProvider, gitRepos: [] }`
  - ⚠️ **`gitRepos: []` 是有意为之**——repo 绑定推到 Step 3
- 每 1s 轮询 `/agents/{uuid}/client-status`，最多 30s
- Loading copy："Creating {agentName}…"

#### 4.3 Phase C — Timeout

- 30s 没上线 → 显示故障排查清单 + Try again

#### 4.4 完成

- 清草稿
- `refreshMe()` → `onboardingStep` 翻成 `"completed"`
- navigate 回 `/`
- 触发 Step 3
- `reportOnboardingEvent("agent_created", { runtimeProvider })`

#### 4.5 Member 文案差异

如果 `joinPath === "invite"`，标题文案变成："You've joined {teamName}. Set up your first agent..."

---

### 5. Step 3 — Build Context-Tree（**最大的角色分叉**）

入口路由 `step3-intro-body.tsx:55`：

```ts
export function Step3IntroBody() {
  const { role } = useAuth();
  if (role === "admin") return <AdminBindCreateBody />;
  return <InviteeStep3Body />;
}
```

#### 5.1 Admin 路径：`AdminBindCreateBody`

**用户体验**：完全控制权——选 repos，决定 bind/create，写团队级 settings。

**UI 结构**（三个 StepFrame）：
1. **Pick source repos** — 多选 GitHub repo（按 owner 分组的 popover）
2. **Bind or create the tree** — segmented toggle：
   - "Bind to an existing tree" → URL 输入框（仅 https）
   - "Create a new tree" → 文案说明 agent 会 scaffold 新 repo
3. **Let your agent build it** — Continue / I'll do it later

**提交流程**（`handleContinue`）：
```ts
1. resolveOnboardingAgent()
2. updateAgentConfig(agent.uuid, { gitRepos: [...] })  // 个人 agent
3. PUT /organizations/{id}/settings/source_repos { repos } // 团队级（catch warn）
4. PUT /organizations/{id}/settings/context_tree { repo }  // 团队级（catch warn + toast）
5. createAgentChat(agent.uuid) → chatId
6. sendChatMessage(chat.id, bootstrap) // catch swallow
7. reportOnboardingEvent("tree_chat_started", { treeMode })
8. dismissOnboarding()
9. navigate(`/?c=${chatId}`)
```

**预填**：进入页面会拉当前 org 的 `context_tree` setting，如果已设置则预填 URL + 默认选择 "Bind"。

#### 5.2 Member 路径：`InviteeStep3Body`

进入后并行 fetch `context_tree` + `source_repos`，按 admin 完成度分四个分支：

| 状态 | 渲染组件 | 用户体验 |
|---|---|---|
| ✅ tree + ✅ repos | `InviteeConfirmBody` | 显示团队 tree URL（只读）+ 预选 repos（可取消勾），一键 Confirm |
| ✅ tree + ❌ repos | `InviteePickerBody` | 团队 tree URL 只读；自己挑个人 repos（**不写团队设置**） |
| ❌ tree | `InviteeWaitingBody` | 文案 "Your team admin hasn't finished setup"；自动 dismiss + toast |
| 加载中/错误 | `InviteeLoadingBody` / `InviteeLoadErrorBody` | 标准 loading/error |

**关键差异**：member 永远不写 `context_tree` 或 `source_repos` 团队级 settings，只配自己 personal agent。

**InviteeConfirmBody 提交流程**：
```ts
1. resolveOnboardingAgent()
2. updateAgentConfig(agent.uuid, { gitRepos: chosenRepoUrls })
3. createAgentChat(agent.uuid) → chatId
4. sendChatMessage(chat.id, buildBindBootstrap(...))
5. reportOnboardingEvent("tree_chat_started", { treeMode: "existing", joinPath: "invite" })
6. dismissOnboarding()
7. navigate(`/?c=${chatId}`)
```

---

### 6. Settings → Onboarding tab 的交互

`pages/settings/onboarding.tsx` 是 onboarding 的逃生口。

| 按钮 | 显示条件 | 调用 |
|---|---|---|
| **Resume onboarding** | 已 dismissed | `PATCH /me/onboarding { dismissed: false }` |
| **Hide onboarding guide** | 未 dismissed，且 `onboardingStep === "completed"` | `PATCH /me/onboarding { dismissed: true }` |

`canHide` gate 与 stepper ✕ 保持一致——避免出现"stepper 上 ✕ 不让点，但 Settings 里能 hide"的不对称。

**不区分 admin/member**：`dismissed_at` 是 `users` 表上的列，每个用户独立管理自己的 stepper 显示。

---

### 7. Settings tab 整体结构（与 onboarding 相关）

`packages/web/src/pages/settings.tsx` 定义 5 个子 tab：

| Tab | 路由 | Admin | Member |
|---|---|---|---|
| Team | `/settings/team` | 完整 + 可写 | 仅 SourceReposSettingsPanel（只读） |
| Computers | `/settings/computers` | ✅ | ✅ |
| GitHub | `/settings/github` | ✅ | **侧栏隐藏 + 直链跳走** |
| Messaging | `/settings/integrations` | ✅ | ✅ |
| Onboarding | `/settings/onboarding` | ✅ | ✅ |

#### 7.1 Team tab 内部（`org-settings.tsx`）

```tsx
{isAdmin && <TeamIdentityPanel isFirst />}        // ① Team 名称
{isAdmin && <ContextTreeSettingsPanel />}         // ② Context Tree 绑定
<SourceReposSettingsPanel isFirst={!isAdmin} />   // ③ Source Repos（member 只读）
```

**Member 在 Team tab 只看到 source repos 列表**，没有 Remove 按钮，文案为 "Read-only — only admins can edit."

---

### 8. 完整流程图

#### 8.1 Admin (Solo) 路径

```
GitHub OAuth
  ↓ server 自动建 team(admin), 写 joinPath=solo
OAuthCompletePage 写 sessionStorage
  ↓
WorkspacePage GET /me → onboardingStep=connect
  ↓
OnboardingView 路由 → Step 1（rename team）
  ↓ Continue
PATCH /orgs/{id} → step1Confirmed=true
  ↓
Step 2（接电脑 + 建 agent，gitRepos: []）
  ↓ Create 成功
refreshMe() → onboardingStep=completed
  ↓
Step 3 - AdminBindCreateBody
  → 选 repos + Bind/Create + Continue
  → updateAgentConfig + PUT source_repos + PUT context_tree
  → createAgentChat + sendChatMessage
  → dismissOnboarding()
  ↓
进入 Chat 与 agent 协作完成 tree init
```

#### 8.2 Member (Invite) 路径

```
点邀请链接 → /organizations/join?token=...
  ↓ POST /me/organizations/join
auth context 更新 + 写 sessionStorage joinPath=invite
  ↓
WorkspacePage GET /me → onboardingStep=connect
  ↓
OnboardingView 路由（gate 不满足，跳过 Step 1）
  ↓
Step 2（与 admin 完全相同）
  ↓ Create 成功
refreshMe() → onboardingStep=completed
  ↓
Step 3 - InviteeStep3Body
  ↓ fetch context_tree + source_repos
  ├ ✅ tree + ✅ repos → InviteeConfirmBody
  ├ ✅ tree + ❌ repos → InviteePickerBody
  ├ ❌ tree         → InviteeWaitingBody（自动 dismiss）
  └ 错误            → InviteeLoadErrorBody
  ↓
进入 Chat（已 dismiss）
```

---

### 9. Telemetry 事件总览

| 事件 | 触发位置 | 来源 |
|---|---|---|
| `team_created` | OAuth callback (solo) | server |
| `team_renamed` | Step 1 提交且名字变更 | client |
| `agent_created` | Step 2 成功 | client |
| `tree_chat_started` | Step 3 创建 chat 成功 | client |
| `tree_intro_dismissed` | Step 3 "I'll do it later" 或 InviteeWaitingBody 自动触发 | client |
| `dismissed` | 用户点 ✕ 或 "I'll do it later" | server |

接口：`POST /me/onboarding/events`（前端） / server 自动记录关键节点。

---

## 第二部分 — 已识别的问题与优化建议

> 按严重性分组。每条标注：**问题** → **位置** → **风险** → **建议**。

---

### 🔴 高严重性（影响正确性 / 数据一致性 / 安全）

#### P-1. `joinPath` 完全依赖 sessionStorage

- **问题**：`joinPath` 只在 OAuth 回调那个标签页存在；换标签、刷新清缓存、跨设备打开都会丢失。
- **位置**：`packages/web/src/utils/onboarding-flags.ts` + `onboarding-view.tsx:44`
- **风险**：admin 通过 invite 加入新 org（`joinPath="invite", role="admin"`）丢失 flag 后会被错误地走 solo admin 分支，跳过 invite-aware 的文案，可能误写团队设置。
- **决议（2026-05-13 讨论后）**：走**纯派生方案**，不加 DB 列，不引入新的服务端字段。核心思路：`joinPath` 在概念上是 UI 派生信号，不是持久事实——用 team 状态 + 成员状态本身去推导更稳。
  - **Step 1 gate** 改用 `canRenameTeam && teamHasDefaultName && !step1Confirmed`（移除对 `joinPath` 的依赖）
    - 副作用收益：solo admin 上次跳过 Step 1，今天回来想改名，新 gate 会正确再次显示（旧 gate 不会）
  - **Step 2 invite-aware 文案** 改用 `orgHasOtherMembers`（`COUNT(members) > 1`）
  - **sessionStorage 里的 `joinPath` 保留作为 telemetry tag**（best-effort），但所有路由 gate 不再依赖它
  - `teamHasDefaultName` 实现：直接做 pattern 匹配（`{login}'s team`）。如果未来默认 pattern 变更导致漏判再升级方案
- **替代方案（已否决）**：
  - 加 `members.joined_via` 列：分析维度其实已经在 telemetry 事件日志里有 `joinPath` attr，DB 列**无增量价值**；列加完之后除了 onboarding 几乎没人查
  - 加 `organizations.auto_created` boolean：比 pattern 匹配稳，但当前 pattern 稳定，先不预付成本

---

#### P-2. `onboardingStep` 按 DB 现算导致"倒退"

- **问题**：用户已完成 onboarding 多月后，删掉一台旧机器（`clients` 表条目删了），下次 `/me` 推断成 `connect`，stepper 重新出现。
- **位置**：`packages/server/src/api/me.ts` `inferOnboardingStep()`
- **风险**：UI 像出 bug；如果 `dismissed_at` 被 reset（例如用户点 Settings → Onboarding → Resume），整个 onboarding 会强制重弹，把已完成用户推回 Step 1。
- **决议（2026-05-13 讨论后）**：加 `users.onboarding_completed_at` 单 timestamp 列，与现有 `onboarding_dismissed_at` 模式对称。
  - **DB 改动**：
    ```sql
    ALTER TABLE users ADD COLUMN onboarding_completed_at TIMESTAMPTZ;
    ```
    Backfill：把目前推断为 `completed` 的用户全部打上 `now()`（或更精确地，查最近一次 client + agent 都齐全的时间）。
  - **`inferOnboardingStep` 改造**：
    ```ts
    function inferOnboardingStep(userId) {
      const user = users.findById(userId);
      if (user.onboardingCompletedAt) return "completed";  // 一旦完成永不回退
      
      const step = !hasClient ? "connect" : !hasAgent ? "create_agent" : "completed";
      
      // 第一次到 completed 时落库
      if (step === "completed" && !user.onboardingCompletedAt) {
        users.update(userId, { onboardingCompletedAt: new Date() });
      }
      return step;
    }
    ```
  - **关键 take**：只关心"completed → 倒退"这一个回归场景，因为：
    - 中间态（connect ↔ create_agent）停留时间短（分钟级）
    - 中间态如果用户真的删光所有 client/agent，引导他重接是合理的
    - 一旦走到 completed，就是**永久事实**，不该被资源临时缺失推翻
  - 副作用收益：这个 timestamp 后续做"完成后 7 天弹回访问卷"等运营功能时可直接复用
- **替代方案（已否决）**：
  - 加 `users.onboarding_max_step_reached` enum 列（单调递进）：颗粒度更细，但要维护 step 顺序比较函数；中间态精度对当前问题没有增量价值
  - 只在 `dismissed_at IS NULL` 且未完成过时推断：根本不解决问题——一旦 Resume 让 `dismissed_at = null`，立刻又回到现算逻辑

---

#### P-3. Step 3 admin 写两个 namespace 非原子

- **问题**：先写 `source_repos`，再写 `context_tree`，两次 PUT 不在同一 transaction，错误处理也不一致：

  ```ts
  // source_repos：失败仅 console.warn，无 toast
  try { await putSourceReposSetting(...) }
  catch (err) { console.warn(...) }

  // context_tree：失败 console.warn + toast
  try { await putContextTreeSetting(...) }
  catch (err) { console.warn(...); addToast({...}) }
  ```

- **位置**：`step3-intro-body.tsx:600–633`
- **风险**：
  - 出现 "repos 写了，tree 没写" 不一致状态——后续 invitee 进 `InviteePickerBody`（重选 repos）而非 `InviteeConfirmBody`，体验差异大
  - `source_repos` 失败完全无 UI 反馈
  - 即使 toast 弹了，用户错过就再也看不到
- **决议（2026-05-13 讨论后）**：走**纯前端错误处理统一**（Option C），不加服务端事务接口。核心判断：PUT 幂等 + retry 已经覆盖 99.9% 场景，剩下的极少数 admin 放弃场景影响小到不值得为它做事务。
  - **必做**：把三种不一致的 catch 统一——任何团队级写失败都阻塞流程（不进 chat、不 dismiss），让 admin 在原地看错误并 retry：
    ```ts
    try {
      await updateAgentConfig(agent.uuid, { gitRepos: repoEntries });
      await putSourceReposSetting(orgId, { repos: repoEntries });   // 失败抛
      if (treeMode === "existing") {
        await putContextTreeSetting(orgId, { repo: trimmedTreeUrl }); // 失败抛
      }
      const chat = await createAgentChat(agent.uuid);
      try { await sendChatMessage(chat.id, bootstrap); } catch { /* 真·non-fatal */ }
      void dismissOnboarding();
      navigate(`/?c=${chat.id}`);
    } catch (err) {
      setError(`Couldn't save team setup: ${err.message}. Please retry.`);
      setBusy(false);
      // 不 navigate, 不 dismiss
    }
    ```
  - **可选补强（可与 P-9 合并做）**：在 `OrgSettingsPage` / `Step3IntroBody` 加"不一致检测 banner"——`hasSourceRepos !== hasContextTree` 时显示 "Team setup is incomplete"。这个 banner 不需要新 schema，从已有状态推导即可
  - **关键 take**：PUT 的幂等性是这个方案能成立的基础——admin retry 一次系统就收敛，竞态窗口极小（几秒内 invitee 恰好进 Step 3 概率极低，且看到的也只是 UX 不 ideal，不是数据损坏）
- **替代方案（已否决）**：
  - **Option A：服务端原子 endpoint** `PATCH .../settings/onboarding-bundle`：边际收益太低（只多解决"admin 立刻关浏览器跑路"这一种场景），不值得引入新接口的维护成本
  - **Option B：`users.onboarding_pending_writes` 状态机**：状态清理逻辑复杂，且不一致状态本身可以从已有数据推导，不需要专门的列

---

#### P-4. Admin 通过 invite 加入新 org 时跳过 Step 1

- **问题**：Step 1 gate 是 `joinPath !== "invite" && canRenameTeam`。如果一个 admin 被邀请到新 org（少见但可能），会跳过 Step 1，即使他可能想给团队改名。
- **位置**：`onboarding-view.tsx:69`
- **建议**：把条件改成 "team 名是默认 auto-generated 且 role=admin" 才显示 Step 1，更稳健。

---

#### P-5. dev-callback 路径需要严格 production 防护

- **问题**：`/api/v1/auth/github/dev-callback` 接受任意 `githubId` 和 `login`，绕过 OAuth。
- **位置**：`packages/server/src/api/auth/github.ts`
- **风险**：误装在 production 是严重安全漏洞。
- **建议**：
  - `if (process.env.NODE_ENV === "production") return 404`
  - 或编译时 flag 完全摘除
  - 至少 startup log 警告

---

### 🟡 中严重性（影响体验 / 信息架构 / 功能缺失）

#### P-6. InviteeWaitingBody 自动 dismiss 后无回归引导

- **问题**：member 进来时 admin 还没配好 → 自动 `dismissOnboarding()` + toast。当 admin 后来配好了，member 不会被通知，要自己去 Settings → Onboarding 点 Resume。
- **位置**：`step3-intro-body.tsx:447–488`
- **建议**：
  - `/me` 响应中带上 `team_setup_pending: boolean`
  - member 端订阅这个字段变化，从 `true` 变 `false` 时弹 toast: "Your team is ready! Want to bind your agent to the tree?"
  - 或：不真正 dismiss，渲染 "waiting" 占位，配好后自动切换 Confirm

---

#### P-7. Step 2 完成后 `gitRepos: []`，"later" 后无明显回归路径

- **问题**：toast 说 "add one in Agent settings when ready"——但 Settings tab 里没有 Agent 子页（只有 Team / Computers / GitHub / Messaging / Onboarding），用户得点工作区某处的 agent 才能找到。
- **位置**：`step3-intro-body.tsx:861` + Settings 信息架构
- **建议**：
  - toast 给具体 deep link 而非泛泛 "Agent settings"
  - Settings 加 "Agents" sub-tab 集中管理用户名下的 agent
  - dashboard 加明显的 "Your agent isn't bound to any repo" 提示卡片

---

#### P-8. Settings 里 "Messaging" 名称 vs `/integrations` 路径不一致

- **问题**：路由 `integrations`（更通用），label `Messaging`（只覆盖 IM）。GitHub 集成又被搬出去了。暗示历史命名遗留，未来加非 IM integration 会混乱。
- **位置**：`settings.tsx:39`
- **建议**：
  - 改成 `/settings/messaging` 路由+label 统一
  - 或保留 `/integrations` 但 label 改 "Integrations"，把 GitHub 也搬回来

---

#### P-9. Team tab 对 member "名不副实"

- **问题**：member 进入 Team tab 只看到 SourceReposSettingsPanel 一个只读 panel。tab 名 "Team" 但内容只有 source repos，找不到团队成员、自己的 role、加入时间。
- **位置**：`org-settings.tsx`
- **建议**：
  - 给 member 加 "Team members" 只读列表
  - 显示当前用户的 role 和加入时间
  - 或改 tab 名为 "Team & Repos"

---

#### P-10. 缺失核心 Settings tab

| 缺失 | 影响 |
|---|---|
| **Profile** | 改头像、display name、密码？目前没地方做 |
| **Members / Invites** | admin 怎么邀请人、撤销邀请、改 role、踢人？ |
| **Notifications** | 通知偏好、邮件订阅 |
| **API tokens** | 集成第三方时需要 |
| **Billing** | 长远商业化 |

- **建议**：至少 Profile 和 Members 是必需的——前者是用户自服务的最低期待，后者是 admin 管理团队的入口。

---

#### P-11. role 是二元（admin/member），没有 owner

- **问题**：org 创建者和后续 promote 的 admin 没有区分。如果原 admin 离开，谁来 transfer ownership？billing 责任人是谁？
- **建议**：加 `owner` role（exactly 1 per org），admin 是 owner 之外可扩展的管理角色。Settings → Members 支持 transfer ownership。

---

#### P-12. Context Tree 设置嵌在 Team tab 内（已讨论，暂不改）

- **现状**：是 Team tab 的一个 panel，不是独立 sub-tab。
- **观察**：当前有 4 个并行 worktree 在做 context tree（`context-tab` / `context-tree-remote-sync` / `context-overview-map` / `context-ui`），暗示这块在膨胀。
- **建议**：当 Context Tree 设置项数量增长（多 tree 管理、sync 状态、历史等），拆成独立 `/settings/context-tree` sub-tab，admin-only gate 复用 GitHub tab 的双保险模式。

---

### 🟢 低严重性（文档 / 小一致性 / 技术债）

#### P-13. CLAUDE.md 里 "Set up your first agent" modal 实际不是 modal

- **问题**：CLAUDE.md 提到一个 modal，但代码里实际是 Step 3 IntroBody（一个内联面板）。
- **建议**：更新 CLAUDE.md，避免新人/agent 找错。

---

#### P-14. `step1Confirmed` sessionStorage flag 永不清理

- **问题**：写一次永久存在。理论上没事但有 flag 漂移风险。
- **位置**：`onboarding-flags.ts`
- **建议**：在 Step 3 dismiss 时一并清掉所有 `onboarding:*` flag。

---

#### P-15. 错误处理 silent swallow 太多

- **问题**：bootstrap message 失败时静默吞掉，用户进了空 chat 不知道为什么 agent 没动作：
  ```ts
  try { await sendChatMessage(chat.id, bootstrap); }
  catch { /* intentionally non-fatal — user lands in the empty chat */ }
  ```
- **位置**：`step3-intro-body.tsx:200–202, 363–365, 642–644`
- **建议**：失败时至少在 chat 里显示一条 system message 提示 "Bootstrap failed, please tell your agent: '请帮我初始化 context tree'"。

---

#### P-16. `resolveOnboardingAgent()` fallback 可能选错 agent

- **问题**：用户清缓存后，stashed UUID 失效，回退到 "最近创建的非 human agent"——如果用户已手动建了别的 agent，可能选错。
- **位置**：`step3-intro-body.tsx:847`
- **建议**：把 onboardingAgent UUID 持久化到 server-side（如 `users.onboarding_agent_id`），不依赖 sessionStorage。

---

#### P-17. `teamRepos` 的 useState 初始化只跑一次

- **问题**：注释里已经标注："If that invariant ever changes, add a useEffect that reconciles chosenRepoUrls when teamRepos identity changes." 是已知技术债。
- **位置**：`step3-intro-body.tsx:179`
- **建议**：当未来 `InviteeStep3Body` 加上对 `team_setup_pending` 的实时订阅（参见 P-6），这里务必同步加 `useEffect` 协调。

---

## 整改优先级建议

| Sprint | 处理项 |
|---|---|
| **P0（这周）** | P-2 onboardingStep 倒退、P-3 非原子写、P-5 dev-callback 防护 |
| **P1（下周）** | P-1 joinPath 持久化、P-6 invitee 等待回归、P-10 Profile + Members tab |
| **P2** | P-4 admin invite 跳 Step 1、P-7 Step 2 后回归路径、P-11 owner role |
| **P3（清理）** | P-8 命名一致性、P-9 Team tab 信息丰富、P-12 Context Tree 拆分、P-13–17 文档与小修 |

---

## 附：关键文件索引

| 用途 | 路径 |
|---|---|
| Onboarding 状态类型 | `packages/shared/src/schemas/me-extras.ts` |
| Server 推断逻辑 | `packages/server/src/api/me.ts` |
| Users 表 schema | `packages/server/src/db/schema/users.ts` |
| 前端 auth context | `packages/web/src/auth/auth-context.tsx` |
| Session flags | `packages/web/src/utils/onboarding-flags.ts` |
| OnboardingView 路由 | `packages/web/src/pages/workspace/center/onboarding-view.tsx` |
| Step 1 Body | `packages/web/src/pages/workspace/center/onboarding/step1-body.tsx` |
| Step 2 Body | `packages/web/src/pages/workspace/center/onboarding/step2-body.tsx` |
| Step 3 路由+admin/invitee 实现 | `packages/web/src/pages/workspace/center/onboarding/step3-intro-body.tsx` |
| Settings 主布局 | `packages/web/src/pages/settings.tsx` |
| Settings → Onboarding | `packages/web/src/pages/settings/onboarding.tsx` |
| Settings → Team | `packages/web/src/pages/org-settings.tsx` |
| OAuth 回调（前端） | `packages/web/src/pages/oauth-complete.tsx` |
| OAuth 回调（后端） | `packages/server/src/api/auth/github.ts` |
| Telemetry 上报 | `packages/web/src/api/onboarding-events.ts` |

---

*Last reviewed against `origin/main` @ `e03f410` (2026-05-13).*
