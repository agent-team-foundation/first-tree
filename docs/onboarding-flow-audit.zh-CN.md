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

#### P-2. 建模 onboarding 终态（revised）

- **真正的问题**（2026-05-13 三次审视后澄清）：当前系统**没有 onboarding 终态**——`onboardingStep` 永远返回值、`dismissed_at` 只表达"暂时隐藏 UI"、没有"setup 已完成"的语义层。导致：
  1. Settings → Onboarding tab 永远存在，老用户也看得到
  2. "Resume onboarding" 按钮永远可用，但点了之后行为模糊
  3. Step 3 完成的用户点 Resume → 又看到 Step 3 IntroBody（已做完的事重看一遍）
  4. 没有"毕业"反馈，跟"3 个一次性首次配置 Step"的设计意图脱节
- **位置**：`packages/server/src/api/me.ts` + `packages/web/src/pages/settings.tsx` + `packages/web/src/pages/settings/onboarding.tsx` + Step 3 两处 handler
- **决议（2026-05-13 讨论后）**：加 `users.onboarding_completed_at` 字段，**用作 UI surface gate**（而不是改 `inferOnboardingStep`）。这样 Resume 入口本身消失，wizard 重入路径被关闭，onboarding 真正"结束"。
  - **DB 改动**：
    ```sql
    ALTER TABLE users ADD COLUMN onboarding_completed_at TIMESTAMPTZ;
    ```
    Backfill：把 `dismissed_at IS NOT NULL` 的用户全部打上 `dismissed_at` 同值（保守做法，最坏是个别早期 dismiss 的用户失去 onboarding tab 入口，但他们本来也不用）
  - **Step 3 success 处写入**（admin 的 `handleContinue` + invitee 的 `handleConfirm`）：
    ```ts
    await markOnboardingCompleted();  // PATCH /me/onboarding-completed → set users.onboarding_completed_at = now()
    ```
  - **Settings 侧栏 gate**（`settings.tsx`）：
    ```tsx
    {!user.onboardingCompletedAt && (
      <SubNavLink to="/settings/onboarding" label="Onboarding" />
    )}
    ```
  - **Settings → Onboarding 页面守卫**（`settings/onboarding.tsx`）：
    ```ts
    if (user.onboardingCompletedAt) return <Navigate to="/settings/team" replace />;
    ```
  - **`inferOnboardingStep` 不改动**——保留它"基于当前资源状态"的语义，但**它不再决定 Settings 入口的可见性**
- **效果**：
  - 完成 Step 3 → `completed_at` 落库 → Settings 侧栏的 "Onboarding" 入口消失，Resume 路径消失
  - 用户想改 team / agent / repos → 走专门的 Settings → Team / Computers / `/agents/:uuid`
  - 没完成的用户行为不变（保留 Resume 路径作为恢复入口）
- **关键 take**：这条修复跟之前一次 won't-fix 决议看似矛盾，其实方案变了——
  - **当时 P-2**：改 `inferOnboardingStep` 让 step 一旦 completed 永不回退（影响 wizard 行为）→ 会让 Resume + 没 client 的用户体验变差
  - **现在 P-2 revised**：不动 `inferOnboardingStep`，只用 `completed_at` 关 UI 入口 → Resume 路径整个消失，谈不上"Resume 后看哪个 Step"的问题
- **备份路径**（万一未来需要）：
  - Hidden URL `?onboarding=replay` 给运营或客服用
  - 或在 Settings → Team 加不显眼的 "Re-run setup guide" link
- **实施工作量**：~1.5 小时（DB migration + Step 3 两处 handler 写入 + Settings 两处 gate + 测试）

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
  - **关键 take**：PUT 的幂等性是这个方案能成立的基础——admin retry 一次系统就收敛，竞态窗口极小（几秒内 invitee 恰好进 Step 3 概率极低，且看到的也只是 UX 不 ideal，不是数据损坏）
