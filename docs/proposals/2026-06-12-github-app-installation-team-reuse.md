# GitHub App Installation 跨 Team 复用 — 问题与设计 Brief

> **状态：** 提交架构评审的问题 brief。
> **本文边界：** 定义问题、用户体验痛点、优化目标，以及一组候选方向。本文
> **刻意不选定技术方案** —— 那是架构师的决定。§4 的硬约束来自一轮多视角
> review，列在这里是为了让架构师直接继承已知陷阱，而不必重新踩一遍。
> **日期：** 2026-06-12 · **位置：** `docs/proposals/`（若团队有别的约定可挪）。

---

## 0. 一句话总览

First Tree 的一个 **team** 连接一个 **GitHub App installation** 来给它的 agent
仓库访问权限。今天这个绑定是 **1:1** —— 一个 installation 只能服务一个 team。
一个用户如果用**同一个 GitHub 账号**运行**多个 team**（真实但非主流的形态：创始人
的"个人" + "公司"两个 team、按客户分 team 的代理商、按小组拆分的 org），就**无法
复用**这个 installation。第二个 team 撞上一个**硬死路**，而错误提示指向的恢复 UI
**根本不存在**。

方向性的修复是：**把"谁拥有这个 installation"和"哪些 team 引用它"解耦。** 正确的
*心智模型*是 installation 属于装它的那个 **GitHub 账号**（已经记在 `accountGithubId`
里），而不是属于某一个 team。如何*实现*这个解耦 —— 以及现在到底要不要做 —— 是
架构师的判断。本文负责把问题和护栏讲清楚。

---

## 1. 背景 — installation 今天怎么工作

一个 team（`organizations` 行）运行 AI agent。为了让 agent 读写某个 repo，team 连接
一个 **GitHub App installation**。一个 installation 同时提供三样东西（见
`packages/server/src/db/schema/github-app-installations.ts:10-22`）：

1. **用户 OAuth**（登录 token），
2. **Webhook 流** —— 入站 GitHub 事件靠 installation 解析到对应 team，
3. **Installation token** —— 短时效的 server-to-server token，按需 mint，agent 的
   git 操作用它。

这个 installation token 是 **installation 级、tenant-blind（不认租户）** 的：
`mintContextTreeInstallationToken` 只从 `installation.installationId` mint，**不带
任何 First Tree org 身份**（`packages/server/src/services/github-app-token.ts:52,72`）。
它能读写 **installation 被授权的所有 repo**，与哪个 team、哪个成员触发无关。记住
这一点 —— 它是 §4 安全约束的核心。

---

## 2. 现状与问题

### 2.1 核心约束：installation ↔ team 是 1:1

绑定存在 `github_app_installations.hubOrganizationId`，带一个 **UNIQUE** 约束强制
1:1（`schema/github-app-installations.ts:69` 列，`:100` 的 `uq_..._hub_org`）。没有
"rebind"或"share"路径 —— 一旦绑定就永不移动（`bindInstallationToOrg` 对任何第二个
org 抛 `ConflictError`，`services/github-app-installations.ts:149-205`，错误在 `:204`）。

### 2.2 用户体验问题  ← **本 brief 的核心**

**(a) 是硬死路，不是降级体验。**
用户有 team A（已连 GitHub 账号 `acme`），又建了 team B，想让 B 的 agent 在同一批
`acme` repo 上干活。在 connect-code 步骤，team B 没有 installation，所以界面只给
**"Install on GitHub"**（`packages/web/src/pages/onboarding/steps/step-connect-code.tsx`）。
点它跳到 GitHub —— 但 App 在 `acme` 上**已经装了** —— GitHub 直接把用户弹回来，
带着*已有的* `installation_id`。回调试图把它绑到 team B，然后**拒绝**：
`ConflictError "...refusing to rebind (D2 1:1)"`。用户**没有任何受支持的出路**，
除非在 GitHub 上把 App 卸载（那会搞坏 team A）。

**(b) 错误提示指向一个不存在的恢复 UI。**
冲突消息让用户"从 Settings transfer the binding"，但唯一的 transfer/claim 机制
（`POST /claim`）是 **API-only、没有 Settings UI** —— 明确记录为未交付
（`api/orgs/github-app.ts:262-266`，`#318`）。所以产品给的唯一指引，指向一个**不存在
的按钮**。

**(c) 表演性的"重装"。**
GitHub 侧其实啥也没重装 —— App 和它的 repo 授权在 `acme` 上早就有了。用户被推着
走一遍安装仪式，除了触发冲突什么都没做。从用户视角，他们被要求为一个**已经设置好
的**账号"再设置一次 GitHub"。

