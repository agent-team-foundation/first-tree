# 新用户 Onboarding 重设计 — 设计文档

**状态：** 已落地（PR #248，含修订），随后 UI 实现方式被**取代** — 引用任何章节前请先读下方横幅。
**分支：** `feat/onboarding-redesign`
**范围：** 托管版 Hub（first-tree.ai）新用户登录后的 onboarding。
**不在范围：** 本地自建 Hub（`first-tree start`）— 见 [docs/onboarding-redesign.md](onboarding-redesign.md)。NewAgentDialog 重写 — 见 PR #237。
**英文版：** [new-user-onboarding-design.md](new-user-onboarding-design.md)（同步维护）。

> ⚠️ **架构已被取代（2026-05）。** 本文档把 onboarding 描述为**内联**形态 ——
> stepper 悬在 `CenterPanel` 上方、`OnboardingView` 分支渲染各步骤、Step 3 原地复用
> 工作区的 `ChatView`。这套架构已**清退**。onboarding 现在是一个**独立的全屏
> `/onboarding` 路由**（[packages/web/src/pages/onboarding/](../packages/web/src/pages/onboarding/)）；
> 工作区根路径通过 `shouldEnterOnboarding`（`pages/onboarding/steps.ts`）把未完成设置的用户重定向进去。
>
> 据此阅读：
> - **已过时（仅 UI 架构）：** §4（内联布局 / `OnboardingView` / stepper-在-CenterPanel-上方）
>   与 §7.1–§7.4（Step 3 子状态 UI）。文中提到的组件（`onboarding-view`、`onboarding-stepper`、
>   `step1/2/3` body、`step-frame`）均已删除、不再存在。
> - **仍然权威（产品 + 服务端语义）：** §5（team 自动命名，含 §5.5）、§6（agent 创建）、
>   §7.5–§7.6 + bootstrap 消息、§8（完成模型 — `onboarding_dismissed_at` /
>   `onboarding_completed_at`）、§9。英文版的同名章节锚点被源码注释引用，故编号保持稳定。

---

## 1. 为什么重设计

本次重设计**扩展了 onboarding 的产品 scope**，不只是 UI。原 onboarding 是"接电脑 + 建 agent"（现 `OnboardingView` 正好覆盖这两个服务端状态）。新 onboarding 是 **first-tree 产品体系的完整配置 ceremony**：建 team + 建第一个 agent（含 repo 绑定）+ 初始化 Context Tree。

3 个 step **是平级的基石、不是层级递进** —— 每个 step 配置产品要工作必须有的一块基础概念：

| Step | 配置的 | 不配置的话产品就… |
|---|---|---|
| 1 — Team | agent 跟人共享的协作空间 | agent 漂着无归属；以后 invite 别人没团队身份可加 |
| 2 — Agent | 绑了 source repo、跑在某台电脑上的 AI | 没有 AI 在你代码上工作的入口 |
| 3 — Context Tree | 共享知识层（NODE.md / members / AGENTS.md / source 绑定元数据），给 agent 持久 context、启用 auto-sync | 就只是个能聊天的 agent — 等价于普通 Claude Code session，缺 first-tree 的核心价值：跟代码一起增长的 context |

旧 scope 下 Step 1 是隐式的（OAuth 时自动建、用户看不见），Step 3 在 onboarding 范畴外（用户可能离开时 agent 能聊但无 context）。新 scope 把这俩都做成 **first-class step**，因为它们对产品**结构上是必须的**，不是可选附加。

原 `OnboardingView`（已清退 —— 见上方横幅）反映的是旧 scope：单页表单把 agent name + 接电脑 + 选 runtime 三件事压在一起。没有 team 确认、没有 repo 绑定、没有 tree 初始化的路径。

重设计的目标：
1. **扩展 onboarding scope** 覆盖完整的 first-tree setup ceremony（team / agent / tree），反映产品真实的价值链 —— 而不仅仅是"一个能聊天的 agent"
2. 多步结构对齐用户心智、每个 scope 元素都有专属的可完成步骤
3. Step 3 直接复用 `ChatView`，不在 onboarding 里重新实现一个 chat
4. 持久的进度可视化，让用户知道走到哪里
5. server 端状态最小化 —— 只新加 `users.onboarding_dismissed_at`；现有 `wizardStep` 字段重命名为 `onboardingStep`（见 §8.5）
6. **给增长留空间** —— Step 1 在 v1 故意做得最小（rename 自动起的 team 名），但保留未来扩 team setup 的位（description、icon、邀请队员、team 类型、默认值）。见 §5.6。

---

## 2. 文档范围

### 在范围内

托管版 Hub 上、用户用 GitHub OAuth 登录后的三步 onboarding：

1. **创建 team** — 自动起名，一键确认
2. **创建第一个 agent** — name + GitHub 源 repo + 电脑 + runtime
3. **Init context-tree** — 跟刚建好的 agent 对话；agent 在用户本地跑 `first-tree tree init`

### 搁置（不做）

- **Step 4 — 配置 GitHub 自动化。** 原本在 onboarding 里。搁置原因：(a) github-automation 这个产品定位不清（first-tree-automation 处于 limbo，repo-gardener 按 atf-launch ROADMAP 已 paused）；(b) 它是长尾价值功能，前 5 分钟用户感受不到；(c) 强制 3-5 分钟外部依赖步骤会损害转化率。详见 §10。
- **本地自建 Hub 的 onboarding。** 在 [onboarding-redesign.md](onboarding-redesign.md) 里。
- **Invite 路径变体**（`joinPath === "invite"`）。当前 OnboardingView 已区分 "you've joined {team}" vs "Welcome to First Tree Hub"。Invite 用户跳过 Step 1（已加入现有团队），但其余流程一致。详细 invite 边界场景另文跟进。

---

## 3. 受众与假设

**Q1 已定：** 托管版 Hub 在当前阶段**只面向开发者**。

具体假设：
- 用户能开终端、跑 `npm install -g`，对 `gh auth login` 不陌生
- 用户有 GitHub 账号（登录就是 GitHub OAuth）
- 用户在 GitHub 上有想接进 first-tree 的源码 repo
- 用户能 review + merge GitHub PR

**非开发者适配**（macOS `.pkg` 安装器、纯浏览器流程等）**显式搁置**到产品下沉到那部分人群之后再说。

---

## 4. 架构