- **替代方案（已否决）**：
  - **Option A：服务端原子 endpoint** `PATCH .../settings/onboarding-bundle`：边际收益太低（只多解决"admin 立刻关浏览器跑路"这一种场景），不值得引入新接口的维护成本
  - **Option B：`users.onboarding_pending_writes` 状态机**：状态清理逻辑复杂，且不一致状态本身可以从已有数据推导，不需要专门的列

---

#### P-4. Admin 通过 invite 加入新 org 时跳过 Step 1 ✅ Resolved by P-1

- **问题**：Step 1 gate 是 `joinPath !== "invite" && canRenameTeam`。如果一个 admin 被邀请到新 org（少见但可能），会跳过 Step 1，即使他可能想给团队改名。
- **位置**：`onboarding-view.tsx:69`
- **决议（2026-05-13）**：**已被 P-1 的派生方案覆盖**，不需要单独投入。
  - P-1 把 Step 1 gate 改为 `canRenameTeam && teamHasDefaultName && !step1Confirmed`，正好就是 P-4 建议的条件
  - 各场景验证：
    | 场景 | 行为 | 正确 |
    |---|---|---|
    | Admin invite 到已命名 team | 跳过 Step 1 | ✅（不需要改别人团队的名字） |
    | Admin invite 到还未改名的 team（极罕见） | 显示 Step 1 | ✅（团队确实需要正经名字） |
    | Solo admin 上次跳过 Step 1，今天回来 | 显示 Step 1 | ✅（给第二次机会，旧 gate 不会） |
  - **澄清**：P-4 原始描述里"admin 可能想给团队改名"略微误导——admin invitee 加入的是已命名团队，onboarding 阶段不需要改名；想改可以后续去 Settings → Team
- **排期影响**：从 P2 排期中移除，仅作为 P-1 的对照参考保留

---

#### P-5. dev-callback 路径需要严格 production 防护 ✅ Already resolved

- **审计原始描述**：`/api/v1/auth/github/dev-callback` 接受任意 `githubId` 和 `login` 绕过 OAuth；担心误装在 production 是严重安全漏洞。
- **位置**：`packages/server/src/api/auth/github.ts:231`
- **决议（2026-05-13 复查后）**：**已被现有代码完整覆盖，无需任何改动**。
  - 现有实现采用**双闸防护**：
    ```ts
    // Gate 1: NODE_ENV 不能是 production
    if (process.env.NODE_ENV === "production") return 404;
    // Gate 2: 必须显式 opt-in
    if (FIRST_TREE_HUB_DEV_CALLBACK_ENABLED !== "1" && !== "true") return 404;
    ```
  - 比 audit 原本"建议"的更严密：
    - 返回 404 而非 403（不确认路由存在）
    - 显式 opt-in 防御 `NODE_ENV` 漂移（注释里点明针对 codex P1-9 失败模式）
    - refuse 时 `log.info` 留痕
  - **审计反思**：P-5 是凭印象写的，没读现有代码就下了结论。下次 audit 要先确认代码现状
- **可选进一步加固（暂不推荐做）**：
  - Startup 时 enabled 状态打 loud warning
  - 强制 opt-in 仅在 `NODE_ENV` 显式为 `development` 或 `test` 时生效
  - 现有两闸覆盖主要风险面，剩下都是"操作员同时犯两个错"的复合场景，靠流程比靠代码更合适
- **排期影响**：从 P0 移除

---

### 🟡 中严重性（影响体验 / 信息架构 / 功能缺失）

#### P-6. InviteeWaitingBody 自动 dismiss 后无回归引导 ⏸ Deferred