**(d) 每个新 team 都像从头再连一遍 GitHub。**
onboarding 对每个新 team 重走 connect-code + kickoff 步骤（create-agent 这一闸按
per-org 设计，`packages/server/src/api/me.ts:81-90`）。这部分是**对的** —— agent 是
per-team 的。但因为 installation 复用被堵死，"连接你的代码"在用户读来就是"再做一遍
GitHub 那套"，哪怕他们的 GitHub 侧根本没变。

**净 UX 判断：** 产品默默假设了*一个人 = 一个 team = 一个 GitHub 账号*。用户一旦
走出这个假设（一个常见的 power-user 和代理商形态），就撞上一堵墙，带着误导性的指引，
没有出口。

### 2.3 概念问题：`hubOrganizationId` 是混淆的归属

这一列身兼**三职**：可空-以适配插入顺序（webhook 可能在 owning team 存在之前先插
这行）、`ON DELETE SET NULL`、**以及**一个 UNIQUE 归属声明（`schema:26-34,63-69`）。
正是这个职责重载催生了一整套维持一致性的子系统 —— 孤儿检测
（`findUnboundInstallationsByAccount:356`）、登录时的 reclaim sweep
（`auth/github.ts:463-497`）、`/claim` 恢复 hatch。installation 的**真正的、稳定的
owner 是 `accountGithubId`**（notNull、indexed、按其自身 jsdoc 不可变，`schema:57-62`）。
归属-到-账号是诚实的模型；归属-到-org-指针是最初的错误。

### 2.4 衍生复杂度

bind/orphan/reclaim/claim 这套机制里，很大一部分**只为**守护 1:1 不变量而存在。无论
选哪个方向，这都是个退役偶发复杂度的机会 —— 但注意（§4）其中一部分是为真实失败模式
负载的，不能简单删掉。

---

## 3. 优化目标（UX 与功能设计）

从**用户**视角：

1. **复用，不是重装。** 用户如果已经连过一个 GitHub 账号，新 team 应该让他**一键
   复用** —— 不走安装仪式，不撞冲突。
2. **没有死路。** 每个状态都有清晰的下一步。如果某个东西确实不能复用，说清为什么、
   该怎么办 —— 并且确保它指的那条路真的存在。
3. **connect-code 应该给选择，而不是一个强制按钮。** 当用户的 GitHub 账号已经有
   installation 时，把*"用你已经连过的 GitHub（`acme`）"*和*"连一个别的 org"*并排
   呈现。

从**功能 / 安全**视角：

4. **保持租户隔离。** 复用绝不能变成一条把某个账号的私有 repo 访问权泄露给一个
   "成员与该账号毫无关系"的 team 的路。（这是难点 —— 见 §4 R1。）
5. **退役误导性的恢复路径。** "transfer from Settings"消息和未交付的 `/claim` UI
   要有个了断。

从**系统卫生**视角：

6. 借此机会退役偶发的 bind/orphan/reclaim 复杂度，但只在安全的范围内（不要删掉处理
   真实失败模式的那部分 —— 见 §4 R5）。

**当前非目标：** 给一个 team 连**多个不同**的 installation；以及任何对 per-team
agent 模型的改动。本 brief 只关注**把一个账号的 installation 在同一个用户的多个
team 之间共享**。

---

## 4. 任何方案都必须满足的硬约束

以下来自一轮多视角 review（产品、数据模型、webhook、安全、迁移、红队）。它们是
**必解**的，与架构师最终选哪种存储设计无关。每条都已对照代码核实。

**R1 — 租户隔离 / 授权（BLOCKER 级）。**
installation token 是 tenant-blind 的（§1）。今天对"你到底是不是这个 installation
的管理员？"的*唯一*强制点（`verifyUserCanAdministerInstallation`，
`api/orgs/github-app.ts:309`）发生在**绑定时**（OAuth 回调）和 `/claim`。任何让 team
通过一个廉价指针引用 installation 的复用设计，**都必须在连接时保留一个显式的、重新
校验的授权步骤** —— 否则一个能管理 installation X 的 team admin，就能把 X 的私有
repo 完整读写权授予**他 team 的每一个成员**。注意这个暴露不是只读的：`/repositories`
列出**全量** installation repo 集且无 per-team 过滤（`api/orgs/github-app.ts:161-195`），
`/initialize` 还**写**（administration + contents）。**需要产品决策：** "team = repo
访问的共享信任边界"是预期的吗？（见 §6.1。）答案决定 per-repo 闸是否也必须延伸到
token-minting 端点，而不只是 webhook。