> **已被取代：** 本节描述的是已清退的*内联*布局。实际上线的是独立 `/onboarding`
> 路由 —— 见 [packages/web/src/pages/onboarding/](../packages/web/src/pages/onboarding/)
> （`onboarding-shell.tsx` 外壳、`progress-rail.tsx` stepper、`steps.ts` 网关）。
> 此处仅作历史 rationale 保留。

### 4.1 布局 — stepper 只在 CenterPanel 上方（不横跨 rail）

onboarding 的进度指示器是**只占 CenterPanel 那一栏上方**的 stepper，宽度跟 CenterPanel 对齐。它**不**横跨左侧 rail。rail 在 onboarding 期间保留完整垂直空间。

```
WorkspaceLayout (app shell)
  ├── 顶部全局 chrome  (logo / 用户菜单 / org 切换)
  │
  ├── 左侧 rail          │  ◉ Onboarding Stepper                            ← 仅在 CenterPanel 上方
  │  (agents/chats)      │   Create team · Connect agent · Init context-tree    (rail 顶部保持干净)
  │                      ├─────────────────────────────────────────
  │                      │  CenterPanel (路由 — 见 §4.3)
  │                      │
```

**Step 标签（stepper 和 body 标题保持一致）：**
- Step 1: `Create team`
- Step 2: `Connect agent`
- Step 3: `Init context-tree`（短动词 `init` 故意保留 — 跟 `first-tree tree init` CLI 一致；`context-tree` 加 hyphen 让它作为单一术语标识）

stepper 在 onboarding 期间的**所有** CenterPanel 状态下都常驻。用户在 OnboardingView（Steps 1、2 和 Step 3 intro）和 ChatView（Step 3 实际聊天）之间来回切换，都不丢 stepper。

**为什么只在 CenterPanel 上方而不全宽：**
- stepper 服务的对象是 **CenterPanel 里的内容**（Step 1/2 表单、Step 3 chat）。把它紧贴在那一栏上方，视觉耦合显式
- 左 rail 显示 agent / chats 列表，跟 onboarding 没语义关系。压缩 rail 顶部给一个跟 rail 无关的指示器腾位置，是无意义的视觉成本
- 用户关闭 stepper 时只有 CenterPanel 一栏的视觉变化，rail 不闪 — 比全宽行折叠更稳

### 4.2 OnboardingView — 单组件、内部按 step 分支

`OnboardingView` **不是** onboarding 的唯一 view。它是 onboarding **非 chat** 部分的容器，body 按 `onboardingStep` 分支：

```
OnboardingView body:
  step 1                                       → Step1Body (team 表单)
  step 2                                       → Step2Body (agent 表单)
  step 3，chat 还没创建                        → Step3IntroBody (引导卡)
  step 3，chat 已存在                          → 不渲染
                                                  (CenterPanel 直接走
                                                   ChatByIdView 分支)
```

stepper **不属于** `OnboardingView` — 它在 layout 层（按 §4.1 定位在 CenterPanel 上方，不在 OnboardingView 自己的 render 输出里）。

### 4.3 CenterPanel 路由

现有 CenterPanel 路由（[packages/web/src/pages/workspace/center/index.tsx](../packages/web/src/pages/workspace/center/index.tsx)）需要一处优先级调整：

```
selectedChatId === draft           → NewChatDraft
selectedChatId set                 → ChatByIdView           ← Step 3 chat 落到这里，零包装
onboardingStep !== "completed"         → OnboardingView         ← Steps 1、2、Step 3 intro
nothing                            → NoChatView
```

**关键：** `selectedChatId set` 优先级**高于** `onboardingStep !== completed`。一旦用户在 Step 3 IntroBody 点了「Yes, set it up」，chat 被创建、URL 落到 `?c=<chatId>`，从那一刻起 CenterPanel 就走 ChatByIdView 分支，渲染**完全未包装的原生 `ChatView`** — 没有 overlay、没有把 onboarding chrome 塞进 chat 里。顶部 stepper 是用户"还在 onboarding"的唯一视觉信号。

### 4.4 步骤切换

所有步骤切换都是**用户驱动**的、通过点击 stepper 触发。没有自动推进。stepper 的行为：
- 点击**已完成**的 step → 回看（URL 变化、OnboardingView body 切换）
- 点击**当前** step → no-op
- 点击**未来** step → 阻止（视觉上标记为不可用）

stepper 点击会 PATCH 服务端 `onboardingStep` + 改 URL。

### 4.5 左侧 rail 行为

**决策（O-2）：onboarding 期间 rail 正常渲染。**

- Step 1–2：rail 是空的（用户还没 agent 没 chat）— 没事，不需要特殊 UI
- Step 2 创建 agent 后：rail 自然出现 1 项 agent
- Step 3 创建 chat 后：rail 在那个 agent 下自然出现 1 项 chat
- onboarding 完成的瞬间：workspace 看起来"已经被住过了"，因为是用户自己的行为把 rail 自然填起来的

为什么不隐藏 / 灰化：
- 隐藏会在 onboarding 结束时"突然多出一栏"，视觉跳跃
- 灰化是常见的 onboarding 反模式 — 显式给用户看一个 ta 不能用的功能
- 用户在 Step 3 中途点 rail（比如回看上一条 chat）仍然在 ta 的工作区里，不是打破教程。这里 onboarding 是引导而非沙盒。

### 4.6 Stepper 视觉状态规范

每个 step 有 4 个视觉状态。相邻两步之间的连接线由派生规则决定。

**单步状态：**

| 状态 | 视觉 | 含义 |
|---|---|---|
| **Pending（未到）** | `○` 空心圆，1px muted-gray 边，label muted-gray | 用户还没走到这一步 |
| **Active（进行中）** | `●` 实心圆，accent fill，1.5px accent 边，可选 ~8% accent halo（不动画），label fg-1 半粗 | 用户当前所在的步骤 |
| **Completed（已完成）** | `✓` 白色 check 在 accent 实心圆里，label fg-2（轻度淡化），hover 时 `cursor: pointer` + label 加下划线 | 已完成；可点击回看 |
| **Error（出错）** | `⊗` 错号在 state-error 实心圆里，state-error label | 仅 Step 2 client 长时间不上线时备用；其他 step 没可预见的 error 态 |

**连接线规则**（每对相邻步骤之间一条线）：