- **问题**：member 进来时 admin 还没配好 → 自动 `dismissOnboarding()` + toast。当 admin 后来配好了，member 不会被通知，要自己去 Settings → Onboarding 点 Resume。
- **位置**：`step3-intro-body.tsx:447–488`
- **决议（2026-05-13 讨论后）**：**暂不修复，等通知系统重构后用通知方案落地**。
  - 讨论中评估了三类方案：
    - **Option A（前端订阅 + 自动接上）**：让 `InviteeWaitingBody` 不真正 dismiss，server 暴露 `teamSetupComplete` flag，前端 polling 自动切到 Confirm。**否决理由**：状态机复杂、polling 机制要新建、admin 久不配会留下永久 waiting 卡片
    - **Option B（dashboard banner）**：dismiss 不变，但用 banner 召回。**否决理由**：banner 又是一个新 UI surface，且 banner 漏看的概率不低于 toast
    - **Option C+（通知系统）**：admin 完成 PUT context_tree 时 server 给未完成的 member 发通知，点击 deep link 回 Step 3 Confirm。**最优方案，但被 deferred**
  - **为什么 defer**：现有通知系统正在规划重构，在旧通知系统上做这个事会做两遍——等新系统稳定后接入更合适
  - **临时缓解**：当前的 toast + Settings → Onboarding 手动 Resume 路径已经存在，不阻塞 invitee 使用 agent（虽然他们的 agent 没绑团队 tree）
- **触发重启信号**：notification 系统重构告一段落、新 notification type/deep-link 机制可用时，回来落地 Option C+
- **排期影响**：从 P1 移除，进 backlog（依赖通知系统重构）

---

#### P-7. Step 3 dismiss 后 toast 指向不一致

- **重新审视后的问题描述**（2026-05-13）：原 audit 把"agent 没绑 repo"框架成"Agent settings 缺失"是错的。**Step 3 的核心目的就是给 agent 绑 repo**，所以"I'll do it later"等于跳过 onboarding 最关键的一步，唯一的恢复路径就是 Settings → Onboarding → Resume → 重回 Step 3。
- **真正的 bug**：当前 `buildSetupHiddenToast` 的**文案和 action button 指向不一致**：
  ```ts
  description: "...add one in Agent settings when ready."  // 指向"Agent settings"（不存在）
  action: { label: "Open settings", → /settings/onboarding } // 实际跳 Settings → Onboarding（对的）
  ```
- **位置**：`step3-intro-body.tsx:861` `buildSetupHiddenToast`
- **决议（2026-05-13 讨论后）**：**仅修文案对齐**，不做附加 UI。
  - 改 `buildSetupHiddenToast`：
    ```ts
    description: "Your agent isn't bound to a source repo yet. Resume from Settings → Onboarding any time to finish.",
    action: { label: "Resume setup", onClick: () => navigate("/settings/onboarding") },
    ```
  - 5 分钟改完，文案与 action 一致，用户去 Settings → Onboarding 点 Resume 后会回到 Step 3，那里页面本身就会告诉他要 "Pick source repos"——按钮文案再优化的边际价值约为 0
- **替代方案（已否决）**：
  - **按 agent 状态动态切 Resume 按钮文案（如 "Bind your agent to a source repo"）**：差量价值只是按钮多 5 个字，但 Settings → Onboarding 页面要拉 agent config、多 loading state、多 agent 时按钮文案逻辑要再想，**ROI 不正**
  - **Dashboard 加 "Agent isn't bound" banner**：用户主动点了 later 是有意识地推迟，dashboard 上常驻提示反而干扰；他们去 Settings 找的时候能找到就行
  - **加 Settings → Agents sub-tab**：与 P-10 关联讨论时一并撤掉——这会把"绑 repo 这件事"从 onboarding 语义里拆出来，反而让用户困惑应该走 onboarding 还是 Agents tab

---

#### P-8. Settings 里 "Messaging" 名称 vs `/integrations` 路径不一致 ⏸ Won't fix unless triggered

- **核实后的事实**：
  - 文件 / 路由 / 组件：`integrations.tsx` / `/settings/integrations` / `IntegrationsPage`
  - 用户可见 label / header：**Messaging**（侧栏、页面 header 都是）
  - 实际内容：纯 Feishu / Slack adapter CRUD（GitHub 已搬至 `/settings/github`，注释明确说明）
- **用户实际影响**：**0**——侧栏、header、内容三处用户可见的标识完全一致，不一致仅在代码内部
- **决议（2026-05-13 讨论后）**：**won't fix unless triggered**——只在添加新 integration 类型时（如 Discord IM、Linear/Jira 非 IM）一并梳理路由命名
  - **理由**：
    - 用户体感 0 影响
    - 修复成本（rename + redirect + 改 imports）大于零，不是 5 分钟工作
    - settings 信息架构正在演化（P-9 / P-10 / P-12），现在改可能下次又改
    - 真正触发改名的时机是被迫做"按类别拆 vs 塞回一个 tab"的设计决策时——到那时一起决定