**R2 — 存储 primitive。**
team→installation 这个链接是一个**有生命周期、有授权故事的关系**，不是自由格式
config。它需要一个真正的外键（用于级联清理）和**双向**索引（team→installation 给读，
installation→teams 给 webhook fan-out）。给架构师的提醒：`organization_settings` 这
个 KV 存储**不是**可行的家 —— 它的 namespace registry 是一个封闭的编译期集合，运行
时拒绝动态 key（`shared/src/schemas/org-settings.ts` registry + `services/org-settings.ts:31-35`
的运行时 guard），而它 `(orgId, namespace)` 的主键会把反查逼成最热的 webhook 路径
上的无索引 JSONB 扫描。

**R3 — Webhook fan-out 撞全局 dedup（BLOCKER 级）。**
如果一个 installation 服务 N 个 team，一条入站 repo 事件就可能要送达多个 team。两
个事实正面冲突：(a) 投递 pipeline 硬绑定到**单个** `event.source.organizationId` ——
`resolveAudience` 把它当标量读（`services/github-audience.ts:120`），`setEntityState`
用单个 org 调用（`api/webhooks/github-app.ts:269`）；(b) `claimEvent` 按
`(deliveryId, 'github')` 做 dedup，**全局 per-delivery**（`services/event-dedup.ts:10-15`）。
天真 fan-out 下，第一个 team claim 了这条 delivery，**其余 team 全被静默 dedup 掉** ——
也就是说，这个方案存在的目的（多 team 投递）**对超过一个 team 根本不触发**。任何
fan-out 设计都必须**把 dedup re-key 成 `(deliveryId, organizationId)`**，把 claim
移到 per-team 循环内部，并定义 per-team 的部分失败语义。

**R4 — Repo 授权数据 + canonicalize。**
"只有选了这个 repo 的 team 才收事件"这个过滤器是想要的，但它依赖一份我们没存的数据：
`installation_repositories` webhook 是 **no-op**（`api/webhooks/github-app.ts:117`），所
以 per-installation 的授权没持久化；可用的代理是 `resources.repoCanonicalKey`（team
自声明），它会和真实的 GitHub 授权**双向漂移**。还有：目前**没有任何路径**能把 webhook
的 `repository.full_name`（"owner/repo"）转成 `repoCanonicalKey` ——
`canonicalizeResourceRepoUrl` 需要完整 URL，对裸 slug 会 throw。一个 repo 级的
fan-out 过滤器必须用资源写入路径所用的**同一个**函数，从 `repository.html_url` /
`clone_url` 做 canonicalize，并加 parity 测试。（或者把 per-repo 过滤降级为"fan out 给
所有引用该 installation 的 team"。）

**R5 — 链接生命周期 / 撤销。**
`deleteInstallationByGithubId` 是硬删行（`services/github-app-installations.ts:304`）；
没有真外键的话，每个 team 引用都会悬空且无清理。而且初次连接后没有对管理权的重新
校验 —— 一个被降级的 GitHub-org admin 会一直能 mint token。无论谁来存这个链接，都必须
对 `installation:deleted` / `suspend` 做出反应（null/flag 这些链接），并定义 Org-type
admin 权限何时/如何重新核验。

**清单提醒（别漏）：** 存储改动会触及的 `hubOrganizationId` 读取点有：
`findInstallationByOrg:333`、`bindInstallationToOrg:149-205`、
`findUnboundInstallationsByAccount:356`、**`countInstallationsForOrg:378`**（容易漏）、
webhook router（`webhooks/github-app.ts:235,246,269`）、OAuth 回调的 bind + reclaim
（`auth/github.ts:454,475-479`）。前向读取消费端（`chats.ts:206`、`context-tree.ts:51`、
`context-tree-snapshot.ts:46`、`orgs/github-app.ts:82,130,163`）已审计，**不**从行上读
`hubOrganizationId` —— 所以只要保留一个 `findInstallationByOrg` 形状的访问器，它们就
透明不变。

---

## 5. 候选方向（供架构师 —— 本文不下结论）

三种形态，scope 递增。取舍如下；架构师选定（也可组合，例如先用 A 上线、灰度演进到 B）。

| | **A — 最小** | **B — Junction 表** | **C — 账号拥有 + 指针** |
|---|---|---|---|
| 思路 | 只删 `uq_..._hub_org`；把 `hubOrganizationId` 留成**带类型的非唯一 FK** | 新建 `org_installation_links(organizationId PK, installationId FK)` 表 | installation 归 `accountGithubId` 所有；team 持一个引用 |
| 是否启用复用 | 一个 installation → 多个 team（每个 team 仍 ≤1 installation） | 同样，更干净 | 同样 |
| 读路径（team→install） | 单次索引查找，不变 | 索引 | 索引（经指针） |
| Fan-out（install→teams） | 需要给 `hubOrganizationId`（现在非唯一）加新索引 | **双向天然索引** | 需要一个有索引的反查 |
| FK / 级联清理（R5） | 部分（列级 FK） | **是，天然** | 取决于指针存哪 |
| 授权闸（R1） | 必须在连接时加 | "谁连接的 + 重新核验"的天然家 | 必须在连接时加 |
| 迁移 | 一行删索引 | 从现有绑定回填 links | 回填 + 重新解释归属 |
| 爆炸半径 | 最小 | 中 | 最大 |
| 退役 bind/orphan/claim 复杂度 | 否 | 部分 | 最多 |