- 两端都是"已抵达"（Completed 或 Active）→ solid 1.5px accent
- 任一端是 Pending → dashed 1px muted，dash 间隔 4px

**示例：**

```
Stage A — 刚进 Step 1:
   ●   ┄┄┄┄┄┄┄   ○   ┄┄┄┄┄┄┄   ○                              [✕]
   Create team    Connect agent    Init context-tree

Stage B — Step 1 完成、进 Step 2:
   ✓   ━━━━━━━   ●   ┄┄┄┄┄┄┄   ○                              [✕]
   Create team    Connect agent    Init context-tree

Stage C — Step 1+2 完成、进 Step 3:
   ✓   ━━━━━━━   ✓   ━━━━━━━   ●                              [✕]
   Create team    Connect agent    Init context-tree

Stage D — Step 2 客户端长时间没上线（罕见 error 态）:
   ✓   ━━━━━━━   ⊗   ┄┄┄┄┄┄┄   ○                              [✕]
   Create team    Connect agent    Init context-tree
```

**stepper 布局细节：**

- 圆点跟线之间留 4px gap（线不视觉连进圆点边缘 — 保持 stepper 是"离散步骤"的表达，而非 progress fill）
- Active 的 halo（8% accent opacity 圆环）**静态、不脉动** — stepper 位置的脉动动画会跟 body 内容抢注意力
- Completed 圆点跟 Pending、Active 同直径（状态切换视觉稳）

**关闭按钮（`✕`）：**

位置：**stepper 行的最右端**，垂直居中跟圆点对齐。它在 step 圆点水平区间之外，Step 3 跟 `✕` 之间是死区（没连接线、不构成"step 4"视觉）。

点 `✕` → PATCH `users.onboarding_dismissed_at = NOW()` → stepper 卸载 → workspace 正常渲染。

Hover 状态：cursor `pointer`，button 背景轻微亮一档。Tooltip：`Hide setup steps`。

dismiss 动作 **从 UI 不可逆**。想让 stepper 回来需要在 Settings 加个口子（v1 不做）。

---

## 5. Step 1 — 创建 team

### 5.1 用户旅程

1. 用户走 GitHub OAuth → 服务端 `completeOauthFlow`（[api/auth/github.ts:142](../packages/server/src/api/auth/github.ts:142)）通过 `createPersonalTeam`（[services/membership.ts:116](../packages/server/src/services/membership.ts:116)）自动创建一个个人 team
   - **默认 displayName: `{login}'s team`**（如 `gandyxiong's team`）— 见 §5.5 的理由 + 改动说明
   - Slug：从 `profile.login` 派生（不变）
2. 浏览器落到 `/`，OnboardingView 渲染 Step 1 body
3. 用户在单个可编辑输入框里看到自动起的 team 名（输入框 focused，光标在末尾）
4. 用户按 Enter 或点 Continue → `onboardingStep` 推进到 step 2

**决策（O-3）：显示预填表单、输入框 focused、Enter 或 Continue 推进。** 不在乎的用户：1 个 keystroke (Enter) 过；想改名的用户：edit + Enter。**没有跳过这一步的快捷方式、没有自动推进** — Step 1 在 stepper 上有位，就应该被看见。

### 5.2 Body / 线框

```
┌─────────────────────────────────────────────────────────────────────┐
│  ●━━━━━━━━━━━━━━━━━━━○━━━━━━━━━━━━━━━━━━━○                  [✕]    │
│  Create team    Connect agent     Init context-tree                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                       Create team                                   │
│                                                                     │
│        ┌─────────────────────────────────────────────┐              │
│        │ Team name                                   │              │
│        │   ┌───────────────────────────────────────┐ │              │
│        │   │ gandyxiong's team                     │ │              │
│        │   └───────────────────────────────────────┘ │              │
│        │   You can rename your team later.           │              │
│        │                                             │              │
│        │                            [ Continue → ]   │              │
│        └─────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.3 行为

**用户视角的语义：** Step 1 **就是**创建 team。用户起名、点 Continue、自己的 team 身份就立起来了。这就是 stepper 标签 `Create team` 想表达的、也是用户体感应该有的。

**实现细节：** DB 行其实在 OAuth 回调时就被预先 insert 了（`completeOauthFlow` 调 `createPersonalTeam`），让 JWT 立刻就有 org context。Step 1 的 Continue 行为：
- 不改名直接 Continue → 不需要 rename API；只把 `onboardingStep` 推进到 `step2`
- 改了名再 Continue → 先 PATCH `organizations.displayName`，再推进 `onboardingStep`

这种"DB 早于 UI"的模式让 OAuth + JWT 发放保持简单，代价是 v1 成本：任何 OAuth 完没做到 Step 1 就 abort 的用户会留下一行"orphan team"（用户从未确认）。periodic 后台任务清理。漏斗分析靠客户端 telemetry 事件（Step 1 form 挂载 / Step 1 Continue 点击）— 服务端无法区分"自动建但用户从未确认" vs "用户确认了"。

如果 orphan 行数或分析失真严重，v1.1 可以 refactor 成 "Step 1 Continue 才建 team"（需要 user-only JWT，见 §12 Phase 1.5 follow-up）。

### 5.4 Slug 处理 — 单字段，slug 自动派生不显示

**决策（P-2）：Step 1 表单只显示 team 的 `displayName`。slug（用在 URL 和 @mention）从 `profile.login` 自动派生，用户看不到。** 理由：Step 1 必须最轻；让 slug 作为可编辑字段出现等于让新用户做一个 ta 当下做不出自信判断的决定。用户之后想改 slug，去 team settings 改。

### 5.5 默认 team 名变更

当前 [api/auth/github.ts:200-205](../packages/server/src/api/auth/github.ts:200) 的 `completeOauthFlow` 传：

```typescript
const personal = await createPersonalTeam(app.db, {
  userId,
  loginSeed: profile.login,
  userDisplayName: profile.displayName?.trim() || profile.login,  // ← 改这个
});
```

现状：team displayName 字面是用户的 GitHub display name（如 `Gandy Xiong`），读起来像人名不像 team。用户后续邀请合作者会很奇怪。

**变更：** 改成传 `userDisplayName: \`${profile.login}'s team\``。新建 team 显示为 `gandyxiong's team`，对齐 Linear 惯例，从开始就让"这是个集体空间"显式。