- **触发重启信号**：当下一个非纯 IM 的 integration 进来时，连同那个 PR 一起处理
- **排期影响**：从 P3（清理）移除，改为 backlog 触发条件式

---

#### P-11. role 是二元（admin/member），没有 owner ⏸ Deferred until triggered

- **问题**：org 创建者和后续 promote 的 admin 没有区分。如果原 admin 离开，谁来 transfer ownership？billing 责任人是谁？
- **决议（2026-05-13 讨论后）**：**暂不做**，等触发条件出现再立项。
  - **理由**：
    - 产品仍在早期，"owner 离职"实际频率约为 0
    - Owner role 的主要价值（billing contract holder、防 admin 互踢、所有权转移）目前都未踩到
    - Option A（加 owner role）成本不小：DB migration + 权限检查全面 refactor + UI transfer 流程 + 测试重做
    - 真要做时应根据 billing 设计反推 owner 的具体语义（contract holder vs 数据 owner vs 操作 owner），现在做语义模糊
  - **触发重启信号**（任一）：
    - Billing / 付费版立项
    - 用户反馈 admin 滥用 / 互踢
    - Org 数到达"原 owner 离职"成为定期事件的频率
- **替代方案（已否决）**：
  - **Option C：加 `organizations.owner_user_id` 单字段不改 role enum**：既然 owner 没有立刻要用的语义，加空字段是技术债

---

#### P-12. Context Tree 设置嵌在 Team tab 内 ⏸ Deferred until triggered

- **现状**：是 Team tab 的一个 panel（`org-settings.tsx` 里的 `ContextTreeSettingsPanel`），不是独立 sub-tab。admin-only。
- **观察**：当前有 4 个并行 worktree 在做 context tree（`context-tab` / `context-tree-remote-sync` / `context-overview-map` / `context-ui`），暗示这块在膨胀。
- **决议（2026-05-13 讨论后）**：**暂不拆**，等设置项数量真的增长再做。
  - 当前作为 Team tab 内一个 panel 是合理的临时状态——内容少时拆 sub-tab 反而稀释 Settings 侧栏密度
  - 触发条件：设置项扩展到 panel 容不下（多 tree 管理、sync 状态可视化、历史记录等）
- **触发后的实施方案**：
  - `settings.tsx` 侧栏加 `<SubNavLink to="/settings/context-tree" />`
  - `app.tsx` 路由表加一行
  - 把 `ContextTreeSettingsPanel` 从 `org-settings.tsx` 移走，包成独立 page
  - admin-only gate 复用 GitHub tab 的双保险模式（侧栏隐藏 + 页面 `<Navigate>` 守卫）

---

### 🟢 低严重性（文档 / 小一致性 / 技术债）

> P-13 / P-15 已从 audit 移除（详见各自反思）。剩余 P-14 / P-16 / P-17 为未来触发式 backlog。

#### P-14. `step1Confirmed` sessionStorage flag 永不清理 ⏸ Won't fix unless triggered

- **问题**：写一次永久存在。理论上没事但有 flag 漂移风险。
- **位置**：`onboarding-flags.ts`
- **决议（2026-05-13）**：**won't fix unless triggered**。实际伤害极小（用户清缓存 / 浏览器换设备等场景下重新走 Step 1 也不算 bug），修复成本是 1 行代码（dismiss 时清 flag），但 ROI 几乎零。如果未来 flag 漂移真的导致问题再加。

---

#### P-16. `resolveOnboardingAgent()` fallback 可能选错 agent ⏸ Won't fix unless reported