**review 倾向（是输入，不是决定）：** 一张 **junction 表（B），配一个连接时授权闸，分阶段
上线**，因为它"免费"解决 R2/R5（真外键 + 级联 + 双向索引），并给"谁连接的、是否还有效"
这个审计型能力一个天然的家。review 也指出：如果实测需求接近零（见 §6.2），**A** 是一个
站得住的最小交付。"账号拥有"（C）是上述三者共同的正确**心智模型** —— junction 表是它的
一种诚实实现，两者不冲突。**最终选择是架构师的。**

---

## 6. 开放产品问题（开工前先定）

1. **信任声明（决定 R1）。** "一个 team 是 repo 访问的共享信任边界"是预期模型吗？如果
   **是**，在连接 UI 里写明；如果**否**，per-repo 闸必须延伸到 token-minting 的读写
   端点，而不只是 webhook。
2. **需求。** 那个 `ConflictError "refusing to rebind"` 到底多久触发一次？这个改动背后
   目前是**零实测需求**。在押注 B/C 而非 A 之前，应该先做一次小埋点（统计这个冲突 +
   "team 没 installation 但用户在别处有"这个状态）。
3. **多 team / 同 repo 的 fan-out 语义。** 当两个 team 引用同一个 installation **且**
   同一个 repo 时，两个 team 的 agent 都该响应，还是去重到一个？这决定 dedup key 的
   形状（R3）。
4. **Org-type "谁可用"的缓存。** 列出一个用户可复用哪些 installation，对 Org-type
   install 需要对每个候选 org 打一次实时 `GET /user/memberships/orgs`。在 connect-code
   列表上线前定义缓存 TTL 和撤销故事，否则新 UX 每次加载页面会做 N 次 GitHub 往返。

---

## 7. 建议的推进路径

1. **先埋点**（§6.2） —— 用真实频率来给投入定规模。
2. **先答信任声明**（§6.1） —— 这是产品决策，它决定安全设计，与存储选型无关。
3. **架构师对照 §4 约束选定** §5 里的一个方向。
4. 无论选哪个方向，**修掉那个误导性的恢复 UX**（§2.2b） —— "transfer from Settings"
   消息不该指向一个未交付的 UI。

---

## 附录 — 代码引用索引

| 关注点 | 位置 |
|---|---|
| 1:1 UNIQUE 约束 | `db/schema/github-app-installations.ts:100` |
| 真 owner 列 | `db/schema/github-app-installations.ts:62`（`accountGithubId`） |
| 混淆归属列 | `db/schema/github-app-installations.ts:69`（`hubOrganizationId`） |
| 拒绝 rebind | `services/github-app-installations.ts:149-205`（`:204` 错误） |
| tenant-blind token mint | `services/github-app-token.ts:52,72` |
| 前向读访问器 | `services/github-app-installations.ts:333`（`findInstallationByOrg`） |
| 孤儿 reclaim 机制 | `services/github-app-installations.ts:356`、`api/auth/github.ts:463-497` |
| 容易漏的 `hubOrganizationId` 读取点 | `services/github-app-installations.ts:378`（`countInstallationsForOrg`） |
| 授权证明 helper（复用它） | `api/orgs/github-app.ts:309`（`verifyUserCanAdministerInstallation`） |
| API-only 的 `/claim`，无 UI（#318） | `api/orgs/github-app.ts:262-266` |
| Webhook route + 单 org 假设 | `api/webhooks/github-app.ts:225-247,269` |
| `installation_repositories` no-op | `api/webhooks/github-app.ts:117` |
| 全局 delivery dedup | `services/event-dedup.ts:10-15` |
| 单 org audience 范围 | `services/github-audience.ts:120` |
| 全量 repo 列表，无 per-team 过滤 | `api/orgs/github-app.ts:161-195` |
| repo 选择持久化 | `services/resources-migration.ts:243`（`repoCanonicalKey`） |
| org_settings 封闭 registry | `services/org-settings.ts:31-35` |
| connect-code UI | `packages/web/src/pages/onboarding/steps/step-connect-code.tsx` |