底层 schema 和 slug 逻辑不变，只是 OAuth 回调里传的值变。[api/auth/github.ts](../packages/server/src/api/auth/github.ts) ~1 行 server 改动。

### 5.6 Growth path — Step 1 是预留的扩展位

**v1（本次重设计）：Step 1 最小化。** 单输入框（team 名）+ Continue。想改名就改、不想就一个 keystroke 过。

**未来版本**预期把 Step 1 扩成更丰富的 team setup 表面。可能的扩展（不承诺、列出来供设计意识）：

- **Team description** — invite 邮件、dashboard 等地方会显示的简短描述
- **Team icon / avatar** — 在 org switcher 和 rail 里的视觉身份
- **Team 类型** — personal / company / open-source-project，决定默认权限
- **邀请队员** — 早期协作 setup（email 或 GitHub handle 邀请）
- **默认隐私 / 可见性** — 是否有 team 公开页
- **时区、工作时段** — 给未来调度类功能用

为什么这件事影响 v1 设计：保留 Step 1 在 wizard 结构里（即便 v1 只做 rename）就是**留住这个槽位**。如果 v1 把 Step 1 砍掉（比如自动跳过），未来任何扩展都得重新插一个 wizard step、重做 stepper 视觉、重做路由 — churn 成本高。v1 "最小但是真"的定位是有意的投资。

**实施指导：** Step1Body 现在是个垂直表单，今天只 1 个字段。未来加字段是往同一个组件追加，不是新加 wizard step。CenterPanel 路由跨 Step 1 的所有扩展都不变。

---

## 6. Step 2 — 创建第一个 agent

### 6.1 用户旅程

1. 用户从 Step 1 点 Continue 落到 Step 2
2. 表单 3 个必填项：
   - **Agent name**（display name，自由文本）
   - **Source repository**（GitHub repo picker — 通过 OAuth 拉用户可访问的 repos 列表）
   - **Computer**（CLI 命令框；用户在自己机器上跑 `first-tree login <token>`）
3. Runtime 自动选第一个可用的 `ok` capability（优先 Claude Code）；Step 2 没给用户选 runtime 的 UI（高级选项推到 onboarding 后的 settings）
4. 用户点 Create → 服务端创建 agent，带 `gitRepos: [{url: <选的 repo>}]` + clientId + runtime → 轮询直到 agent 上线 → 推进 `onboardingStep = step3`

### 6.2 Body / 线框

```
┌─────────────────────────────────────────────────────────────────────┐
│  ✓━━━━━━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━○                  [✕]    │
│  Create team    Connect agent     Init context-tree                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                       Connect agent                                 │
│                                                                     │
│        ┌─────────────────────────────────────────────┐              │
│        │ 1. Name                                     │              │
│        │    ┌──────────────────────────────────┐     │              │
│        │    │ Code Reviewer                    │     │              │
│        │    └──────────────────────────────────┘     │              │
│        │                                             │              │
│        │ 2. Repository it works on                   │              │
│        │    ┌──────────────────────────────────┐     │              │
│        │    │ ▾ gandyxiong/first-tree      │     │              │
│        │    └──────────────────────────────────┘     │              │
│        │    (picker, 通过 GitHub OAuth 列出)          │              │
│        │                                             │              │
│        │ 3. Computer it runs on                      │              │
│        │    ╭─ Waiting for your computer… ──────╮    │              │
│        │    │ Open Terminal and run:            │    │              │
│        │    │   first-tree login 9f3a… 📋 │    │              │
│        │    ╰───────────────────────────────────╯    │              │
│        │    (client 上线后变成 ✓ <hostname> connected)│              │
│        │                                             │              │
│        │                             [ Connect  → ]  │              │
│        └─────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.3 GitHub repo picker

**决策（Q-2.A）：用 GitHub OAuth 驱动的 picker，不用纯文本 URL 输入。** 理由：
- 用户登录时已为 OAuth 付出了成本 — 复用便宜
- "从列表里选" 是离散动作，比敲 URL 体感轻
- 列表本身有教育意义（"这些 repo 是这个 agent 可以触碰的"）
- Step 4（回归时）和未来任何要碰 GitHub 的功能都可以复用这个 picker 组件

**实现注意：** 当前 GitHub OAuth scope 是 `read:user user:email`（[api/auth/github.ts:69](../packages/server/src/api/auth/github.ts:69)）。列出 repo 需要 `repo` scope。

**决策（O-1）：登录时把 OAuth scope 扩到 `read:user user:email repo`。** 每个登录用户都在注册时授予 repo 访问权；Step 2 的 picker 立刻可用，无需额外 redirect。代价：GitHub 授权页会显示 "Read and write access to code, issues, pull requests..."，对还没决定要不要建 agent 的用户感觉重。文案缓和（"We never push without your explicit ask — every change goes through a PR you review"）。

为什么不用 `public_repo` fallback：目标受众是开发者，主要在私有 repo 工作。picker 列空（因为用户没公开 repo）比一次性更宽 scope 是更糟的 onboarding 体验。

为什么不延后/分步增量升级：onboarding 中段（即将建第一个 agent 时）多一次 GitHub redirect 摩擦点不对。前置到登录时虽然让更多没用 Hub 的人也授权了，但破坏性反而更小。

### 6.4 接电脑

跟已清退的内联视图一样的机制（现位于独立流程的 [`use-computer-connection.ts`](../packages/web/src/pages/onboarding/use-computer-connection.ts)）：
- Step 2 mount 时 lazy-mint connect token
- 显示 `npm install -g first-tree && first-tree login <token>`
- 每 3 秒 poll `listClients()`；client 上线时把"Waiting"脉冲点切成"✓ <hostname> connected"
- 接上后拉 capabilities 确认至少一个 runtime 是 `ok`

### 6.5 Runtime 自动选

**决策（P-3）：首次 onboarding 不给 runtime UI。Runtime 自动选。**

- 按优先级选第一个 `ok` runtime：`claude-code` 优先，其次 `codex`
- 如果都不 ok，按 [PR #237 的 runtime 提示文案](https://github.com/agent-team-foundation/first-tree/pull/237) 显示行动建议（`先在 host 上装 Claude Code` / `运行 \`claude\` 完成登录`）
- 当前 `OnboardingView` 的 "Powered by" runtime chip UI 在本重设计里 **删除** — 新用户看不到 runtime 作为决策项