- **问题**：用户清缓存后，stashed UUID 失效，回退到 "最近创建的非 human agent"——如果用户已手动建了别的 agent，可能选错。
- **位置**：`step3-intro-body.tsx:847`
- **决议（2026-05-13）**：**won't fix unless reported**。触发条件极窄（用户必须**已有多个 agent** + **清了缓存** + **正好回到 Step 3**），onboarding 阶段用户大概率只有 1 个 agent。等真有用户反馈"绑错 agent"再做（修复方案：持久化 onboardingAgent UUID 到 server-side）。

---

#### P-17. `teamRepos` 的 useState 初始化只跑一次 🔗 Bundled with P-6

- **问题**：注释里已经标注："If that invariant ever changes, add a useEffect that reconciles chosenRepoUrls when teamRepos identity changes." 是已知技术债。
- **位置**：`step3-intro-body.tsx:179`
- **决议（2026-05-13）**：**作为 P-6 的子任务**。当 P-6（InviteeWaitingBody 通知系统集成）反激活、`InviteeStep3Body` 加上对 team_setup 的实时订阅时，必须同步在 `InviteeConfirmBody` 加 `useEffect` 协调 `chosenRepoUrls`，否则会出现选择不同步问题。

---

#### P-18. Step 2 default agent name 改用 `{login}'s assistant` ✨ New (2026-05-13)

- **问题**：当前默认 name 是 `"Assistant"`，多人团队下每个用户的 agent 都叫 Assistant，chat / mention / 通知里**重名严重**。
- **位置**：`step2-body.tsx:56`
- **决议（2026-05-13 讨论后）**：默认改为 `{login}'s assistant`，跟现有 `{login}'s team` 命名约定对齐。
  - 改动：
    ```ts
    // 当前
    const [displayName, setDisplayName] = useState(() => initialDraft?.displayName ?? "Assistant");
    
    // 改后
    const [displayName, setDisplayName] = useState(() => initialDraft?.displayName ?? `${login}'s assistant`);
    ```
  - 用户已手动改过的不会被覆盖（`??` fallback 保护）
  - **slugify 行为已验证**：`gandyxiong's assistant` → `gandyxiong-s-assistant`，functional 但稍粗糙；如有洁癖可以在 slugify 前先 strip apostrophe，但不阻塞
- **关联讨论**：先讨论过"改 'personal assistant'"（已否决——在 Step 2 时刻没有对照项，引入新概念反而困惑）；最终落点是这条更聚焦"重名"问题
- **跟 P-7 一起做**：都是 onboarding 文案精准化的小工作，1 个 PR 解决

---

## Audit 整体反思

讨论过程中累计出现 **3 次**"凭印象写错"或"过度推荐"的模式，需要在后续 audit 工作中警惕：

| 案例 | 模式 |
|---|---|
| **P-5** | 没读现有代码就下结论"缺防护"，实际已有双闸 |
| **P-10** | 没核实 `/team` 现有功能就列"缺 Members tab" |
| **P-2** | 工程师本能（"显式状态化更稳"）覆盖了对实际用户路径的判断；做了反而 UX 更差 |

另一个反复出现的反模式：每次必要修复之上**叠一层"看起来更完善"的 polish**（P-1 加 DB 列、P-3 加事务、P-6 加前端订阅、P-7 加按钮文案动态化）——这些都被讨论否决。**默认推最小修复，附加项要明确论证 ROI 才提**。

---

## 整改优先级建议（2026-05-13 收尾后）

| Sprint | 处理项 |
|---|---|
| **P0（这周）** | P-2 revised（建模 onboarding 终态）、P-3 非原子写（前端错误处理统一）|
| **P1（下周）** | P-1 joinPath 持久化（纯派生，改 Step 1 + Step 2 gate）|
| **P2** | P-7 toast 文案对齐 + P-18 default agent name（同一 PR）|
| **触发式 backlog** | P-6（通知系统重构后）、P-8（新 integration 类型）、P-11（billing 立项）、P-12（设置项膨胀）、P-14 / P-16（用户反馈）、P-17（跟随 P-6）|
| **已 resolved / 失效** | P-4 已被 P-1 覆盖、P-5 已存在双闸防护、P-9 / P-10 / P-13 / P-15 audit 错误已移除 |

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
