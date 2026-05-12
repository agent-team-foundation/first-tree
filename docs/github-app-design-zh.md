# GitHub App 迁移设计

**状态**：Phase 1 实现进行中（PR-300）。原决策（§4）保留；§5 已根据 codex review/challenge 的发现做了**实施层修订**；§10 是 codex 找到的设计层 finding 的完整记录。
**范围**：把 Hub 现有 GitHub OAuth App 升级为 GitHub App，统一承载用户登录、webhook 接入、未来 server-side 写能力三类需求。
**不在范围**：first-tree-automation 的实际吸收、Phase 4 identity convergence（成员自动同步）的落地、Step 4（GitHub Automation workflow installer）。

---

## 1. 背景与动机

### 1.1 现状

- **用户登录**：OAuth App，scope `read:user user:email repo`，access token 加密存在 `auth_identities.metadata.accessToken`。代码：[packages/server/src/api/auth/github.ts](../packages/server/src/api/auth/github.ts)。
- **Webhook 接入**：传统 per-repo webhook 模型。每个 Hub org 一个加密的 webhook secret，存在 `organization_settings.github_integration.webhookSecretCipher`。Endpoint：`/api/v1/webhooks/github/<orgId>`。代码：[packages/server/src/api/webhooks/github.ts](../packages/server/src/api/webhooks/github.ts)，最近的硬化在 commit `0fd1c6f` (#283)（deterministic 路由 + delivery dedup）。
- **GitHub-side 写**：完全由本地 agent 通过用户机器上的 `gh` CLI / claude-code 工具链执行。Hub server **不直接写 GitHub**（Stateless Server 不变量）。

### 1.2 核心痛点

per-repo webhook 模型迫使 admin 在 **每一个想接的 GitHub repo** 的 Settings → Webhooks 手动粘贴 URL + secret。新增 repo 要再来一遍。这是接入流程里**唯一一个非自助的步骤**。

### 1.3 GitHub App 的解法

| 能力 | OAuth App + per-repo webhook | GitHub App + installation |
|---|---|---|
| 新增 repo 接入 | admin 手动 per-repo 配置 | 装 App 时勾选，或事后在 GitHub 上一次性勾选 |
| Webhook secret 管理 | 每个 org 一个，AES 加密存 DB | App 全局一个，存 env |
| Org-level 事件（member、repo 新建） | 拿不到 | 拿得到 |
| 跨 repo dedup | 自己做（即 #283 在做的事） | App delivery 自带唯一 ID |
| Hub org ↔ GitHub owner 的绑定 | 没有，间接靠 secret 关联 | `installation_id` 就是显式绑定 |

---

## 2. 设计原则

1. **一个 installation 解锁三件事**：用户安装 App 是一次性动作，同时启用 user OAuth、webhook stream、installation token 三种能力。三者**共用同一个 installation**。
2. **Hub server 不直接写 GitHub（暂时）**：installation token 能力在 App 里预埋，但 Phase 4 之前不主动调用。Hub 仍然把 GitHub 写操作委托给本地 agent / `gh` CLI。
3. **Permission 一次性声明完整 read+write**：避免后续扩 permission 时 GitHub 给 admin 推送 "review new permissions" 通知。安装对话框看起来"重"，但用户从此不再被打扰。
4. **OAuth 平移要无感**：登录 UX 不变。User access token 由不过期变成 8h TTL + refresh，是内部机制变化。
5. **Webhook 下游 pipeline 不动**：现有 `github-adapter` agent 模式 + #283 的路由/dedup 逻辑保留，新 App webhook 仅替换上游 ingestion 层。

---

## 3. 一个 installation 三种能力

| 能力 | 用途 | 启用时机 |
|---|---|---|
| User OAuth（user-to-server token）| 登录身份；列 `/user/repos` 给 picker | Day 1 平移 |
| Webhook stream（passive ingestion）| 接 issue / PR / push / member 事件，喂 `github-adapter` agent pipeline | Day 1 |
| Installation token（server-to-server）| Hub server 自己当 GitHub 身份去写（开 PR、读 org members 等）| **预埋**，Phase 4 identity convergence 启用 |

---

## 4. 决策（全部已定）

| ID | 决策 | 备注 |
|---|---|---|
| **D0a** | 做 GitHub App，替代现有 OAuth App | 主理由是 webhook 自助化 |
| **D0b** | Permission 声明策略 A：一次性声明完整 read+write | 避免未来 admin 被 GitHub 弹 "review new permissions" |
| **D1** | Install 触发点 = 登录即安装 | 走 GitHub 的 "Request user authorization (OAuth) during installation"。一个跳转完成 OAuth + install + repo 选择 |
| **D2** | 覆盖范围 = Org + Personal 都接 | `installation.account_type ∈ {"User", "Organization"}`，1:1 绑到 Hub team |
| **D3** | 老 per-repo webhook = **硬切**，无兼容窗口 | 现阶段无外部用户，直接下掉 `/api/v1/webhooks/github/<orgId>` 和 `webhookSecretCipher` 字段 |
| **D4** | first-tree-automation **不并**到 Hub App | 保持独立部署。Hub App permissions **不再为 automation 留余量**（移除 `workflows:write`）|

---

## 5. 关键改动

### 5.1 GitHub App 创建（GitHub UI 一次性配置）

- **Where can this GitHub App be installed**：Any account（对应 D2）
- **Request user authorization (OAuth) during installation**：enabled（对应 D1）
- **Expire user authorization tokens**：enabled（D1 推论；否则 user-to-server token 不带 `expires_in`，refresh-token 路径失效）
- **Setup URL** (post-install redirect)：`<publicUrl>/auth/github/complete`（让用户装完 App 后直接回到 Hub）
- **Webhook URL**：`<publicUrl>/api/v1/webhooks/github`（单一 endpoint，不带 orgId）
- **App slug**：记下来，写到 `FIRST_TREE_HUB_GITHUB_APP_SLUG`。安装 URL 是 `https://github.com/apps/<slug>/installations/new`——不是 OAuth `authorize` URL（实现细节，见 §10 P1-1）
- **Permissions**（对应 D0b，一次性声明 Hub 自身需要的全部读+写）：
  - Repository: `contents:write`, `pull_requests:write`, `issues:read`, `metadata:read`
  - Organization: `members:read`
  - 不声明 `workflows:write`（D4：automation 独立部署，Hub App 不接管 workflow 安装）
- **Events 订阅**：`issues`, `issue_comment`, `pull_request`, `pull_request_review`, `push`, `installation`, `installation_repositories`, `member`

需要在 staging 和 prod 两个环境各创建一个 App。本团队 dev 与 staging 共用同一套部署，所以两套 App 即可——dev 直接复用 staging 的 App 凭证。

### 5.2 Env / Secrets

新增（实现层全部 Zod `.min(1)`——空字符串拒绝在 boot，详见 §10 P1-8）：

- `FIRST_TREE_HUB_GITHUB_APP_ID`
- `FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY`（PKCS#8 PEM；boot guard 检查 `-----BEGIN PRIVATE KEY-----` 头，建议走 secret manager 而非直接拼字符串）
- `FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET`
- `FIRST_TREE_HUB_GITHUB_APP_CLIENT_ID`
- `FIRST_TREE_HUB_GITHUB_APP_CLIENT_SECRET`
- `FIRST_TREE_HUB_GITHUB_APP_SLUG`（用于构造安装 URL，见 §5.1）

附加安全 env（**非必填，但默认 fail-closed**）：

- `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED`：必须显式设为 `"1"` 或 `"true"`，dev-callback 旁路才生效。未设 → 404。详见 §10 P1-9。

老 env `FIRST_TREE_HUB_GITHUB_OAUTH_CLIENT_ID/_SECRET` 在新 App 上线确认稳定后**删除**（D3 硬切，无长期保留必要；上线前一个 release 可短期保留作为紧急回滚后路）。

Boot 时（`buildApp` 入口）有 fail-closed 检查：所有 5 个 App env 必须**要么全设、要么全不设**——半配置直接 throw 启动失败，避免出现 "client_id 在但 secret 空" 这种状态下生成可被伪造的 HMAC。

### 5.3 DB Schema

新增表（独立于现有 `organization_settings.github_integration`，避免新老数据搅在一起）：

```sql
CREATE TABLE github_app_installations (
  id UUID PRIMARY KEY,
  installation_id BIGINT UNIQUE NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('User','Organization')),
  account_login TEXT NOT NULL,
  account_github_id BIGINT NOT NULL,
  hub_organization_id UUID UNIQUE REFERENCES organizations(id),
  permissions JSONB NOT NULL,
  events JSONB NOT NULL,
  suspended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`auth_identities.metadata` 扩展：

- `accessToken` 语义改为 "App user-to-server token"
- 新增 `refreshToken`（加密）
- 新增 `accessTokenExpiresAt`、`refreshTokenExpiresAt`

### 5.4 Server 改动

| 路径 | 改动 |
|---|---|
| [api/auth/github.ts](../packages/server/src/api/auth/github.ts) | OAuth start endpoint 切换到 App user authorization URL；callback 处理 `installation_id`（**必经鉴权步骤**——`/user/installations` 查证 token 持有者确实有访问该 installation 的权限，否则拒绝绑定，§10 P0-2）；token refresh；签 state JWT 时带 `targetOrganizationId` 确保 admin 在哪个 org 装就绑到哪个 org（§10 P1-3） |
| 新增 `services/github-app.ts` | App JWT 签名（RS256 + private key）；installation token 申请；user token refresh；`listUserAccessibleInstallationIds` 用于 callback 鉴权 |
| 新增 `services/github-app-installations.ts` | Installation 状态机：UPSERT、bind/unbind、suspend/unsuspend。**`bindInstallationToOrg` 用条件 UPDATE 而非 SELECT-then-UPDATE**（防并发 callback 同时绑同一 installation 到不同 org 的 race，§10 P0-3）。23505 翻译成 ConflictError 而不是漏到路由层 |
| 新增 `api/webhooks/github-app.ts` | 单一 endpoint；payload 里 `installation.id` 反查 `hub_organization_id`；下游复用现有 `github-adapter` pipeline。**未 bind 的事件不能 claim**（否则 GitHub 不会重试，事件永远丢，§10 P1-6）。生命周期事件用 payload 自带的 timestamp 比较，避免乱序的 suspend/unsuspend 覆盖（§10 P1-7） |
| 新增 `boot-guards.ts` | 在 `buildApp` 入口而非 `packages/server/src/index.ts` 末尾跑——CLI 的 `server start` 路径也走 `buildApp`，guard 必须在那里才覆盖两条入口（§10 P1-8） |
| [api/webhooks/github.ts](../packages/server/src/api/webhooks/github.ts) | **删除整个文件**（D3 硬切）；同步删除 `organization_settings.github_integration.webhookSecretCipher` 字段、`org-settings` 服务里相关加解密逻辑、Settings UI 上 per-repo webhook 配置面板 |
| [api/me.ts](../packages/server/src/api/me.ts) `/me/github/repos` | 调 GitHub 前先看 `accessTokenExpiresAt`，过期或 60s 内过期 → 用 refresh token 拿新对，写回 `auth_identities.metadata`，用新 token 调（§10 P1-4）。Legacy 行（无 expiry 字段）按"永不过期 OAuth token"处理，不刷 |
| `services/github-oauth.ts` | 重命名为 `github-api.ts`，新增按 installation token 调 GitHub API 的封装（建议 Octokit App auth） |

### 5.5 Web 改动

- **登录页**：按钮文案 "Sign in with GitHub" 不变，链接目标改为 App user authorization URL（合并 OAuth + install）。
- **Settings → Integrations**：新增 panel，展示当前 installation：account login + type + permissions + selected repos，加 "Manage on GitHub" 跳转链接。**"Install on GitHub" CTA 链接到 `https://github.com/apps/<slug>/installations/new` 而非 OAuth `authorize` URL**——后者只触发 OAuth consent，无 install 对话框（§10 P1-1）。state JWT 带 `targetOrganizationId` 保证 admin 在 org B 看 Settings 装 App，绑的是 B 不是 primary A（§10 P1-3）。
- **Step 3 repo picker**：不动。继续用 user token 调 `/user/repos`。可选 hint："这些 repo 已通过 App 接入 webhook"。
- **Step 3 tree destination todo**：`installation.account_login` 可作为预填来源，但解耦在独立 todo 里，不在本设计范围。
- **404 检测**：`getGithubAppInstallation()` 用 `err instanceof ApiError && err.status === 404` 判空状态，而不是用正则去 match 错误字符串（§10 P1-2）。

### 5.6 现有依赖路径处理

- **`github-adapter` agent + #283 dedup**：保留，作为统一下游 pipeline。新 App webhook 与老 per-repo webhook 都喂进它。
- **CLI（`first-tree-hub client connect`）**：不受影响。Client 用 Hub user JWT，跟 GitHub 凭证完全无关。
- **Dev 旁路**：现有 `/auth/github/dev-callback` 是 non-production 的假 OAuth 回调。App 模式下扩展同一个 callback——接受 `installationId`/`installationAccountType`/`installationAccountLogin`/`installationAccountGithubId` 参数，存桩一行 installation row。**双门控**：`NODE_ENV !== "production"` **且** `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED=1` 显式 opt-in 才生效，否则 404。第二门控防止 staging/preview 误暴露（§10 P1-9）。

---

## 6. 风险与待 sanity-check

1. **Phase 4 identity convergence 在 personal account 上的语义**：personal account 没有 members 概念。建议 `members/` 同步在 personal-installation 上 no-op 或只同步 owner 自己。**不阻塞本次落地**。
2. **与 breeze (Candidate A) 的边界**：breeze 是 Hub client variant，持有用户的 `gh` login（user-level）。Hub App installation 是 account-level（org 或 personal）。两者**不冲突但要避免 UI 混淆**——"装了 App 之后 breeze 还要不要单独登录 gh"。breeze 实装时再厘清，本次不解决。背景见 memory `unified-product-direction.md` Candidate A。
3. **Token 安全模型变化**：从"不过期的 access token"变成"8h TTL + refresh token"。refresh token 本身要加密存储，且 refresh 失败要有明确 UX（提示重新登录）。
4. **App private key 的运维**：PEM 不能扔 env var 拼字符串。需要确认团队现有 secret manager pattern。
5. **Staging / prod 两套 App 的私钥与回调 URL**：两个独立 App 各自一套配置（dev 复用 staging）。CI 流程要明确，避免把 staging 凭证误写进 prod 部署。

---

## 7. 落地建议顺序（Phase 1 候选）

1. 创建 GitHub App（staging + prod 两套；dev 复用 staging），团队层面分配 secret
2. DB migration：新增 `github_app_installations` 表 + `auth_identities` 扩字段
3. OAuth 切换：登录走 App user authorization；保留老 OAuth client_id 作为回滚后路
4. Install 回调 + installation 入库
5. 新 App webhook endpoint + 下游复用 `github-adapter` pipeline
6. Settings → Integrations UI 上线
7. 删除老 `/api/v1/webhooks/github/<orgId>` endpoint + `webhookSecretCipher` 字段 + Settings 老 UI 入口（D3 硬切，一次到位）

---

## 8. 给 review 的工程师的关键问题

1. **installations 表的 1:1**（Hub team ↔ GitHub account）是否同意？还是允许多绑？
2. **App private key 存储**：团队现在有没有标准 secret manager pattern 可复用？
3. **Token TTL 变 8h** 对客户端 / API 调用有没有运维影响？
4. **D3 硬切的上线沟通**：现有线上有没有 org 实际配置了 per-repo webhook？如果有（即使是内部测试 org），上线前需要单独通知一下。

---

## 9. 参考

- 现有 OAuth 实现：[packages/server/src/api/auth/github.ts](../packages/server/src/api/auth/github.ts)
- 现有 webhook 实现：[packages/server/src/api/webhooks/github.ts](../packages/server/src/api/webhooks/github.ts)
- Webhook secret 加密：[packages/server/src/services/org-settings.ts](../packages/server/src/services/org-settings.ts)
- 加固 commit：`0fd1c6f` (#283) — deterministic GitHub webhook routing + delivery dedup
- Onboarding 设计文档（含 Step 4 / first-tree-automation 背景）：[new-user-onboarding-design.md](new-user-onboarding-design.md)
- Client-identity 解耦设计：[decouple-client-from-identity-design-zh.md](decouple-client-from-identity-design-zh.md)
- Unified product direction（Candidate A）：memory `unified-product-direction.md`
- Step 3 tree-destination 痛点：memory `tree-destination-step3-todo.md`
- 实现 PR：[#300](https://github.com/agent-team-foundation/first-tree-hub/pull/300)（Phase 1 落地，含 codex review/challenge 修复）

---

## 10. Implementation findings (codex review/challenge 后补的设计修订)

落地过程跑了 codex review + adversarial challenge 两轮独立 review，找到 3 个 P0 + 9 个 P1。下表是**设计层面**的修订（实现细节散在 commit message 里，不重复）。每条都已在 PR-300 fix 掉。

### P0 — 安全 / 数据正确性必修

#### P0-1 — Migration 编号冲突

原文档 §5.3 没明确编号策略。实际跑下来撞上了 main 已经 merge 的 `0035_drop_hub_tasks.sql`（PR #302）。**约束**：新 schema 必须 rebase 在 main 最新 migration 编号之后。Phase 1 实际编号是 `0036_github_app_installations.sql` + `0037_drop_github_integration_namespace.sql`。

#### P0-2 — `installation_id` 必须鉴权

**问题**：原文档隐含假设 callback 收到的 `installation_id` 是可信的——但它来自浏览器 URL 参数，**不是 secret**（webhook URL、GitHub Settings 页、安装后跳转都能看到）。App JWT 能 fetch 任何 installation。任何登录用户都能 `?installation_id=<别人 org 的 id>` 把别人的 installation 绑到自己 Hub team。

**修订**：callback 在 OAuth code exchange 之后、`fetchInstallation` + 写表之前，调 `GET /user/installations`（用户 access token 拿），校验 `installation_id ∈ user's accessible set`。不在集合里 → 丢弃 `installation_id`、用户照常登录、不绑 install。fail-closed：调用本身失败也丢弃。

#### P0-3 — `bindInstallationToOrg` 必须 race-safe

**问题**：原 SELECT-then-UPDATE 实现有 TOCTOU window。两个并发 callback 把同一个未绑 installation 绑到不同 Hub org，都看到 `hub_organization_id IS NULL` 通过校验，后写的 UPDATE 静默赢——D2 1:1 被破坏。

**修订**：用条件 UPDATE `WHERE installation_id = $1 AND (hub_organization_id IS NULL OR hub_organization_id = $2)`，rowcount = 0 → 一次 SELECT 区分 NotFound 与 already-bound-elsewhere，抛 NotFoundError / ConflictError。同时捕获 23505（`UNIQUE(hub_organization_id)` 冲突，对应"org A 已绑 install X，user 装 install Y 想绑 A"场景），翻成 ConflictError + 给操作员可执行的错误消息。

### P1 — 必须在 merge 前修

| ID | 问题 | 修订 |
|---|---|---|
| **P1-1** | 原文档把 "App authorize URL" 当成万能起点。但**没装过 App 的用户**走 OAuth `authorize` URL 不会弹安装对话框——没有 `installation_id` 回流。 | Settings → "Install on GitHub" CTA 使用 `github.com/apps/<slug>/installations/new`（需要 `FIRST_TREE_HUB_GITHUB_APP_SLUG` env）。OAuth `authorize` URL 仅用于已装用户的 user-OAuth round-trip。 |
| **P1-2** | Web 端 404 检测原本用 `/\b404\b/.test(err.message)`，但 server 返回的 body 字符串里没"404" → 永远 false → Settings 空状态变错误 banner。 | 用 `err instanceof ApiError && err.status === 404`。 |
| **P1-3** | Admin 在 org B 看 Settings 装 App，callback 走 `pickPrimaryMembership` 把绑定写到 primary org A。 | State JWT 带 `targetOrganizationId` 字段。Callback 校验 user 是该 org admin，override `resolvedOrganizationId`。Invite-redemption 路径仍权威。 |
| **P1-4** | App user-to-server token 有 ~8h TTL，存了 `accessTokenExpiresAt` + `refreshToken` 但**调 GitHub 的路由没用上**——用户回来超过 8h 直接 403。 | `/me/github/repos`（以及未来其他用 user token 的路径）在调 GitHub 前看 `accessTokenExpiresAt`，60s 内过期就用 refresh token 拿新对、持久化、用新 token。Legacy 行（无 expiry 字段）跳过 refresh 块。 |
| **P1-5** | `fetchInstallation` / upsert / bind 任一步失败 → install row 永远 unbound。后续登录无 `installation_id` 不会重试绑。 | 加 `findUnboundInstallationsByAccount(accountGithubId)` + `completeOauthFlow` 里 "若名下恰好一个孤儿 → 自动认领" 兜底；多于一个孤儿 → 不自动认领，等 user 在 Settings UI 手工 claim（manual claim endpoint 也加）。 |
| **P1-6** | Webhook handler 先 `claimEvent(deliveryId)` 再判 binding。早到的 `issues` 事件（在 OAuth bind 完成前到达）→ 200 with `no_binding` → delivery 被标 processed → GitHub 不重试 → **事件永远丢**。 | 非生命周期事件先 SELECT binding，没绑 → 200 unclaimed return early。GitHub 自己重试调度（~10 次 over 24h）覆盖 bind 完成的窗口。生命周期事件（installation*）正常 claim + handle。 |
| **P1-7** | `markInstallationSuspended` 忽略 payload 的 `suspended_at`，用服务器时间。乱序的 stale `suspend`（在 `unsuspend` 之后到）覆盖。 | 用 payload 自带 timestamp + 条件 UPDATE `WHERE current_suspendedAt IS NULL OR current_suspendedAt < payload_suspendedAt`。`installation: deleted` 加 "createdAt 必须 > 1min 前" 启发式防 stale delete 抹掉刚建的 row。 |
| **P1-8** | Boot guard 原本只在 `packages/server/src/index.ts` 跑，**CLI 的 `server start` 走 `packages/command/src/core/server.ts → buildApp` 跳过 guard**。半配置 `webhookSecret=""` 漏到运行时 → HMAC-SHA256 with 空 key 是任何攻击者都能伪造的哈希。 | Guard 重新挂到 `buildApp` 入口（两条路径都过）。Shared schema 所有 5 个 App 字段 `.min(1)`，空字符串在 Zod parse 阶段拒绝。Guard 是 belt-and-braces。 |
| **P1-9** | Dev-callback 旁路只靠 `NODE_ENV !== "production"`。Staging / preview / self-host 首次 boot 时 `NODE_ENV` 没设 → 旁路裸奔 → 任何人能为任意 githubId mint Hub token，还能造任意假 installation。 | 双门控：`NODE_ENV !== "production"` **且** `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED in {"1","true"}`。默认 fail-closed。Vitest setup 把它设上，CI 不受影响。 |

### 学到的（流程层面）

1. **设计文档应该和实现 PR 一起 review，而不是单独 review**——文档说"callback 处理 `installation_id`"听起来无害，跑 codex 才看出 `installation_id` 不可信。
2. **codex challenge mode 是真值钱**。它一家就找到全部 3 个 P0 + 5 个独占 P1。Self-review + codex review 加起来没它狠。原因：它是 adversarial，不验证看起来对不对，是去找怎么把代码搞挂。
3. **Boot guard 必须放在所有入口共用的最下游**（`buildApp`），而不是某个具体 bin 文件——双入口架构是常见陷阱。
4. **`.min(1)` on env-loaded schema 不是装饰**——空字符串环境变量是真存在的失败模式，是 fail-closed 的最便宜防线。