理由：新用户不知道 Claude Code 和 Codex 的区别；把两个名字相近的引擎暴露出来等于让 ta 做无法自信判断的决定。runtime 之后在 agent settings 里改。多 runtime UI 留在 onboarding 之后的 `NewAgentDialog`（那时用户是在做"建另一个 agent"的有意识决定，可能有偏好）。

### 6.6 Create 动作

点 `[Create]` 时：
1. POST `/admin/agents`，body `{type: "personal_assistant", displayName, name (slug), clientId, runtimeProvider, gitRepos: [{url: <选的 repo>}], organizationId}`
2. Poll `/admin/agents/<uuid>/client-status` 直到 online（30 秒超时，重试 UI 沿用现有 OnboardingView 的模式）
3. online 之后：PATCH `onboardingStep = step3`，navigate 到 `/`（Step 3 intro）

注意：`gitRepos` materialization 在第一次 chat session 启动时自动发生（见 [packages/client/src/handlers/claude-code.ts:682-700](../packages/client/src/handlers/claude-code.ts:682)）— `git worktree add` 把源 repo 克隆到 agent session 的 cwd 里，在用户发任何消息之前完成。

---

## 7. Step 3 — Init context-tree

### 7.1 三个子状态

Step 3 有**三个视觉差异显著的子状态**：

**子状态 A：还没创建 chat、引导卡未关** → `OnboardingView` 渲染 `Step3IntroBody`（引导卡，含 [Yes, set it up] / [I'll do it later]）
**子状态 A'：用户点了 [I'll do it later]、还没 chat** → `OnboardingView` 渲染 `Step3PlaceholderBody` — 单行：`Click "Tree" in the stepper above when you're ready.`
**子状态 B：chat 已存在** → `ChatByIdView` 渲染未包装的原生 `ChatView`

切换：
- A → A'：用户点 [I'll do it later]；客户端 state 翻 intro-dismissed flag（sessionStorage；per-tab；不存 server）
- A' → A：用户点 stepper 上的 "Tree" step（清掉 intro-dismissed flag，重新显示 IntroBody）
- A → B（或 A' → B）：用户点 IntroBody 上的 [Yes, set it up]（仅在子状态 A 可点）

### 7.2 子状态 A — Step3IntroBody 线框

```
┌─────────────────────────────────────────────────────────────────────┐
│  ✓━━━━━━━━━━━━━━━━━━━✓━━━━━━━━━━━━━━━━━━━●                  [✕]    │
│  Create team    Connect agent     Init context-tree                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│      ╭─ Init context-tree ────────────────────────╮                 │
│      │                                           │                  │
│      │  Your agent @code-reviewer is ready on    │                  │
│      │  gandy-mac and has cloned                 │                  │
│      │  gandyxiong/first-tree.               │                  │
│      │                                           │                  │
│      │  Set up first-tree on it now? It takes    │                  │
│      │  ~2 minutes — agent does the scaffolding, │                  │
│      │  you confirm a couple of choices.         │                  │
│      │                                           │                  │
│      │  ┌─ What this does ────────────────────╮  │                  │
│      │  │ • Creates a sibling tree repo and   │  │                  │
│      │  │   scaffolds it                      │  │                  │
│      │  │ • Installs the first-tree skill in  │  │                  │
│      │  │   both repos                        │  │                  │
│      │  │ • Writes binding metadata           │  │                  │
│      │  ╰─────────────────────────────────────╯  │                  │
│      │                                           │                  │
│      │      [ Yes, set it up ]                   │                  │
│      │      [ I'll do it later ]                 │                  │
│      ╰───────────────────────────────────────────╯                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.3 点 [Yes, set it up] → A → B 切换

```
1. POST /admin/agents/<uuid>/chats             → { chatId }
2. POST /admin/chats/<chatId>/messages
   body: BOOTSTRAP_MESSAGE   (见下)
