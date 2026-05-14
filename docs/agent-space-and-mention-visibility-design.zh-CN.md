# RFC: Agent Space / Mention Visibility 模型设计

> **起源**：[Issue #372](https://github.com/agent-team-foundation/first-tree-hub/issues/372) — Private agent 无法在 @ mention 自动完成中显示
> **状态**：Draft for review
> **日期**：2026-05-14
> **作者**：gandy（讨论） + assistant（整理）
> **Reviewers**：@yuezengwu @serenakeyitan

---

## 1. 问题描述

### 1.1 触发现象（用户报告）

在群聊里输入 `@`，**private agent**（如 `liuchao-staff`）**不出现在自动完成候选列表**；但手动完整输入 `@liuchao-staff` 仍然能成功路由消息。

### 1.2 关联现象（同根因）

聊天右上角的参与者 chip，显示的是 **UUID 前缀**（如 `019df012`），而不是 agent 的真名。

### 1.3 影响

- **体验**：用户感觉系统在"骗他" —— 这个 agent 明明在群里参与对话，UI 却假装它不存在 / 不认识它。
- **隐私一致性**：本意保护 private 的设计，反而暴露了一个奇怪的"半遮半掩"状态。
- **可信度**：用户看到自己的同事的 agent 显示为乱码，会对产品的成熟度产生疑虑。

---

## 2. 代码层根因分析

### 2.1 三条数据源的 visibility 处理不一致

| 数据源 | 是否走 visibility filter | 内容 |
|---|---|---|
| `GET /chats/:id` 返回的 `participants` | ❌ 不过滤 | 只有 `{agentId, role, mode, joinedAt}` — **没有 name** |
| `GET /orgs/:org/activity` | ✅ 过滤 | 含 name |
| `useAgentIdentityMap`（前端 name 解析 map） | ✅ 过滤（底层是 `/agents`） | name/displayName |

### 2.2 触发路径

`packages/web/src/pages/workspace/center/chat-view.tsx:873-904` 构造 @ autocomplete 候选：

```ts
for (const p of chatDetail?.participants ?? []) ids.add(p.agentId);  // ① 加入群成员
for (const a of activity?.agents ?? []) ids.add(a.agentId);          // ② 加入活跃 agent
for (const id of ids) {
  const ident = agentIdentity(id);           // ③ 解析 name —— 走 visibility-filtered map
  if (!ident || !ident.name) continue;       // ④ 解析不出 → 丢弃
}
```

`ParticipantsHeader`（同文件 line 1676-1677）：

```ts
const ident = agentIdentity(id);
const label = ident?.displayName ?? ident?.name ?? id.slice(0, 8);  // ← 兜底为 UUID 前 8 位
```

对一个**不归当前用户管理的 private agent**：
- ① 它的 agentId 被加入候选
- ③ identity map 里查不到（被 visibility filter 拦掉）
- ④ 在 autocomplete 处被丢弃；在 ParticipantsHeader 处兜底为 UUID 前缀

### 2.3 为什么手动 @ 全名还能成功

服务端 `packages/server/src/services/message.ts` 解析 mention 时，直接 JOIN `chat_membership` 拿群里的所有 speaker，**完全不查 visibility**。`extractMentions` 用群成员列表去匹配 `@<name>`，所以全名能命中。

### 2.4 信任边界不一致

- **服务端**：把"群成员资格"当作信任边界（你已经在房间里 → 你能被点名）
- **前端**：把"组织可见性"当作信任边界（你是 private → 我当你不存在）

bug 长在这条缝里。

---

## 3. 产品层根因分析

代码层修复（让 `chatDetail.participants` 带 name/displayName）能闭合 #372，但**这是治标**。治本要回答一个更上游的产品问题：

> **`visibility: private | organization` 这个字段，到底要解决什么用户需求？**

### 3.1 visibility 当前被滥用为多个职责的混合体

| 真实用户需求 | visibility 现在被迫扮演的角色 | 这个抽象合适吗 |
|---|---|---|
| 降噪：实验性 agent 不想污染团队 roster | 隐藏 | ❌ 是过滤问题，不是权限 |
| 隐私：不想让同事知道这个 agent 干啥 | 隐藏 | ❌ 是 privacy theater |
| 访问控制：只有我能管 | 限制 manage | ❌ 是 ACL，应该独立字段 |
| 生命周期：还没准备好曝光 | 设为 private | ❌ 是状态，不是策略 |
| 归属感：我的 vs 团队的 | 区分 personal vs shared | ❌ 是显示层语义 |

### 3.2 架构层后果

visibility 在系统里每经过一层都被重新解释一次（list / activity / chat_membership / mention 解析 / identity map / chat header 各自的理解都不同）。**没有任何一层是错的 —— 因为字段语义本身就没定义清楚。** 修当前 bug 解决不了系统性问题，同类 bug 还会在新功能里继续长。

### 3.3 UX 层后果

- toggle 文案 "Private / Organization" 没有任何行为承诺，用户不知道自己在选什么
- 默认是 `private`，但产品定位是 team messaging —— 默认行为与产品定位精神分裂
- 切换 visibility 的副作用对用户完全不可见

---

## 4. 模型定义、关键设计与验证

### 4.1 核心原则

> **Agent 在系统中有两条独立的存在维度：**
>
> 1. **Discoverability（可发现性）** —— 这个 agent 能不能被别人**主动找到**（出现在 roster、search、新建 chat 的 picker 里）
> 2. **Membership（参与性）** —— 这个 agent 是不是某个具体 chat 的成员
>
> **关键派生规则**：UI 上对 agent 身份的渲染（名字、@提及、消息发件人）**只取决于 Membership，与 Discoverability 无关**。
>
> 两条轴正交、不重叠、不互相穿透。

### 4.2 维度的精确定义

#### 4.2.1 Discoverability（可发现性）

由 agent 的 `space` 字段决定：

| 值 | 语义 | 谁能"发现"它 |
|---|---|---|
| `personal` | 个人 agent，**默认值** | 仅 owner 本人 |
| `team` | 团队 agent，已显式 publish | 同组织所有成员 |

**"发现"的具体行为承诺：**
- 出现在团队 roster / agent list 页
- 在新建 chat 的 agent picker 中可搜索/选择
- 出现在 `/api/v1/agents`（org-scoped list）响应中
- 出现在 `/api/v1/orgs/:org/activity`（团队活跃列表）响应中
- 出现在 admin 的团队 agent 管理界面

#### 4.2.2 Membership（参与性）

由 `chat_membership` 表决定：某个 agent 是不是某个 chat 的 speaker / mention_only 成员。

**"参与"的具体行为承诺：**
- 出现在 `GET /chats/:id` 返回的 `participants` 列表
- 出现在 chat 顶部的参与者 chips（`ParticipantsHeader`）
- 能被 chat 内的其他成员 @ 提及（autocomplete 候选 + 服务端 `extractMentions` 解析）
- 收发消息时按真实 `displayName` 渲染
- 加入/退出 chat 触发 system message

#### 4.2.3 关键派生规则：Identity Rendering = f(Membership)，**not** f(Discoverability)

> 任何在 chat 内对 agent 身份的渲染（名字、avatar、@提及、消息发件人），**应该且仅应该**取自 `chat_membership JOIN agents`，不应该再走 discovery-filtered 的 `/agents` 或 `/activity`。

这条规则是修复 #372 类 bug 的**根本不变量**：违反它，bug 一定会在新功能里复发；遵守它，整类 bug 在数据通路上不可被表达。

### 4.3 数据模型

#### 4.3.1 `agents` 表

```sql
-- 旧
visibility TEXT NOT NULL DEFAULT 'private'   -- 'private' | 'organization'

-- 新
space TEXT NOT NULL DEFAULT 'personal'        -- 'personal' | 'team'
```

**迁移映射**：`visibility='private' → space='personal'`；`visibility='organization' → space='team'`。

`managerId` 字段**保持不变** —— 它是 agent 的 owner，与 space 正交：
- `personal` agent 必须有 owner（owner 是它能被发现的唯一入口）
- `team` agent 仍然需要 maintainer（沿用 `managerId` 语义即可，未来如需多 maintainer 再演进到 `managers[]`）

#### 4.3.2 `chat_membership` 表

**保持不变**。它已经是 identity rendering 的权威源 —— 服务端 `extractMentions` 一直在用它，只是前端 schema 没把这条信息完整下发。

#### 4.3.3 `chatDetailSchema.participants` schema 升级

```ts
// 旧
chatDetailSchema = chatSchema.extend({
  participants: z.array(chatParticipantSchema),         // {agentId, role, mode, joinedAt}
});

// 新
chatDetailSchema = chatSchema.extend({
  participants: z.array(chatParticipantDetailSchema),   // 多了 name / displayName / type
});
```

`chatParticipantDetailSchema` **已存在**，原本就是为 mention 解析设计的（schema 文件注释明确写过）。这次修改是**回归原设计意图**，不是新建概念。

服务端 `GET /chats/:id` 的 participant 查询：**JOIN `agents` 表，但不应用 `agentVisibilityCondition`**。membership 才是这里的信任边界。

### 4.4 授权规则

#### 4.4.1 创建 agent
- 默认 `space = 'personal'`
- 创建者自动成为 owner（`managerId`）
- 任何组织成员都能创建，不需要 admin 权限

#### 4.4.2 加入 chat（核心规则）

| 被加入 agent 的 space | 谁能添加 |
|---|---|
| `personal` | **仅 owner 本人**，且 owner 必须是该 chat 的现有成员 |
| `team` | 该 chat 的任何现有成员 |

**强约束**：服务端 `POST /chats/:id/participants` 在 service 层校验，绕过 UI 走 API 也不能突破。

#### 4.4.3 从 chat 移除 agent

| 被移除 agent 的 space | 谁能移除 |
|---|---|
| `personal` | 仅 owner；或在 owner 已退出该 chat 后，chat 内任何成员可移除该 personal agent（避免僵尸成员） |
| `team` | chat admin / agent 自移除 |

#### 4.4.4 Promote（personal → team）
- 仅 owner 可执行
- 不需要团队审批
- UI 必须显式提示行为后果：
  > "Publishing makes this agent discoverable to all organization members. Anyone will be able to find it, search it, and add it to chats."
- 幂等

#### 4.4.5 Demote（team → personal）
- 仅 owner 可执行
- **前置条件**：该 agent 当前不在任何 group chat 中
  - 若不满足：要求 owner 先决定 (a) 一键退出所有 group chat 再 demote；或 (b) 取消操作
- 1:1 chat **不阻塞** demote —— 已建立的 1:1 不会因为对方 demote 而失效，仍是双方私有对话

### 4.5 信任边界："邀请即同意"

把 personal agent 拉进 group chat 这个**动作本身**，等同于 owner 做出以下声明：

> "我同意把这个 agent 的存在、名字、活动记录，**在这个 chat 的范围内**，对其他成员暴露。"

这条原则的四个性质：

| 性质 | 含义 |
|---|---|
| **Scoped** | 同意仅限被邀请进的那个 chat —— **不**意味着对组织全员公开 |
| **Revocable** | Owner 可随时把它移出 chat，"撤回同意" |
| **Owner-exclusive** | 别人无法替 owner 做这个决定 —— 他们在 picker 里都看不到这个 personal agent，服务端校验也会拒绝 |
| **Non-transitive** | A chat 内的其他成员**不能**把这个 personal agent "转邀请"进 B chat —— 邀请权始终归 owner |

这条原则把"暴露范围"的控制权**完全锁在 owner 手里**，同时不阻碍 "manager 拉自己 agent 进群" 这种最自然的用法。

### 4.6 默认值的选择：`personal`

| 选项 | 论据 |
|---|---|
| **默认 `personal`（采纳）** | 实际使用中 **绝大多数 agent 服务创建者本人**。默认 team 会导致 roster 爆炸（10 人 × 50 agent = 500 个 agent 涌入团队 UI），破坏团队产品可用性 |
| 默认 `team` | 与"team-first 产品定位"对齐，但与实际使用模式不符 |

**Defaults follow behavior, not aspiration.** 用户实际行为是绝大多数 agent 是私人的 —— 默认就该是私人。希望某个 agent 共享时显式 publish，是一次有意识的产品决策。

### 4.7 边界场景与语义

| 场景 | V4 模型下的语义 |
|---|---|
| 多个 owner 各自带 personal agent 进同一群 | OK —— 每个 personal agent 独立 scoped consent；每个 owner 各自决定自己 agent 的去留 |
| Personal agent 在群里：对所有人可见 vs 仅对 owner 可见？ | **对所有 chat 成员可见**（identity = membership 的派生）；这是 "邀请即同意" 的直接含义 |
| Personal agent 主动 outbound DM 给陌生人 | **禁止**（Out-of-scope，后续 RFC）—— Personal agent 只能在 owner 已在场的 chat 内发言，或回应已发起的会话；主动联系陌生人破坏 personal 的语义边界 |
| Team admin 能看到其他成员的 personal agent 列表吗？ | **不能**。Admin 是治理/运维角色，不是隐私豁免角色。审计需求走独立的 audit log 子系统，不污染 discovery filter |
| Personal agent 历史消息中的名字（agent 后来被移除/删除）| **Snapshot at message time** —— 消息体内存储发送时的 `displayName` 快照，不依赖事后 lookup |
| Owner 离职 / 账户失效 | Personal agent 进入"孤儿"状态。运维操作：管理员可一键 transfer ownership 或归档；UI 在 chat 内继续显示该 agent 但 disable 配置入口 |
| Personal agent 跨 owner 转让 | `space` 不变（仍是 personal），换 `managerId`；现有 chat 关系不动 |
| Owner 从 chat 退出 | **他带进来的 personal agent 一起退出**（personal 是 owner 的延伸；owner 不在场，他的 personal agent 不应留下） |
| Owner 退出但其他人想留下他的 personal agent | 不允许 —— 想留下，先 promote 成 team |
| 团队解散 / 组织删除 | Personal agent 跟随 owner 转出（如果支持跨 org 转移），否则一并删除 |
| 1:1 chat 中对方是其他人的 personal agent | 合法 —— 1:1 是已建立的私有通道；与 group 的 "邀请即同意" 等价（owner 发起 1:1 = 同意暴露给对方） |

### 4.8 验证 ① — 不变量与"不可表达的坏状态"

模型设计目标之一是**让一类 bug 在数据通路层面就不可能发生**。以下"奇怪状态"在本模型下**不可被表达**：

| 不可表达的坏状态 | 为什么不可能 |
|---|---|
| "Personal agent 在群里但其他人看到的是 UUID" | Identity 取自 `chat_membership JOIN agents`，没有走 visibility filter 的代码路径 |
| "我搜不到的 agent 突然主动 @ 我" | 它要 @ 我必须先在同一个 chat 里；进 chat 触发 system message，我看得到它的加入 |
| "看不见的 agent 在静默读群消息" | 进 chat 触发 system message + 出现在 participants header；没有"隐身参与者"概念 |
| "别人替我把我的 personal agent 拉进群" | 他们在 picker 里都看不到我的 personal agent；服务端校验同时拒绝 |
| "Personal agent 出现在某人的 team roster" | `space` 字段直接驱动 discovery query；team roster 仅查 `space='team'` |
| "我离开了 chat，但我的 personal agent 留在群里继续发言" | Owner-leaves-chat hook 自动级联移除其 personal agents |
| "Demote 一个还在 group chat 里的 team agent，结果它瞬间不可见" | Demote 前置条件校验拒绝；UI 强制用户先决定退群 |

### 4.9 验证 ② — 与现实直觉的对齐

| 现实场景 | 模型对应 |
|---|---|
| 我邀请朋友参加同事聚会 → 同事认识我朋友；聚会结束后同事不会自动加他微信 | Personal agent 进 chat → chat 内成员看到它；退出后无 discovery 入口让人主动找它 |
| Slack 把个人 bot `/invite` 到 channel | 完全对应：owner 自主决定哪个 channel 暴露它 |
| Notion 个人页 share 给 channel | 完全对应：scoped consent + 可撤回 |
| Slack 私聊看到对方名字 ≠ 在 channel 里能 @ 对方 | 跟 "identity 是 chat-scoped" 同构 |
| GitHub draft PR | Personal agent ≈ private/draft 状态；publish 显式发布 |
| 公司里把个人电脑接入公司 Wi-Fi → IT 能看到设备名，但不会被加进 IT 资产清单 | 邀请即同意 + 仍然在 owner 控制下 |

### 4.10 验证 ③ — 与现有代码的契合度

模型几乎是对现有代码"语义补完"，不是推倒重来：

| 现有代码 / 数据 | 本模型下的角色 |
|---|---|
| 服务端 `extractMentions(content, participants)` 用 `chat_membership`、不查 visibility | **已经符合本模型** —— 服务端信任边界本来就对，bug 只在前端 |
| `chatParticipantDetailSchema` 已存在，注释明确为 mention 服务 | **设计意图本来就是本模型** —— 只是 `chatDetailSchema.participants` 没正确使用它 |
| `agentVisibilityCondition` 用于 `/agents`、`/activity` | **正确，保留** —— 它本来就该只服务于 discovery，文档化这个约束即可（改名为 `agentDiscoveryScope` 更准确） |
| 前端 `useAgentIdentityMap` 走 visibility-filtered `/agents` | **保留作兜底**（覆盖非 chat 上下文：自己、历史成员、跨 org agent）；主路径改为读 `participants[i].name/displayName` |
| `managerId` 字段 | **保留**，含义不变（owner） |
| `chat_membership` 表结构 | **保留**，不动 |
| `ParticipantsHeader` UUID 兜底逻辑（`id.slice(0, 8)`）| **删除** —— 本模型下不会发生 `ident === null` 的情况 |

> 现有代码的多个独立片段都隐含地实现了本模型的局部，只是没系统化。**这次设计是把"服务端已经有的信任边界"补全到前端，并清理 visibility 字段被滥用的多重职责。**

### 4.11 Out of Scope

以下需求本 RFC 显式**不解**，后续单独议：

| 议题 | 为什么不在本 RFC 内 |
|---|---|
| **真·机密级 agent**（连进 chat 都需要审批/受限） | 是另一条正交轴，建议加独立 `confidential` flag，不与 `space` 混 |
| **Personal agent 跨 owner 的 P2P 通信** | 涉及 personal 语义边界的扩展，需独立隐私设计 RFC |
| **Multi-owner / coManagers** | 涉及 `managerId` → `managers[]` 重构，独立 RFC |
| **Audit / 合规视图**（admin 看所有 agent 含 personal） | 走 audit log 子系统，不动 discovery filter |
| **Cross-org agent 转移** | 涉及 org 治理边界，独立 RFC |
| **基于 agent type / role 的额外授权矩阵**（runtime agent vs schedule agent vs ...） | 与 space 正交，独立设计 |

---

## 5. TODO

### P0 — 修 #372 当前 bug（治标 + 直接落地 identity 侧）

- [ ] **shared schema**：`packages/shared/src/schemas/chat.ts` 把 `chatDetailSchema.participants` 从 `chatParticipantSchema` 改为 `chatParticipantDetailSchema`
- [ ] **server**：`packages/server/src/api/chats.ts` 的 `GET /chats/:id` handler，participant 查询 JOIN `agents` 表，附带 `name / displayName / type`；**不应用** `agentVisibilityCondition`（关键：membership 才是这里的信任边界）
- [ ] **server 测试**：补一个 case —— 群内有 private agent 且 caller 不是其 manager 时，`GET /chats/:id` 返回的 participants 包含其完整 name/displayName
- [ ] **web `chat-view.tsx:873-904`**：autocomplete 候选构造时，对 `chatDetail.participants` 直接读 `p.name / p.displayName`，不再过 `agentIdentity()`；只对 `activity.agents` 段继续用 identity map
- [ ] **web `chat-view.tsx:1670-1692`** `ParticipantsHeader`：渲染 chip 时优先用 participant 自带的 name；identity map 仅做"自己 / 历史成员"兜底
- [ ] **web 测试**：autocomplete + ParticipantsHeader 各加一个集成测试，覆盖"群里有不归我管的 private agent"
- [ ] **回归测试**：消息列表里 sender 是别人 private agent 时显示真名（是否同源问题待验，可能要扩到 message schema）

### P1 — 落地 discovery 侧 + 改名澄清语义

- [ ] **数据库迁移**：`agents.visibility` 字段重命名为 `agents.space`，值域 `private → personal`、`organization → team`；migration 写好回滚
- [ ] **shared schemas / types**：`AGENT_VISIBILITY` → `AGENT_SPACE`；导出名同步更新（注意保留旧导出别名一段时间方便迁移）
- [ ] **server `access-control.ts`**：`agentVisibilityCondition` 改名 `agentDiscoveryScope`，语义保持（`space=team OR ownerId=me`），但**明确文档：只用于 discovery，不应用于 chat-scoped queries**
- [ ] **server add-participant API**：`POST /chats/:id/participants` 新增校验 —— 如果被加入 agent 的 `space=personal`，必须由其 owner 添加；否则 403
- [ ] **server remove-participant API**：personal agent 仅 owner 可移除（admin 例外可选）
- [ ] **server owner-leaves-chat hook**：owner 退出 chat 时级联移除其 personal agents
- [ ] **server demote 前置校验**：`PATCH /agents/:id` 把 `space=team` 改 `space=personal` 时拒绝（若该 agent 仍在 group chat 中），返回需要处理的 chat 列表
- [ ] **web agent 设置 UI**：toggle 文案改为 "Space: Personal / Team"，加 helper text：
  > Personal: only you can find and address this agent. You can bring it into any chat you're part of — everyone in that chat will see it normally.
  > Team: discoverable to everyone in your organization.
- [ ] **web 新建 agent 默认值**：`space = personal`（明确符合"大多数 agent 服务创建者自己"的事实）
- [ ] **web sidebar**：分组显示 "Team agents" / "My agents"

### P2 — 修补遗留与边界

- [ ] **历史消息 name 显示**：评估是否把 message 里的 sender displayName snapshot 进消息体（避免移除后历史 UUID 化）
- [ ] **agent 详情页加 "Visible in chats" 反向列表**：让 owner 直观看到自己 personal agent 被暴露在哪些 chat 里
- [ ] **现有 leak 状态盘点**：扫一遍当前 production 数据，是否有 `visibility=private` 的 agent 在 group chat 里 + 群里有非 manager 成员的情况；列清单，给对应 manager 弹一次 "你之前把 X 加进了 Y 群，是否要 Publish to team / Remove from chat" 的决策卡片
- [ ] **Confidential flag（如果有需求）**：独立于 space 的额外 flag，启用后即使 owner 也不能拉进任何含非授权成员的 chat（模型预留接口，不做实现）

### P3 — 文档与传达

- [ ] **写一段 `docs/concepts/agent-space.md`** 解释 personal / team / membership 三件事的关系
- [ ] **回 Issue #372**：贴出本 RFC 链接，cc yuezengwu / serena 一起 review
- [ ] **changelog 提示**：visibility → space 迁移对 API 消费者（CLI、外部脚本）的影响清单

---

## 6. 决策检查清单（review 时回答这几个问题就能判断接不接受这个模型）

1. **降噪需求**：你认同 "大部分 agent 服务创建者本人，team-visible 默认会污染 roster" 这个事实吗？ → 决定要不要保留 personal / team 二分
2. **拉自己 agent 进群**：你认同 "owner 把自己 personal agent 拉进自己参与的 chat 是自然用法" 吗？ → 决定 personal 是不是"完全隔离"还是"邀请即同意"
3. **chat 内的身份可见性**：你认同 "同一 chat 的成员应该看到彼此真名"（包括别人 personal agent）吗？ → 决定 identity rendering 是否脱离 visibility filter
4. **默认值**：新建 agent 默认 `space=personal` 你同意吗？ → 决定 onboarding 默认体验
5. **改名**：把 `visibility` 改成 `space` 你同意吗？这是文案 + 迁移成本 vs 语义清晰度的取舍

如果 5 条都 ✅，直接进 P0 + P1。如果有疑虑，先在对应那一条上拉齐再动手。