3. navigate("/?c=<chatId>")                    → URL 改变
4. CenterPanel 重新路由到 ChatByIdView           (selectedChatId 设了)
5. ChatView 挂载；消息列表显示引导消息 + agent 流式回复
```

**引导消息文案**（一字不变，PR #237 和任何其他 first-tree 安装触发器共用同一文案源）：

```
Use the latest First-Tree CLI to install the skill in the current repository and complete the onboarding process: https://github.com/agent-team-foundation/first-tree
```

为什么用这条而不是更短的：
- 此刻 agent **没有**装 first-tree skill（装它正是 Step 3 要做的）。所以消息必须自包含：(a) 用哪个 CLI、(b) 干什么动作、(c) 不知道时去哪查的 URL。
- 像 `Initialize first-tree for this repo.` 这种简洁版对知识空白的 agent 模糊 —— `initialize` 可能被解成 `git init`；`first-tree` 可能不被识别为特定工具。
- 跨入口（PR #237 自动发送、本 onboarding 按钮触发、未来重装流程）复用同一字符串，agent 行为可预测，prompt 迭代集中。

引导消息是 Step 3 里**唯一**的 Hub 注入交互。从那一刻起 agent 和用户完全自由对话。

### 7.4 子状态 B — ChatView（原生、无包装）

> **已被取代（仅 UI 呈现方式）：** kickoff 不再在工作区 `ChatView` 里、stepper 常驻地
> 原地渲染。独立流程发出 bootstrap 消息后,导航到 `/?c=<chatId>`,把用户放进第一个真实
> 聊天（`pages/onboarding/steps/step-kickoff.tsx`）。`org bind-tree` 所指的 **bind-tree
> "Path B"** 未变:agent 仍会创建/绑定 context-tree repo,Hub 仍把它记到 org 设置里。

用户在的就是 onboarding 完成后日常使用的**同一个 ChatView**。chat 内部没有任何 onboarding chrome。workspace 顶部的 stepper 是"你还在 onboarding"的唯一信号。

对话流（基于对 [first-tree skill onboarding.md](https://github.com/agent-team-foundation/first-tree/blob/main/skills/first-tree/references/onboarding.md) 的研究）：
- agent 跑 `first-tree tree inspect --json`（自动、非交互）
- 基于 inspect 结果，agent **只会问一个问题**：「Do you already have a Context Tree, or should I create a new one?」
- 用户回复（自由打字 或 quick-reply chips，见 Q-3.B）
- agent 跑 `first-tree tree init`（自动）
- agent 把 `.first-tree/progress.md` 内容作为 markdown checklist 输出
- agent offer 引导用户走完后续手动任务（NODE.md owners、members/、AGENTS.md guidance）
- 之后对话按用户节奏继续

### 7.5 Step 3 → onboarding 完成

**没有"Continue 到下一步"按钮。** Step 4 搁置后，Step 3 是最后一步。Onboarding 完成的方式：

- **隐式（推荐）：** 服务端 `inferOnboardingStep` 仍然在用户既有 client 又有 agent 时返回 "completed"（现有逻辑）。Step 3 的进度**不被服务端追踪** — 但这是技术约束（服务端无法观测 agent 在本地文件系统的修改），不是说 Step 3 比 Step 1–2 不重要。**Step 3 在产品上是结构必需的**；它只是由客户端推进和追踪。
- **用户主动显式：** stepper 上有"✕"关闭按钮。点了 PATCH `users.onboarding_dismissed_at = NOW()`。stepper 卸载，workspace 回归 chat-first 默认形态。

两者**互补**。服务端推断自动完成。关闭按钮处理"用户想在/无视 Step 3 完成情况下把 stepper 移走"的情况。

### 7.6 Step 3 的具体决定

**Q-3.A — 引导消息怎么发出？**
- (1) Hub 注入（sessionStorage flag → ChatView mount → auto-send）— 同 PR #237 的 First-Tree bootstrap 机制
- (2) 用户点 `[Yes, set it up]`，前端显式 call `sendMessage()` 发送

**决策：(2)** — 按钮直接发送。无 sessionStorage 中转。更干净，tab 重开不会重发。

**Q-3.B — agent 那个"是否已有 tree"的问题，是否给 quick-reply chip UI？**
- (1) 消息下方内联 quick-reply chips：`[Create a new one]` / `[I have one — paste URL]`
- (2) 只能自由输入

**决策：(1)** — 离散选择题用 chips；URL 输入退回打字。

**Q-3.C — agent 进 Step 3 chat 时 cwd 怎么对？**

Step 2 的 `gitRepos` 绑定已经搞定了。agent runtime spawn Claude Code 时 cwd = `<workspaceRoot>/workspaces/<chatId>`，`prepareGitWorktrees` 步骤（[handlers/claude-code.ts:687-697](../packages/client/src/handlers/claude-code.ts:687)）在 LLM 跑之前把源 repo materialize 到 `<cwd>/<localPath>`。所以 agent 收到引导消息时，已经在用户的 repo 里了。

---

## 8. Onboarding 完成模型

**决策（O-7，方案 c）：stepper 可见性跟 `onboardingStep` 完全解耦。stepper 显示与否仅由"用户是否显式 dismiss"决定。`onboardingStep` 仅作为信息使用 — 它告诉 `OnboardingView` 该渲染哪个 body。**

### 8.1 为什么必须解耦

[api/me.ts:304-322](../packages/server/src/api/me.ts:304) 的 `inferOnboardingStep`，在用户**同时**有 client + agent 的瞬间立即返 `"completed"` —— 这正好发生在 Step 2 完成时。如果把 stepper 可见性绑到 `onboardingStep !== "completed"`，那 Step 2 一完成 stepper 就立即卸载 —— 用户进 Step 3 chat 时上方根本看不到 onboarding chrome。

Step 3（tree init）**不是**服务端可追踪的事。没有任何可观测的服务端事实能区分"用户完成了 Step 3" vs "用户在 Step 3 chat 中" vs "用户从未碰 Step 3"。强行让 `onboardingStep` 编码 Step 3 状态需要新加一个 RPC 让 Hub 读 agent 本地文件系统（检测 `.first-tree/source.json` 是否存在）—— 不必要的 scope 扩张，破坏了 Hub 跟 skill 的边界。

方案 c 完全绕开这个问题：`onboardingStep` 保持现状（服务端从 `clients` + `agents` 推断），用一个**单独的客户端 dismiss flag** 来控制 stepper 是否在屏幕上。

### 8.2 两个状态机制并行

**`onboardingStep`（服务端推断、现有逻辑、不变）：**
- 没 `clients` 行 → `"connect"`
- 有 client 没 agent → `"create_agent"`
- 都有 → `"completed"`
- **用途：** OnboardingView 的 body 分支（哪个 step 的表单）。当 onboardingStep 是 `"connect"` 显示 Step1Body；`"create_agent"` 显示 Step2Body；`"completed"` 显示 Step3IntroBody（或它的 placeholder 如果被关）。用户点 stepper 上某 step 回看时，URL 改变，OnboardingView 从 URL 状态推断渲染哪个 body，不只是从服务端 `onboardingStep` 推。

**`users.onboarding_dismissed_at`（新加的列、客户端驱动）：**
- `NULL` → 渲染 stepper
- 有时间戳 → 不渲染 stepper
- **由谁设：** 用户点 stepper 上的 `✕`。一次 PATCH，v1 从 UI 不可逆。
- **用途：** 仅 stepper 可见性。不影响路由或 body 分支。

### 8.3 实际行为

- Step 2 完成后，服务端 `onboardingStep` 返 `"completed"`。stepper 仍然显示（因为 `dismissed_at IS NULL`）。OnboardingView body 渲染 Step 3 IntroBody。用户点 Yes → chat 打开，ChatByIdView 接管 CenterPanel，但 stepper 仍显示在上方（因为 `dismissed_at IS NULL`）。
- Step 3 chat 期间用户点 stepper 上的 `✕` → PATCH `dismissed_at = NOW()` → stepper 卸载。workspace 看起来正常。`onboardingStep` 仍然是服务端的 `"completed"`，没别的变化。
- 用户下次登录：`dismissed_at` 有值 → 没 stepper。workspace 是 chat-first 默认形态。用户找到 ta 的 agent 自由聊天。
- 如果用户某种方式清掉 `dismissed_at`（DB 改、未来 v2 加 Settings 重启 onboarding）→ stepper 重新出现，状态跟当时该有的一致（active step 由当前 `onboardingStep` 推断）。

### 8.4 需要的 schema 变更

```sql
ALTER TABLE users ADD COLUMN onboarding_dismissed_at TIMESTAMPTZ NULL;
```

一个小 Drizzle migration。这是本次重设计**唯一**的服务端状态新增。

### 8.5 命名：`wizardStep` → `onboardingStep` 重命名

本次重设计把现有的 `wizardStep` 字段**重命名**为 `onboardingStep`，跟 codebase 其他名字（`OnboardingView`、`users.onboarding_dismissed_at`、`onboarding-flags.ts` 都是 "onboarding"-named）一致。涉及：

| 旧 | 新 | 在哪 |
|---|---|---|
| `wizardStep`（字段） | `onboardingStep` | server 响应、client state、测试 |
| `inferWizardStep()` | `inferOnboardingStep()` | [packages/server/src/api/me.ts](../packages/server/src/api/me.ts) |
| `wizard.step`（API 路径） | `onboarding.step` | `/me` 响应结构 |

**服务端值不改名。** 枚举 `"connect" | "create_agent" | "completed"` 描述的是可推断的事实（`clients` 行存在、`agents` 行存在），不是 UI step 编号。**服务端枚举 → UI Step 是多对多的，不是 1-1：**

| `onboardingStep` 值 | 映射到 UI… |
|---|---|
| `"connect"` | UI Step 2，sub-state"还没接电脑" |
| `"create_agent"` | UI Step 2，sub-state"有电脑还没建 agent" |
| `"completed"` | UI Step 1 + 2 完成；用户可能在 UI Step 3（不被服务端追踪）或已 dismiss onboarding |
| （无值） | UI Step 1 没有对应服务端值，因为 OAuth 总是已经预建好 team |

**为什么不把值跟 UI Step 编号对齐**（比如 `"awaiting_step2_client"` / `"awaiting_step2_agent"` / `"step3_or_done"`）：服务端枚举描述的是它能观测的事实；UI Step 编号是前端产品概念。把值改成 UI 对齐的名字会耦合两层不同抽象、丢信息 — 服务端用这些值无法区分 UI Step 3 跟"用户 dismiss 了 onboarding"，这是有意的不对称。值保持不变。

**全文档术语消歧：**
- "UI Step N" / "Step 1" / "Step 2" / "Step 3"（首字母大写 + 数字）= 用户可见的 3 步流程
- `onboardingStep` 值（如 `"connect"`）= 服务端枚举，代码引号形式
- "stepper" = CenterPanel 上方的 UI 组件；"stepper 位置" / "stepper step" = 该组件里的圆点（跟 UI Step 1-1 对应）

**迁移范围：** server + web + 测试 共 ~30 处。Phase 1 一起落。

---

## 9. State transitions 总览

```
┌─────────────────────────────────────────────────────────────────┐
│ Server `inferOnboardingStep`（现有逻辑，不变）：                     │
│                                                                 │
│   no clients row     → "connect"      (Step 1 或 2 未完成)     │
│   has client, no ag. → "create_agent" (Step 2 未完成)          │
│   both               → "completed"                              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Layout 层渲染 stepper（跟 onboardingStep 解耦）：                    │
│                                                                 │
│   users.onboarding_dismissed_at IS NULL                         │
│      → 在 CenterPanel 上方渲染 stepper                          │
│   else                                                          │
│      → 不渲染                                                   │
│                                                                 │
│ stepper 上"当前 step"高亮由客户端从 onboardingStep + URL 计算：      │
│ URL 有 ?c=<chatId> → step 3 active；否则用 onboardingStep           │
│ ("connect"→1, "create_agent"→2, "completed"→3)。                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ CenterPanel 路由（按优先级）：                                   │
│                                                                 │
│   selectedChatId === draft        → NewChatDraft                │
│   selectedChatId set              → ChatByIdView                │
│   onboardingStep !== "completed"      → OnboardingView              │
│   else                            → NoChatView                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ OnboardingView body（按 onboardingStep + chat 存在性分支）：        │
│                                                                 │
│   onboardingStep == "connect" 且无 client      → Step1Body          │
│      (自动起名 team 确认)                                       │
│   onboardingStep == "create_agent"              → Step2Body         │
│      (agent 表单：name + repo + computer)                       │
│   onboardingStep == "completed" 且未显示 chat → Step3IntroBody      │
│      (引导卡；点 Yes 创建 chat)                                 │
│   onboardingStep == "completed" 且 chat 已选  → (不渲染；           │
│                                              ChatByIdView 接管) │
└─────────────────────────────────────────────────────────────────┘
```

**注意：** 这个设计里的 Steps 1 和 2 对应到现有服务端的 `connect` / `create_agent` 状态。Step 3 的"in progress"状态**不是**服务端跟踪的 — 它纯粹由"该 agent 是否有 chat"在客户端决定。

---

## 10. 不在范围：Step 4 — GitHub Automation

**状态：搁置。** 文档化以备未来续做。

### 10.1 Step 4 原本要做什么

装两个 GitHub Actions workflow，让 Context Tree 跟源 repo 自动同步：
- `contextree.yaml` 装在源 repo：PR merge 时通过 openai/codex-action 生成 tree 更新 PR
- `workflow_auto_review_and_merge.yaml` 装在 tree repo：通过 `codex review` 自动 review tree PR、approve 时自动 merge

模板在 [first-tree-automation/lib/workflows/](https://github.com/agent-team-foundation/first-tree-automation/tree/main/lib/workflows)。它们是 self-contained 的 GitHub Actions；只要用户 repo secrets 里有 `OPENAI_API_KEY` 就能跑。

### 10.2 为什么搁置

- **产品定位不清。** first-tree-automation 不在 atf-launch 的产品清单里。repo-gardener（同类的 context-aware PR review bot）在 atf-launch 的 ROADMAP.md 里被标 paused。基于不稳定的产品线设计 onboarding UX 为时过早。
- **长尾价值。** 新用户头 5 分钟感受不到。需要写代码 → 开 PR → merge → 等 workflow 触发，才看得到价值。Onboarding 优化的是 time-to-first-value，Step 4 不帮这个。
- **外部 secret 依赖。** auto-review workflow 需要 `OPENAI_API_KEY` 在用户 tree repo secrets 里 — 没有 programmatic 捷径的手动 GitHub 任务。强制塞进首次流程会增加 30-60 秒断点和高弃单率。
- **架构不明。** 部署在 `https://github-bot-kappa.vercel.app/` 的 first-tree-automation 需要它自己的 GitHub App + webhook 监听。Hub 该 (a) 跳到那个站、(b) 吸收它的 install UI、(c) 用用户 OAuth 重写、(d) 通过用户本地 agent 驱动 — 还没定。

### 10.3 重启时的路径

Step 4 重启时：
1. 先把 github-automation 产品定位拍板（atf-launch ROADMAP）。是 first-tree-automation？还是 repo-gardener？还是两者都是？还是都不是？
2. 选集成架构：
   - 最可能：**agent 驱动**（跟 Step 3 一致）— 用户跟 agent 说"set up auto-sync"，agent 用本地 `gh` CLI auth 写 workflow 文件、commit、push、开 PR。零 Hub server 工作、零 OAuth scope 升级。
   - 对话历史里 §γ 部分提的就是这个：把 Step 3 chat 延伸出 follow-up "Want auto-sync too?"。
3. 加 stepper 第 4 步。要么：
   - 作为 Step 3 chat 的 opt-in 续接（γ 形态）
   - 作为独立 stepper 项（回到 4 步）

最不破坏的形态是 γ — stepper 保持 3 步，automation 是 Step 3 开放对话的一部分。

---

## 11. Open questions

| ID | 问题 | 待定决策 |
|---|---|---|
| ~~O-1~~ | ~~OAuth scope 升级时机~~ | **已定：** 登录时升级，scope = `repo`。见 §6.3。 |
| ~~O-2~~ | ~~onboarding 期间左侧 rail 行为~~ | **已定：** 正常显示。见 §4.5。 |
| ~~O-3~~ | ~~Step 1 表单行为 + 默认 team 名~~ | **已定：** 显示预填、输入框 focused、Enter 推进。默认 team 名从 `{display}` 改成 `{login}'s team`。见 §5.5。 |
| ~~O-4~~ | ~~Step 2 多 client 行为~~ | **已定：** 新用户进 onboarding 时按定义就是 0 client；多 client 是边缘 case。按 `lastSeenAt` 取最近活跃的（当前 OnboardingView 已有逻辑、保留）。onboarding 不展示 picker UI。多 client picker 体验留在 onboarding 之后的 NewAgentDialog。 |
| ~~O-5~~ | ~~`[I'll do it later]` 语义~~ | **已定：** 关引导卡，stepper 保留 step 3。body 显示 placeholder 一行：`Click "Tree" in the stepper above when you're ready.` 关 stepper 是另一个动作（✕ 按钮）。用户点 stepper 上的 Tree 即可重新打开引导卡。 |
| ~~O-6~~ | ~~引导消息文案~~ | **已定：** 复用现有 first-tree onboarding 的标准文案：`Use the latest First-Tree CLI to install the skill in the current repository and complete the onboarding process: https://github.com/agent-team-foundation/first-tree`。verbose 是有理由的 —— agent 此时还**没装** first-tree skill（装它正是 Step 3 的目的），消息必须自给上下文：用什么工具、入口在哪。PR #237 和任何未来 first-tree 安装触发都用同一句 — 单一文案源。 |
| ~~O-7~~ | ~~stepper 可见性跟 onboardingStep 解耦~~ | **已定：** 方案 (c) — stepper 可见性绑 `users.onboarding_dismissed_at`（NULL → 渲染，否则隐藏）。`onboardingStep` 仅驱动 OnboardingView body 分支。完整机制见 §8。 |

---

## 12. 落地阶段

按"最小可发布优先"的实施顺序：

**Phase 1 — Stepper + Step 1/2 表单重写**
- 加 `users.onboarding_dismissed_at` 列 + migration
- 加 layout 层 `OnboardingStepper` 组件
- 重构现有 `OnboardingView` body 按 `onboardingStep` 分支（Step1Body, Step2Body）
- Step 1 = team name 确认
- Step 2 = 现有流程 + 加 GitHub repo picker（§6.3）
- OAuth scope 升级流程（Q-2.A）
- 独立可发布：到此阶段用户在 Step 2 完成 onboarding（服务端说 "completed"）；stepper 显 2 个 step 标签。

**Phase 2 — Step 3 IntroBody + ChatView 路由**
- `Step3IntroBody` 组件，在 OnboardingView 渲染
- CenterPanel 路由变更：`selectedChatId set` 优先级 > `onboardingStep !== completed`
- 点 [Yes, set it up] handler：创建 chat + 发引导消息 + navigate
- stepper 扩到 3 步（加 Tree 标签）
- 实现 §11 O-7 的解法 (c)：stepper 可见性跟 onboardingStep 解耦，绑到 `dismissed_at`

**Phase 3 — 抛光**
- Stepper 关闭按钮（✕）
- 左侧 rail 行为决定（O-2）
- 边界场景：tree repo 没 OPENAI_API_KEY 的 Step 3（skill 处理但要标注）、Step 2 客户端不上线（沿用 TimeoutBody 模式）、repo picker 边界（无 repo、超大 repo 列表）。

**Phase 4 — Step 4（搁置）**
- 见 §10 路径。需要先有 github-automation 定位的产品决策。

---

## 13. References

- 已有的本地场景文档：[docs/onboarding-redesign.md](onboarding-redesign.md)
- 独立 onboarding 流程（当前）：[packages/web/src/pages/onboarding/](../packages/web/src/pages/onboarding/) —— `onboarding-page.tsx`、`onboarding-flow.tsx`、`onboarding-shell.tsx`、`steps.ts`
- CenterPanel 路由：[packages/web/src/pages/workspace/center/index.tsx](../packages/web/src/pages/workspace/center/index.tsx)
- ChatView：[packages/web/src/pages/workspace/center/chat-view.tsx](../packages/web/src/pages/workspace/center/chat-view.tsx)
- GitHub OAuth：[packages/server/src/api/auth/github.ts](../packages/server/src/api/auth/github.ts)
- Onboarding step 推断：[packages/server/src/api/me.ts:304-322](../packages/server/src/api/me.ts:304)
- Agent runtime config（gitRepos）：[packages/shared/src/schemas/agent-runtime-config.ts](../packages/shared/src/schemas/agent-runtime-config.ts)
- Git worktree materialization：[packages/client/src/handlers/claude-code.ts:682-700](../packages/client/src/handlers/claude-code.ts:682)
- first-tree skill onboarding doc：[skills/first-tree/references/onboarding.md](https://github.com/agent-team-foundation/first-tree/blob/main/skills/first-tree/references/onboarding.md)
- 关联 PR（NewAgentDialog 重写，独立 scope）：[#237](https://github.com/agent-team-foundation/first-tree/pull/237)
