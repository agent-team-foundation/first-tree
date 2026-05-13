# GitHub App 迁移：As-Built 设计

> **🔮 = 延后到 webhook PR**（由另一位同事做）。其余都已随 **PR-322**（foundation）+ **PR-323**（sign-in + UI）发布；§2 有逐决策 / 逐子系统的拆分。文中提到 "设计文档 §X" 指 `docs/github-app-design-zh.md`（#295 上的上游提案）。

---

## 1. 问题与动机

### 1.1 遗留方案（正在被移除的部分）

Hub 此前通过两个互不相关的接口连接 GitHub：

1. **OAuth App** —— 仅用于登录的独立 `clientId` / `clientSecret`。签发永不过期的
   user-OAuth access token，持久化在 `auth_identities.metadata.accessToken`。
2. **按 org 配置的 webhook** —— 每个 Hub team 在 `organization_settings` 里
   namespace `github_integration` 下各有一行，保存一个 AES 加密的
   `webhookSecretCipher` 和一个 "allowed org" 闸门。webhook URL 是
   `POST /api/v1/webhooks/github/:orgId`（按 path 路由到对应 org）。

这套方案能用，但有三个结构性问题：

| 问题 | 后果 |
|---|---|
| **需要配置和轮转两个 GitHub 身份。** 运维要为每个客户 org 注册一个 OAuth App *并且*逐 repo 配置 webhook。 | 配置摩擦大；secret 轮转手册有两个面；没有单一的 "总开关"。 |
| **webhook secret 按 org 存储，在应用层加密。** | DB 里有大量 secret；密钥轮转需要重新加密每一行；HMAC 密钥泄露的爆炸半径是整个 `github_integration` namespace。 |
| **Hub 没有 server-to-server 身份去操作用户的 repo。** push-back / 写操作（Phase 4 身份收敛）本来需要*第三个*接口 —— 每个用户一个 Personal Access Token，外加手动调 scope。 | 未来的写功能被卡在一个手动 onboarding 步骤后面。 |

OAuth-App + 逐 repo webhook 模型还把*认证*（这个用户是谁）和*入站*（哪个 repo 刚变了）
混在一起了 —— 它们既不共享身份，也不共享轮转周期，也不共享运维接口。

### 1.2 设计目标

用**每个 Hub deployment 一个 GitHub App** 替代遗留的 OAuth-App + 逐 repo webhook 方案。设计目标：

1. **凭据面收敛成一个，而非三个。** 一个 GitHub App 同时提供：用于登录的 user-OAuth、webhook 入站（一个端点、一个 HMAC secret）、server-to-server installation token。运维要配置和轮转的就一样东西 —— 不再是 OAuth App + 逐 org 的 webhook secret + （将来）逐用户的 PAT。

2. **配置按 deployment 而非按 org。** webhook secret 从 `organization_settings.github_integration.webhookSecretCipher`（每个 org 一行加密数据）挪到一个 env var。webhook 路由从按 URL path 路由变成对 `installation.id → hub_organization_id` 做反查。org 级别的状态缩减到每个 org 一行绑定记录（`github_app_installations.hub_organization_id`）。

3. **登录 + 安装合并在一次跳转里**（D1）。首次用户在一次 GitHub 往返里完成 App 授权 + 安装；老用户只需重新授权。安装不需要第二次跳转。

4. **为未来的写回打基础。** App 能签发 installation token（1 小时有效，scope 限于已安装账户的 repo），可供 Phase 4 身份收敛（`members:read` 已经申请了）和任何未来的"Hub 往 GitHub 发东西"的功能使用。遗留模型完全没有 server-to-server 身份。

5. **落地分两个阶段，不同的人来做。** 原本是一个 PR（已关闭的 PR-300），拆成了两个：
   - **阶段 1 —— sign-in + UI**（PR-322 + PR-323，都已合并）：GitHub App schema + service 原语；`/auth/github` 改写成 App flow；Settings 面板 + admin API；auth 侧的遗留删除（OAuth-App helper、`oauth.github` 配置块、老的 webhook-secret Settings 面板）。
   - **阶段 2 —— webhook + 收尾**（一个单独的 PR，由另一位同事后续做）：`/api/v1/webhooks/github` 入站端点 + 分发；webhook 侧的遗留删除（逐 org 的 `/webhooks/github/:orgId` 路由、`github_integration` namespace、migration `0038`）。

   在阶段 2 落地之前，`main` 处于一个短暂的、*安全的*中间态 —— sign-in 已经走新 App，但 App 的 webhook URL 还没有 handler（只是 404，没有东西坏掉）。准备好一个 GitHub App 是合并 PR-323 的前置条件 —— 六个 App env var 必须在部署前设好，否则 sign-in 返回 503。没有客户受影响（SaaS deployment 还未 GA）。

---

## 2. 决策汇总

分两组：**§2.1** 是系统形状 —— 不重新设计就改不动的选择；**§2.2** 是健壮性 / 安全的加固（多数由 codex review 驱动）—— 让这个形状稳下来的实现选择，原则上可替换。D 编号是稳定标识符，§4 / §6 / §7 到处 cross-reference；这里的分组只是把它们拆开。

状态图例：✅ 在 PR-322 / PR-323 中发布 · 🔮 延后到 webhook PR。

### 2.1 架构决策（系统形状）

| # | 决策 | 状态 | 理由 | 引用 |
|---|---|---|---|---|
| **D1** | 一个 GitHub App = 一个合并的 OAuth + install 对话框。首次安装者拿到 `code + state + installation_id`；回访用户拿到 `code + state`。 | ✅ PR-323 | 单次重定向；App 的 "Request user authorization (OAuth) during installation" 开关让这成为可能。避免为 install 再做一次重定向。 | `services/github-app.ts:388-395`、`api/auth/github.ts:90-94` |
| **D2** | GitHub installation 与 Hub team 之间的 **1:1 绑定**。把另一个 team 重新绑到同一个 installation、或把另一个 installation 重新绑到同一个 team，都会被 `ConflictError` 拒绝。 | ✅ PR-322（schema + service）+ PR-323（callback） | 避免多租户的烂摊子 —— 否则一次 webhook delivery 就要 fan out 到 N 个 org。1:1 不变式在三层强制：`UNIQUE(installation_id)`、`UNIQUE(hub_organization_id)`、以及一个 race-safe 的条件 UPDATE（D8）。 | `db/schema/github-app-installations.ts:97-100`、`services/github-app-installations.ts:145-213` |
| **D3** | **按 deployment 的 webhook secret**，而非按 org。单个 env var `FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET`；`organization_settings.github_integration` 里逐 org 的 `webhookSecretCipher` 取消。 | 🔮 webhook PR（env var 已在 PR-322 中声明，但在 webhook handler 消费它之前未被使用；遗留 `webhookSecretCipher` 的删除 + 迁移 `0038` 随 webhook PR 一起发布） | 一个 secret 轮转；webhook 路由通过对 `installation.id` 反查（D5），而非按 URL path。彻底移除应用层加密 webhook secret 的整个面。 | `boot-guards.ts:31-87`（现在已声明）、`drizzle/0038_drop_github_integration_namespace.sql`（webhook PR） |
| **D4** | content webhook 走 **mention-only 路由**。issues / PR / discussion 事件只有在 body / 结构化 mention 字段点名了某个配置了 `delegate_mention` 的 Hub agent 的 `@username` 时才 fan out。其余所有 content 事件 200-ack，无副作用。 | 🔮 webhook PR | 与 #304（main）里的 entity-clustering 工作对齐。避免 "noisy webhook" —— Hub 不会把每个 issue 都建模成一个 chat；只有被 delegate-mention 的才会创建。 | `api/webhooks/github-app.ts:200-215`、`api/webhooks/github.ts:431-440` |
| **D5** | **webhook 路由通过对 `installation.id` → `hub_organization_id` 的反查**（而非通过 URL path）。 | 🔮 webhook PR | 单一的租户级 URL 意味着 GitHub App settings 页上的 "Webhook URL" 字段指向同一个地方。`installation.id` 是 GitHub 稳定的路由 key。 | `api/webhooks/github-app.ts:174-198` |

### 2.2 健壮性与安全决策（多数由 codex review 驱动）

| # | 决策 | 状态 | 理由 | 引用 |
|---|---|---|---|---|
| **D6** | **未绑定 install 的 webhook → 503（而非 200），且不 claim 该 delivery 做 dedup**。 | 🔮 webhook PR | `installation: created` 与 OAuth callback 完成 bind 之间的 race 窗口是真实存在的。200-ack 会让 GitHub 停止重投，并在 `processed_events` 里把这个事件烧掉；503-不-claim 让 GitHub 在 bind 落地后重投。 | `api/webhooks/github-app.ts:184-197`（codex P1-6） |
| **D7** | **在 claim delivery 做 dedup 之前先解析 binding。** | 🔮 webhook PR | 与 D6 同根：先 claim 意味着一个 "binding 还没到" 的事件会被永久标记为已处理。 | `api/webhooks/github-app.ts:165-200` |
| **D8** | **通过条件 UPDATE 实现 race-safe 的 `bindInstallationToOrg`。** 同一个未绑定 installation 的两个并发 callback 不可能都成功；失败方看到 0 行被 update，并拿到一个结构化错误。 | ✅ PR-322 | 之前的 SELECT-then-UPDATE 形式存在真实的 TOCTOU。Postgres 行锁 + `WHERE hub_org IS NULL OR hub_org = $target`；在反向情形（该 org 已经绑了一个*不同的* install）下捕获 `23505`。 | `services/github-app-installations.ts:112-213`（codex P0-3 + H2） |
| **D9** | **在 bind 之前用 `/user/installations` 对 `installation_id` query 参数做授权。** | ✅ PR-323 | `installation_id` 是从用户浏览器地址栏来的 —— 不是 secret，没有签名。不做授权的话，任何已登录用户都可以追加 `?installation_id=<其他 org 的 ID>`，把别的 team 的 install 绑到自己的 Hub team（App JWT 对每个 install 都有读权限）。 | `api/auth/github.ts:155-193`（codex P0-2）、`services/github-app.ts:184-215` |
| **D10** | 当 install 是从某个 org 的 Settings 面板发起时，**`targetOrganizationId` 搭在签名的 state JWT 里**；在 callback 中对照实时 membership 重新校验。 | ✅ PR-322（state JWT 形状）+ PR-323（callback 重新校验） | 没有它的话，org B 的 admin 安装 App 时，install 会被绑到 callback 解析出的那个 org（通常是 primary，也就是错的）。state JWT 能比 membership revoke 活得久；callback 在实时的 `members` 行上重新校验 admin 状态。 | `services/oauth-state.ts:30-66`、`api/auth/github.ts:394-407`（codex P1-3） |
| **D11** | **boot guard 在 `buildApp` 里跑，而非 `index.ts`** —— 这样 CLI 的 server-start 路径也被覆盖，不只是 standalone bin。 | ✅ PR-322 | `packages/command/src/core/server.ts → buildApp` 之前绕过了 `index.ts` 里的生产配置检查。内部 plumbing，不是架构选择 —— 列在这里只是让 reviewer 知道这些检查在哪触发。 | `boot-guards.ts:7-18`、`app.ts:144-150`（codex P1-8） |
| **D12** | **半配置的 App 是硬性 boot 失败。** 五个 App env var 必须一起设置（各带 `.min(1)`）；五个全空则禁用该块；部分设置触发 `throw new Error`。 | ✅ PR-322 | 空的 webhook secret 是悄无声息的灾难性问题 —— `createHmac("sha256", "")` 是任何攻击者都能复现的 hash。Zod 的 `.min(1)` 是主要防线；boot guard 是双保险。 | `shared/src/config/server-config.ts:109-138`、`boot-guards.ts:31-87` |
| **D13** | 当 GitHub 账户与正在登录的用户匹配时，**每次登录都做孤儿 install 的回收（reclaim）**。 | ✅ PR-322（service helper）+ PR-323（callback sweep）。Settings 里的 "Claim install" 选择器 UI 在 [first-tree-hub#318](https://github.com/agent-team-foundation/first-tree-hub/issues/318) 里跟踪，尚未发布。 | 如果 OAuth callback 插入了 install 行但 bind 步骤失败了，这行就会永远处于未绑定状态 —— GitHub 只在*初次* install 时发送 `installation_id`。这个 sweep 会自动 claim 单孤儿的情形；多孤儿目前要求运维直接 POST `/claim`。 | `services/github-app-installations.ts:340-366`、`api/auth/github.ts:462-496`（codex P1-5 + H1） |
| **D14** | **`/dev-callback` 需要显式 env opt-in**（`FIRST_TREE_HUB_DEV_CALLBACK_ENABLED=1`），此外还要 `NODE_ENV !== "production"`。任一闸门未过则返回 404（而非 403）。 | ✅ PR-323 | 否则一个 `NODE_ENV` 没设的配置失误的 staging deploy 会泄露这个 bypass。返回 404 是有意的 —— 它不会确认这条路由存在。 | `api/auth/github.ts:223-251`（codex P1-9） |
| **D15** | suspend / unsuspend / delete 的**乱序安全**：suspend 用 payload 时间戳作 guard；delete 依赖 GitHub 每次 install 都铸造一个新的 `installation.id`。早先那个基于 `createdAt` 的 60 秒 delete 宽限期被回退了 —— 它会让 install + 立即 uninstall 变成永久状态。 | ✅ PR-322（service 原语）。调用 `markInstallationSuspended` / `markInstallationUnsuspended` 并传入 payload 时间戳的 webhook handler 在 webhook PR 里。 | GitHub 不保证投递顺序，失败时会重投。条件 UPDATE 过滤掉过期事件，而不是依赖收到顺序。针对 id N 的过期 `delete` 不会污染一个新的 re-install（id M ≠ N）。 | `services/github-app-installations.ts:221-302`（codex P1-7） |

---

## 3. 架构概览

### 3.1 新组件（server）

```
packages/server/src/
├── api/
│   ├── auth/github.ts                          # OAuth callback (rewritten)
│   ├── orgs/github-app.ts                      # Admin API: GET install, install-url, claim
│   └── webhooks/
│       ├── github-app.ts                       # NEW: App webhook endpoint
│       └── github.ts                           # Trimmed to shared helpers (HMAC verify, mention-routing)
├── services/
│   ├── github-app.ts                           # NEW: App JWT, install token, user-token refresh, OAuth helpers
│   ├── github-app-installations.ts             # NEW: install state machine + bind + orphan reclaim
│   ├── oauth-state.ts                          # Extended: optional targetOrganizationId in state JWT
│   └── auth-identity.ts                        # Extended: token bundle now includes refresh + expiries
├── db/schema/github-app-installations.ts       # NEW: Drizzle schema
├── drizzle/0037_github_app_installations.sql   # NEW: table + indexes + FK
├── drizzle/0038_drop_github_integration_namespace.sql  # NEW: D3 cleanup
└── boot-guards.ts                              # NEW: extracted from index.ts
```

### 3.2 新组件（web + shared）

```
packages/shared/src/schemas/github-app.ts              # NEW: shared DTO + token-metadata + claim body schemas
packages/web/src/api/github-app.ts                     # NEW: SPA client (GET install, GET install-url)
packages/web/src/pages/github-app-installation-panel.tsx  # NEW: Settings panel; replaces github-integration-panel
```

### 3.3 OAuth + install 流程（时序）

```
Browser            Hub Server                   GitHub
   │                   │                           │
   │ GET /auth/github/start ──────────────────────►│
   │                   │ signOAuthState (sets cookie + signs JWT)
   │ ◄── 302 to https://github.com/login/oauth/authorize?client_id=…&state=<jwt>
   │                                               │
   │ ─── GitHub renders combined OAuth + install ──►│ (first install only)
   │ ◄── 302 to /api/v1/auth/github/callback?code=<>&state=<jwt>&installation_id=<id>?
   │                   │
   │ ─── GET /callback ───────────────────────────►│
   │                   │ verifyOAuthState (cookie nonce + signature)
   │                   │ exchangeCodeForAppUserProfile  ─────►│
   │                   │ ◄──── access + refresh + profile ───│
   │                   │ if installation_id:                 │
   │                   │   listUserAccessibleInstallationIds ►│  (D9)
   │                   │   ◄── set of allowed IDs ───────────│
   │                   │   if installation_id ∈ allowed:
   │                   │     createAppJwt + fetchInstallation►│
   │                   │     ◄── installation metadata ──────│
   │                   │     upsertInstallationFromMetadata
   │                   │ findOrCreateUserFromGithub
   │                   │ resolve membership (invite / target / primary / fresh personal)
   │                   │ if installation_id + resolvedOrg:
   │                   │   bindInstallationToOrg              (D8)
   │                   │ orphan-reclaim sweep                 (D13)
   │                   │ signTokensForUser
   │ ◄── 302 to /auth/github/complete#access=…&refresh=…&next=…&joinPath=…
```

### 3.4 Webhook 流程（时序）— 🔮 deferred to webhook PR

> 下面的时序描述的是 webhook PR 将实现的设计意图。它在 `ship/pr-300-rollup`（拆分前最初的 PR-300 head）上做过端到端原型，作为架构目标保留于此。这些 handler 在 PR-322/323 之后的 `main` 上一个都不存在。

```
GitHub                     Hub Server (POST /api/v1/webhooks/github)
   │                           │
   │ ── installation: created ►│ HMAC verify (D3 single secret)
   │                           │ (event=installation → state-machine path)
   │                           │ tryClaim(deliveryId) — INSERT into processed_events
   │                           │ upsertInstallationFromMetadata
   │ ◄── 200 ───────────────── │
   │                           │
   │ ── issues: opened ───────►│ HMAC verify
   │                           │ shouldSilent? → 200 (no claim) (D4)
   │                           │ extractInstallationId from payload
   │                           │ findInstallationByGithubId
   │                           │   no row OR no binding? → 503 NO CLAIM (D6/D7)
   │                           │ row found + bound:
   │                           │   tryClaim(deliveryId)
   │                           │   action ∈ MENTION_ACTIONS[event]? else 200 handled=false
   │                           │   handleMentionDelegation(org, event, payload)
   │                           │     extractMentions + resolveTargetChat + sendMessage
   │ ◄── 200 ───────────────── │
```

### 3.5 路由面（PR-322 + PR-323 合并后；webhook PR 待定）

| 路由 | Method | Auth | 用途 | 状态 |
|---|---|---|---|---|
| `/api/v1/auth/github/start` | GET | public | 铸造 state，重定向到 GitHub OAuth+install authorize URL | ✅ PR-323 |
| `/api/v1/auth/github/callback` | GET | public（state JWT） | 校验 state，交换 code，可选地 bind install | ✅ PR-323 |
| `/api/v1/auth/github/dev-callback` | GET | 受 `NODE_ENV` + `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED` 门控 | 本地开发跳过 GitHub 往返 | ✅ PR-323 |
| `/api/v1/webhooks/github` | POST | HMAC | App webhook 端点（单一租户级 URL） | 🔮 webhook PR |
| `/api/v1/orgs/:orgId/github-app-installation` | GET | org admin（Class B） | 读取绑定到该 org 的 installation | ✅ PR-323 |
| `/api/v1/orgs/:orgId/github-app-installation/install-url` | GET | org admin（Class B） | 铸造带签名 state 的 install URL + cookie | ✅ PR-323 |
| `/api/v1/orgs/:orgId/github-app-installation/claim` | POST | org admin（Class B） | 手动 claim 一个未绑定的 installation（仅 API —— Settings UI 在 [#318](https://github.com/agent-team-foundation/first-tree-hub/issues/318) 里跟踪） | ✅ PR-323 |

D3 切除 —— 分散在两阶段 rollout 中：

| 移除 | 何时 | 替代物 |
|---|---|---|
| 遗留 OAuth-App env var（`FIRST_TREE_HUB_GITHUB_OAUTH_*`）+ `oauth.github` 配置块 + `services/github-oauth.ts` 遗留 helper | ✅ PR-323 | GitHub App env var（`FIRST_TREE_HUB_GITHUB_APP_*`）+ `oauth.githubApp` 配置块 + `services/github-app.ts` user-OAuth helper |
| Web `github-integration-panel.tsx` | ✅ PR-323 | `github-app-installation-panel.tsx` |
| `POST /api/v1/webhooks/github/:orgId` | 🔮 webhook PR | `POST /api/v1/webhooks/github`（单一，反查） |
| `organization_settings` 里 namespace `github_integration` 的全部行 | 🔮 webhook PR（迁移 `0038`） | `github_app_installations` 表 + 按 deployment 的 webhook secret env var |

---

## 4. 各子系统详细设计

### 4.a 认证 / 登录流程

**状态：** ✅ 已发布 —— route 改写在 PR-323；底层的 `oauth-state.ts` / `github-app.ts` 原语在 PR-322。

**入口：** `packages/server/src/api/auth/github.ts:59-323`。

这个流程就是标准的 OAuth dance，但有一个变体：*同一个* GitHub 重定向在用户登录期间安装 App 时
可以顺带带来一个 install 副作用。handler 区分 "刚刚 install 了"（callback 携带 `installation_id`）
和 "用户正常登录"（没有 `installation_id`），并把两种情形都穿过同一个下游 `completeOauthFlow`。

**State JWT（`services/oauth-state.ts:50-67`）：**

```ts
export async function signOAuthState(
  jwtSecret: string,
  next: string,
  opts: SignOAuthStateOptions = {},
): Promise<{ token: string; nonce: string }> {
  const nonce = randomBytes(NONCE_BYTES).toString("base64url");
  // ...
  const claims: StatePayload = { nonce, next };
  if (opts.targetOrganizationId) claims.targetOrganizationId = opts.targetOrganizationId;
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
  return { token, nonce };
}
```

state token 携带 callback 之后的 `next` 路径，以及（在适用时）install 应当绑到的
`targetOrganizationId`。配对的 nonce 搭在一个 HttpOnly cookie 里。`verifyOAuthState` 中的
double-submit 校验要求两者都满足：签名必须验过 *并且* cookie 的 nonce 必须等于
`payload.nonce`。一个攻击者用自己 GitHub 账户预签 `start` 的 login-CSRF 会失败，因为受害者的
浏览器没有携带攻击者那次 `start` 设置的 cookie。

**Callback 分发（`api/auth/github.ts:97-221`）：**

1. 如果 GitHub App 未配置 → 503。
2. 解析 `code`、`state`、可选的 `installation_id`。校验 state。清掉 state cookie（一次性）。
3. 通过 `exchangeCodeForAppUserProfile` 交换 code。用 `services/crypto.encryptValue`（AES-256-GCM）
   加密 access + refresh token。原样持久化过期时间。
4. **D9 授权：** 如果 `installation_id` 存在，调用 `listUserAccessibleInstallationIds` —— 它用
   user-access-token 封装 `GET /user/installations`。如果 installation_id 不在那个集合里，丢弃它
   （并记录 `github_app.installation_id_unauthorized`）。失败即关闭（fail closed）：此检查期间的任何
   错误也会丢弃 installation_id。
5. 如果 `installation_id` 仍然有值，铸造一个 App JWT，拉取 installation 元数据，UPSERT 一行。
6. 交给 `completeOauthFlow`。

**`completeOauthFlow`（`api/auth/github.ts:325-511`）：**

按优先级顺序解析用户的 Hub team：

| 优先级 | 来源 | 触发条件 | 备注 |
|---|---|---|---|
| 1 | Invite 兑换 | `next` 匹配 `/invite/<token>` | 以 `inv.role` 加入发出邀请的 org。把 `next` 降为 `/`。 |
| 2 | 签名的 `targetOrganizationId` | install 从 Settings 发起 | 重新校验活跃的 admin membership；不是则 403。保留调用方的 `next`。 |
| 3 | 已存在的 primary membership | 用户有任意活跃 membership | 最近加入的胜出。保留 `next`。 |
| 4 | 全新的个人 team | 以上都不满足 | 铸造 `${login}'s team` org + admin membership + 1:1 human agent。 |

membership 解析后，会尝试 `bindInstallationToOrg(installationId, resolvedOrgId)`（没有
`installation_id` 时 no-op）。失败被记录；登录继续。然后跑孤儿回收 sweep（D13）。

最终响应：`302 /auth/github/complete#access=…&refresh=…&next=…&joinPath=…`。fragment 投递模型
意味着 SPA 在客户端引导这些 token；server 从不在 proxy 或 referrer log 能捕获的 URL 里回显它们。

### 4.b Installation 生命周期

**状态：** ✅ 已发布 —— 状态机原语在 `services/github-app-installations.ts`（PR-322）。在 `installation:*` 事件上*调用*它们的 webhook handler 是 🔮 webhook PR。

**状态机（`services/github-app-installations.ts`）：**

| 事件 | 操作 | DB 效果 |
|---|---|---|
| `installation: created` | `upsertInstallationFromMetadata` | 按 `installation_id` INSERT 或 UPDATE；从不碰 `hub_organization_id` |
| `installation: new_permissions_accepted` | `upsertInstallationFromMetadata` | 与 `created` 相同（重新快照 permissions/events） |
| `installation: suspend` | `markInstallationSuspended(suspendedAt)` | 仅当当前为 NULL 或更早时才设 `suspended_at` —— 乱序安全 |
| `installation: unsuspend` | `markInstallationUnsuspended(unsuspendedAt)` | 仅当 `suspended_at` 早于收到时间时才清除 —— 乱序安全 |
| `installation: deleted` | `deleteInstallationByGithubId` | 按 `installation_id` 硬 DELETE；无宽限窗口 |
| `installation_repositories: added/removed` | `upsertInstallationFromMetadata` | 重新快照 `events` / `permissions` 块。逐 repo 的子表尚未建模（延后）。 |

**乱序的 suspend/unsuspend（`services/github-app-installations.ts:231-272`）：**

```ts
await db
  .update(githubAppInstallations)
  .set({ suspendedAt, updatedAt: new Date() })
  .where(
    and(
      eq(githubAppInstallations.installationId, installationId),
      or(isNull(githubAppInstallations.suspendedAt), lt(githubAppInstallations.suspendedAt, suspendedAt)),
    ),
  );
```

过期的 `suspend` 重新 suspend 一个活跃行会被 `lt(...)` 子句过滤掉；过期的 `unsuspend` 在更新的
`suspend` 之后到达会被 `< unsuspendedAt` 过滤掉。文档中记录的局限：一旦 `unsuspend` 把列清成
NULL，系统就丢失了原始的 suspend 时间戳，所以那之后到达的过期 `suspend` 会重新 suspend。现实世界
的风险很低 —— suspend/unsuspend 是相隔数分钟的人工操作，远在任何现实的重排序窗口之外。

**Delete 处理（`services/github-app-installations.ts:300-302`）：** 按 `installation_id` 硬 DELETE，
没有宽限期 —— 早先那个基于 `createdAt` 的 60 秒宽限期为什么被回退见 D15。残留的洞（`deleted`
之后过期的 `created` 会复活这行）作为 follow-up #314 跟踪。

### 4.c Installation 绑定模型（1:1 hub_org ↔ install）

**状态：** ✅ 已发布 —— schema + `bindInstallationToOrg` 在 PR-322；调用它的 OAuth callback 在 PR-323。

**绑定不变式**（D2）：每个 `installation_id` 至多绑到一个 `hub_organization_id`，每个
`hub_organization_id` 至多持有一个 installation。三层强制：

1. **`UNIQUE(installation_id)`** —— 重复的 webhook delivery 不能为同一个 install 插入第二行。
2. **`UNIQUE(hub_organization_id)`（NULLs distinct）** —— 一个 Hub team 只能有一个已绑定的
   install；Postgres 把 NULL 视为彼此不同，所以多个未绑定行可以共存（孤儿回收路径）。
3. **Race-safe `bindInstallationToOrg`** —— 一个用行锁串行化的条件 UPDATE（替换了原本有 TOCTOU
   风险的 SELECT-then-UPDATE；codex P0-3，H2 补了反向情形）。

**Race-safe bind（`services/github-app-installations.ts:145-213`）：**

```ts
const result = await db
  .update(githubAppInstallations)
  .set({ hubOrganizationId, updatedAt: new Date() })
  .where(
    and(
      eq(githubAppInstallations.installationId, installationId),
      or(
        isNull(githubAppInstallations.hubOrganizationId),
        eq(githubAppInstallations.hubOrganizationId, hubOrganizationId),
      ),
    ),
  )
  .returning({ id: githubAppInstallations.id });
// updatedCount === 0 → either no row exists or row is bound elsewhere → SELECT to disambiguate
// 23505 catch → another row already binds the target org (H2)
```

条件 UPDATE 上的 Postgres 行锁把并发调用方串行化。失败方看到 `updatedCount === 0`，跑一个
SELECT 来区分 `NotFoundError` 和 `ConflictError`，然后抛一个结构化错误。

23505 catch 处理反向情形：这一行的 binding 通过了 WHERE filter，但 `UNIQUE(hub_organization_id)`
约束拒绝写入，因为有一个*不同的*行已经绑到了同一个 org。

幂等的 re-bind（同 install → 同 org）是允许的，被当作 no-op 处理（返回值是 "任何成功的 UPDATE
都返回 true"；测试在行级别断言状态）。

### 4.d Webhook 入站 + 分发 — 🔮 deferred to webhook PR

> **整个 webhook 子系统在一个由不同负责人接手的独立 PR 里发布。** 下面的设计在 `ship/pr-300-rollup` 上做过原型，作为 webhook PR 应当实现的规范保留于此。本节里的路由 / handler / 分发在 PR-322/323 之后的 `main` 上一个都不存在 —— 遗留的 `/api/v1/webhooks/github/:orgId` 逐 org 路由仍然是当前活跃的 webhook 接口，直到 webhook PR 切除它。
>
> 本节中的文件引用只在最初的 `ship/pr-300-rollup` 分支上能解析（作为设计参考保留；不是一个维护中的分支）。webhook PR 可能会重写细节，但应当保留上表里的决策 D3 / D4 / D5 / D6 / D7 / D15。

**端点：** `POST /api/v1/webhooks/github`（单一 URL，deployment 级）。
**实现：** `packages/server/src/api/webhooks/github-app.ts`。HMAC 校验复用
`verifyGithubWebhookSignature`（`timingSafeEqual` 在等长 buffer 上比较；不匹配抛
`UnauthorizedError`）；body 解析使用一个限定作用域的 `buffer` 模式 JSON content-type parser 来
保留原始字节供 HMAC 使用 —— 两者都与遗留的逐 org 端点同一模式，只是 secret 来源不同。

**分发顺序（`api/webhooks/github-app.ts:69-217`）：**

1. **App 未配置** → 501（运维必须设置 env var）。
2. **缺少 `x-hub-signature-256` header** → 401。
3. **HMAC 校验** → 不匹配则 401。
4. **JSON 解析失败** → 400。
5. **缺少 `x-github-event`** → 400。
6. **`event === "ping"`** → 200，不 claim，无副作用。（GitHub 在 App webhook 接线时触发一次。）
7. **`shouldSilent(event, payload)`** → 200，不 claim。silent 事件：`workflow_run`、`check_run`、
   `push`、label 噪声、`sender.type === "Bot"`。避免在净零事件上烧掉 `processed_events` 里的行。
8. **生命周期事件**（`installation`、`installation_repositories`）：
   - 对 `processed_events` 执行 `tryClaim(deliveryId)`（INSERT-ON-CONFLICT 的 claim）。
   - claim 冲突 → 200 deduped。
   - 跑状态机 handler。
   - handler 出错 → `unclaimEvent` 然后 re-throw。
9. **内容事件**（`issues`、`issue_comment`、`pull_request`、…）：
   - **先解析 binding**（`extractInstallationId` → `findInstallationByGithubId`）。
   - 如果没有行 或 `hubOrganizationId` 为 null → 503（不是 200；不 claim）。GitHub 按它自己的
     retry 计划重投。（D6/D7）
   - payload 里缺少 `installation` 块 → 200 routed=false（claim 已无意义）。
   - `tryClaim(deliveryId)`。冲突 → 200 deduped。
   - 通过 `MENTION_ACTIONS[eventType]` 做 action 闸门。不在 allowlist 上 → 200 handled=false。
   - `handleMentionDelegation(org, event, payload)`。出错 → unclaim + re-throw。

**Mention-only 路由（`api/webhooks/github.ts:395-424`）：**

```ts
export async function handleMentionDelegation(app, organizationId, eventType, payload) {
  const mentionText = extractEventText(eventType, payload);
  const textMentions = extractMentions(mentionText);
  const structuralMentions = extractStructuralMentions(eventType, payload);
  const mentions = [...new Set([...textMentions, ...structuralMentions])];
  if (mentions.length === 0) return 0;
  const ctx = extractEventContext(eventType, payload);
  if (!ctx) return 0;
  const entity = extractEventEntity(eventType, payload);
  if (!entity) return 0;
  const relatedRefs = (eventType === "pull_request" && ctx.repository.length > 0)
    ? parseFixesRefs(ctx.body, ctx.repository) : [];
  return routeMentionDelegations(app, organizationId, mentions, ctx, entity, relatedRefs);
}
```

对每个匹配到一个配置了 `delegate_mention` 的 agent 的 `@mention`，代码通过 `resolveTargetChat`
解析目标 chat（来自 #304 的 entity-clustering 规则），从那个 human-bound agent 给 delegate 发一张
card，并触发 `notifyRecipients` notifier。`pull_request: review_requested` 使用
`extractStructuralMentions`，因为 reviewer 在 `requested_reviewer.login` 里，而不在任何文本 body 里。

**`MENTION_ACTIONS`** allowlist（action 闸门）—— mention 扫描只在这些 "新内容" action 上跑：

```ts
{
  issues: ["opened", "edited"],
  issue_comment: ["created"],
  pull_request: ["opened", "edited", "review_requested"],
  pull_request_review: ["submitted"],
  pull_request_review_comment: ["created"],
  discussion: ["created", "edited"],
  discussion_comment: ["created"],
  commit_comment: ["created"],
}
```

**Dedup 表：** `processed_events(event_id, platform)` —— 已有的基础设施，原样复用。`claimEvent` 做
`INSERT ... ON CONFLICT DO NOTHING RETURNING event_id`；当且仅当在同一个 `x-github-delivery`
GUID + platform `"github-app"` 下没有先前的 delivery 被处理过时，claim 成功。

### 4.e Token 模型

**状态：** ✅ 已发布 —— minting / refresh 原语在 `services/github-app.ts`（PR-322）；OAuth callback 对 user-token 这一对的使用 + `/me/github/repos` 的 refresh 接线在 PR-323。（installation token 目前还没有请求路径的消费者 —— Phase 4。）

本 PR 引入三种不同的 GitHub 凭据 —— 只有 user-OAuth 这一对存在行上。

| Token | 生命周期 | 存储 | 用途 |
|---|---|---|---|
| **App JWT**（RS256，`iss=appId`） | ~9 分钟（被 GitHub 上限到 10） | 不持久化；每次请求铸造 | 把 Hub-as-this-App 认证到 `/app/...` 端点 |
| **Installation token**（server-to-server） | ~1 小时 | 不持久化；每次请求通过 App JWT 铸造 | 在租户 repo 上操作。当前在请求路径中未使用（Phase 4） |
| **User access token**（user-to-server） | ~8 小时 | `auth_identities.metadata.accessToken`（AES-256-GCM 密文） | OAuth 用户身份；被 `/me/github/repos` 用于 Step 2 onboarding 的 repo 选择器 |
| **User refresh token** | ~6 个月，**每次 refresh 都轮转** | `auth_identities.metadata.refreshToken`（密文） | 滑动 access token；持久化*新*的那个，否则下次 refresh 会失败 |

**App JWT 铸造（`services/github-app.ts:92-101`）：**

```ts
export async function createAppJwt(creds: GithubAppCredentials): Promise<string> {
  const key = await importPKCS8(creds.privateKeyPem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(creds.appId)
    .setIssuedAt(now - APP_JWT_IAT_SKEW_SECONDS)  // 60s back-date for clock skew
    .setExpirationTime("9m")
    .sign(key);
}
```

PEM 在每次调用时重新 import。开销是微秒级；这是有意的 —— 避免一个在并发请求下需要加锁的全局
可变 cache。如果 profiling 显示这是热点，调用方可以自行 memoize。

**User-token refresh（`services/github-app.ts:307-369`）：**

```ts
export async function refreshAppUserToken(clientId, clientSecret, refreshToken, opts = {}) {
  const res = await fetcher("https://github.com/login/oauth/access_token", { ... });
  // ...
  if (body.error || !body.access_token || !body.refresh_token) {
    throw new GithubAppApiError(401, `… rejected: ${description}`);  // normalize 200-with-error to 401
  }
  if (typeof body.expires_in !== "number" || typeof body.refresh_token_expires_in !== "number") {
    throw new GithubAppApiError(500, "… missing expires_in fields — App likely has user-token expiration disabled");
  }
  // ... compute absolute expiries, return
}
```

两个值得注意的归一化选择：

1. **200-with-`error` 被归一化为 `GithubAppApiError(401, ...)`。** 当 refresh token 格式错误或已被
   轮转时，GitHub 返回 200 OK，body 里带 `error: "bad_refresh_token"`。路由层唯一合理的响应是
   "强制重新登录"，所以我们以 401 暴露。
2. **缺少 `expires_in` 是 500。** GitHub App 必须在 App settings 页里启用 "Expire user
   authorization tokens"。如果响应省略了这些字段，那就是 deployment 配置失误了 —— 否则我们会
   持久化一个对 TTL 撒谎的行。要响亮地失败。

**Refresh 接线（`api/me.ts:182-277`）：**

`/me/github/repos` 端点（Step 2 repo 选择器）是当前唯一需要保证 fresh 的 user token 的请求路径。
逻辑：

1. 解密存储的 `accessToken`。缺失 / 解密失败则 503。
2. 如果这一行携带 `accessTokenExpiresAt`（App 风格的）并且 `expiresAt - 60_000 ≤ Date.now()`：
   - 解密 refresh token。调用 `refreshAppUserToken`。加密 + 持久化新的一对。
   - GitHub 每次 refresh 都轮转 refresh token；旧的那个会变成 `bad_refresh_token`。
3. refresh 失败时：来自 GitHub 的 401 → 403 带 `code: refresh_failed`（"Your GitHub session has
   expired"）；其他 → 503（"Couldn't refresh GitHub credentials"）。
4. 用（可能 fresh 的）access token 调用 `listUserRepos`。

遗留行（没有过期字段）完全跳过 refresh —— 永不过期的 OAuth-App token 仍然能用。

**手动 claim 端点（`api/orgs/github-app.ts:146-176`）** 为 `/user/installations` 的 admin 检查
使用 `getStoredGithubAccessToken`（不 refresh）。容忍过期的 token —— 下游的 GitHub 调用会暴露一个
401，路由把它映射到 "再登录一次，然后重试"。

### 4.f Schema 变更

**状态：** ✅ 已发布 —— `github_app_installations` 表（`0037`）+ `auth_identities.metadata` 形态在 PR-322；`0038` 的 `github_integration`-drop 迁移是 🔮 webhook PR。

#### 4.f.1 `github_app_installations`（新）

```sql
CREATE TABLE IF NOT EXISTS "github_app_installations" (
  "id" text PRIMARY KEY NOT NULL,                                    -- UUID v7 (app-generated)
  "installation_id" bigint NOT NULL,                                 -- GitHub-issued install ID
  "account_type" text NOT NULL,                                      -- 'User' | 'Organization' (CHECK)
  "account_login" text NOT NULL,                                     -- mutable, refreshed on webhook
  "account_github_id" bigint NOT NULL,                               -- immutable account id
  "hub_organization_id" text,                                        -- nullable, FK ON DELETE SET NULL
  "permissions" jsonb NOT NULL,                                      -- granted permissions snapshot
  "events" jsonb NOT NULL,                                           -- subscribed events list
  "suspended_at" timestamp with time zone,                           -- non-null while suspended upstream
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ck_github_app_installations_account_type"
    CHECK ("account_type" IN ('User', 'Organization'))
);
ALTER TABLE "github_app_installations"
  ADD CONSTRAINT "github_app_installations_hub_organization_id_organizations_id_fk"
  FOREIGN KEY ("hub_organization_id") REFERENCES "organizations"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
CREATE UNIQUE INDEX "uq_github_app_installations_installation_id" ON "github_app_installations" ("installation_id");
CREATE UNIQUE INDEX "uq_github_app_installations_hub_org"        ON "github_app_installations" ("hub_organization_id");
CREATE INDEX        "idx_github_app_installations_account"        ON "github_app_installations" ("account_github_id");
```

值得注意的形态选择：

| 选择 | 理由 |
|---|---|
| `installation_id` 和 `account_github_id` 用 `bigint mode: "number"` | GitHub 分配 64-bit ID；当前值约 8 位数，安全地低于 `Number.MAX_SAFE_INTEGER`。免去 bigint-string 的人体工学税。 |
| `hub_organization_id` 可空 | 允许 install 行在用户的 Hub team 被 provision 之前就插入（全新注册流程）。孤儿回收 sweep 是清理路径。 |
| `hub_organization_id` 上用 `ON DELETE SET NULL`（而非 CASCADE） | 当 Hub team 被删除时，GitHub 侧的 install 仍然在上游存在。保留这一行让未来的 re-bind 能恢复。 |
| `UNIQUE(hub_organization_id)`（NULLs distinct） | 强制 D2 的 1:1 *并且* 容忍多个未绑定行。Postgres 默认的 NULL-distinct 语义让这成为可能。 |
| `CHECK (account_type IN ('User', 'Organization'))` | 针对手动 SQL 绕过 Drizzle 列类型的纵深防御。 |
| `installation_id` 上没有 FK | 那个 ID 的真相之源是 GitHub；schema 里没有别的东西引用它。 |

#### 4.f.2 `auth_identities.metadata`（扩展后的形态）

列本身没变（已经是 `jsonb`）；被消费的形态长大了。PR 前（遗留 OAuth）：

```jsonc
{
  "login": "octocat",
  "accessToken": "<AES-256-GCM ciphertext, never-expires OAuth token>"
}
```

PR 后（App user-to-server）：

```jsonc
{
  "login": "octocat",
  "accessToken": "<ciphertext, ~8h TTL>",
  "accessTokenExpiresAt": "2026-05-12T18:00:00.000+00:00",
  "refreshToken": "<ciphertext, ~6mo TTL>",
  "refreshTokenExpiresAt": "2026-11-12T10:00:00.000+00:00"
}
```

Service 代码必须容忍两种形态 —— 没有过期字段 = "仍在遗留 OAuth token 上，跳过 refresh"。
wire 格式由 `packages/shared/src/schemas/github-app.ts:78-89` 里的
`githubAppUserTokenMetadataSchema` 拥有。

#### 4.f.3 移除的 `github_integration` namespace

迁移 `0038`：

```sql
DELETE FROM "organization_settings" WHERE "namespace" = 'github_integration';
```

没有 CREATE/DROP TABLE；`organization_settings` 是通用的 `(org_id, namespace) → JSONB` 存储。
共享的 `ORG_SETTINGS_NAMESPACES` 注册表在同一个 commit 里被裁剪了，所以任何仍试图读或写
`github_integration` 的代码路径会在到达 DB 之前就在 service 层失败。

#### 4.f.4 迁移顺序

`0036` / `0037` 随 PR-322 发布；rollup 分支上的 commit `940ad5c` 把它们的时间戳往上调，这样跑过旧
PR-300 布局的 deployment 仍能拾起改名后的 `0036`。（Drizzle 的 pg migrator 通过
`lastApplied.created_at < folderMillis` 去重 —— 没有基于 hash 的去重 —— 所以重新编号要求新时间戳
严格高于先前 PR-300 的最大值。）

| 迁移 | 用途 | 状态 / 备注 |
|---|---|---|
| `0036_github_entity_chat_mappings.sql` | 已有的 #304 工作，重新打了时间戳 | ✅ 已发布（PR-322）；entity-clustering 的 chat 解析所必需 |
| `0037_github_app_installations.sql` | 创建新表 + 索引 + FK | ✅ 已发布（PR-322）；只向前，没有回滚路径 |
| `0038_drop_github_integration_namespace.sql` | DELETE 遗留 webhook 配置 | 🔮 webhook PR；只向前，数据删除不可逆 |

> **`0038` 编号说明：** 本文档把 `github_integration`-drop 迁移称为 `0038` 是为了和原本的 PR-300 计划保持连续性。拆分之后，`main` 上的 `0038` 被一个无关的改动占用了（`0038_chat_membership_user_state`）。webhook PR 会用届时下一个可用的 index 来创建这个 drop 迁移 —— 把本文档里每一处 "`0038`" 当成 "webhook 侧的 `github_integration`-namespace-drop 迁移" 的占位名，而不是字面的文件号。

### 4.g 配置面

**状态：** ✅ 已发布 —— env-var 块 + boot guard 在 PR-322。

**六个新环境变量**（`packages/shared/src/config/server-config.ts:108-138`）：

| Env var | 必需 | Min | 用途 |
|---|---|---|---|
| `FIRST_TREE_HUB_GITHUB_APP_ID` | 是（与其余一起） | 1 | 来自 GitHub App settings 页的数字 App ID（App JWT 上的 issuer claim） |
| `FIRST_TREE_HUB_GITHUB_APP_CLIENT_ID` | 是 | 1 | 用于 user-token 交换的 OAuth client ID |
| `FIRST_TREE_HUB_GITHUB_APP_CLIENT_SECRET` | 是（secret） | 1 | OAuth client secret |
| `FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY` | 是（secret） | 1 | RSA PKCS#8 PEM（多行） |
| `FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET` | 是（secret） | 1 | 用于 webhook 签名校验的 HMAC 密钥 |
| `FIRST_TREE_HUB_GITHUB_APP_SLUG` | 块内可选 | 1 | `https://github.com/apps/<slug>` 的 URL slug —— 只有 install-URL 端点需要它；缺失会让那个端点返回 503，不阻塞 boot |

外加一个仅开发用的 flag：

| Env var | 用途 |
|---|---|
| `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED` | 必须是 `"1"` 或 `"true"` 才启用 `/dev-callback`。在 `NODE_ENV !== "production"` 之外*额外*强制（D14）。Vitest 的 setup 脚本会设它，这样已有测试还能跑。 |

**Boot guard（`boot-guards.ts:31-87`）：**

```ts
function assertGithubAppConfigComplete(config: Config): void {
  const ghApp = config.oauth?.githubApp;
  if (!ghApp) return;
  const required: Record<string, string | undefined> = {
    FIRST_TREE_HUB_GITHUB_APP_ID: ghApp.appId,
    FIRST_TREE_HUB_GITHUB_APP_CLIENT_ID: ghApp.clientId,
    FIRST_TREE_HUB_GITHUB_APP_CLIENT_SECRET: ghApp.clientSecret,
    FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY: ghApp.privateKeyPem,
    FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET: ghApp.webhookSecret,
  };
  const missing = Object.entries(required).filter(([, v]) => !v || v.trim().length === 0).map(([k]) => k);
  if (missing.length > 0 && missing.length < Object.keys(required).length) {
    throw new Error(`GitHub App is half-configured — missing env vars: ${missing.join(", ")}. Set all five or none.`);
  }
  if (missing.length === Object.keys(required).length) {
    throw new Error("GitHub App env block is present but every value is empty — unset…");
  }
  if (ghApp.privateKeyPem && !ghApp.privateKeyPem.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new Error("FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY does not look like a PKCS#8 PEM…");
  }
}
```

每个字段上的 Zod `.min(1)` 是主要防线；boot guard 是双保险。PEM 形状的嗅探能抓住常见错误 ——
只粘了 body，或者在单行 env 文件里留着字面的 `\n` 序列。

`assertBootConfigValid` 现在从 `buildApp` 调用（D11），所以两个 server 入口（standalone bin 和
CLI 的 `server start`）拿到的检查相同。

---

## 5. 安全模型

### 5.1 什么被签名、什么被校验、什么被加密

| 接口 | 机制 | 备注 |
|---|---|---|
| OAuth state JWT | HS256（HMAC），用 `jwtSecret` | 10 分钟 TTL；签名 + cookie nonce 的 double-submit（`oauth-state.ts:79-108`） |
| App JWT（Hub → GitHub） | RS256，用 App 私钥 | 9 分钟 TTL；为时钟偏差把 `iat` 往前 60s（`github-app.ts:92-101`） |
| Webhook payload | HMAC-SHA256，用 `FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET` | 在等长 buffer 上用 `timingSafeEqual`（`github.ts:23-31`） |
| User access + refresh token | 通过 `services/crypto.encryptValue` 的 AES-256-GCM | 明文从不接触行；`auth_identities.metadata` 上的 `accessToken`/`refreshToken` 字段是密文 |
| Hub session JWT | HS256，用 `jwtSecret` | 与 PR 前相同；未改 |

### 5.2 授权边界

| 操作 | 所需授权 |
|---|---|
| 登录期间把 installation 绑到 org | (a) state JWT 校验通过，(b) 调用方的 GitHub 用户通过 `/user/installations` 有访问权（D9），(c) 如果 state 里有 `targetOrganizationId`，调用方是那个 org 的活跃 admin（D10） |
| 手动 `/claim` install | (a) 目标 org 的 Class B admin，(b) 调用方的 GitHub access token 通过 `/user/installations` 确认 admin（参照 D9） |
| 读 installation 面板（`GET /github-app-installation`） | 目标 org 的 Class B admin |
| 获取 install URL（`GET /install-url`） | 目标 org 的 Class B admin；铸造把该 org 作为 `targetOrganizationId` 的 state |
| Webhook 入站 | 仅 HMAC 校验（没有 per-request 授权 —— 每个事件都落在同一个端点） |

### 5.3 攻击面（已承认）

架构师应当显式评估的项：

1. **地址栏上的 `installation_id` 不是 secret**（D9 缓解）。任何 bind installation 的尝试都走
   `/user/installations` 检查；该检查的失败（网络或 4xx）通过丢弃 installation_id 并继续登录来
   fail closed。
2. **State JWT 比 membership revoke 活得久**（D10 缓解）。10 分钟窗口足够长，admin 角色可能在铸造
   和消费之间被 revoke。callback 在 honor `targetOrganizationId` 之前通过 `findActiveMembership`
   重新检查实时的 `members` 行。
3. **Webhook secret 是跨所有租户的单一值。** 一次泄露会彻底攻陷 webhook 通道；轮转是一步运维
   操作（env-var 替换 + GitHub App settings 更新）。相对于逐 org 密文的复杂度，这个权衡被接受。
4. **App 私钥在 `FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY`** 里作为 PEM 字符串。boot guard 嗅探 PEM
   头但不校验密钥。一旦攻陷 → 可对任何 installation 冒充 Hub-as-App。secret-manager 模式被承认为
   延后（PR 描述 §6 风险 4）。
5. **`/dev-callback` 在两个闸门都通过时会铸造任意 GitHub 身份**。闸门 1 是 `NODE_ENV`（未设时
   default-deny，因为任何 ≠ `"production"` 的值都允许）；闸门 2 是显式 env opt-in。失败模式：
   运维故意在 prod 里设这个 env var。除了审计追踪之外对此没有防御。
6. **App JWT 按设计对每个 installation 都有读权限。** D9 授权才是阻止 Hub 滥用它的东西；App 私钥
   是信任根。
7. **`/user/installations` 实际上并不证明 admin 访问权** —— open follow-up #312。GitHub 的这个
   端点在某些上下文里列出用户能管理的 installation，但文档比措辞所暗示的要弱。当前实现把它当作
   权威；一个能操纵 GitHub 侧 membership 的有备而来的攻击者可能伪造一个 inclusion。P1 follow-up。

### 5.4 日志 / 审计

值得在生产里 grep 的结构化日志标记：

- `github_app.installation_id_unauthorized` —— D9 劫持尝试被阻止
- `onboarding.team_created` —— OAuth bootstrap 时铸造了全新的个人 team
- `github app webhook for unbound installation — 503 so GitHub redelivers` —— 观察到 race 窗口
- `multiple unbound installs match this account — skipping auto-claim` —— D13 多孤儿路径

---

## 6. 处理的边界情况与 race condition

| # | 场景 | 处理方式 | 引用 |
|---|---|---|---|
| **R1** | OAuth callback 的 `installation_id` 被伪造成另一个 team 的 id | `/user/installations` 检查；不匹配或检查失败时丢弃该 id | `api/auth/github.ts:155-193` |
| **R2** | Webhook `installation: created` 在 OAuth callback 完成 bind 之前到达 | webhook 返回 503（不 claim）→ GitHub 重投 → bind 已落地 → 下次尝试成功 | `api/webhooks/github-app.ts:174-198` |
| **R3** | 同一个全新 install 的两个并发 OAuth callback 试图绑到不同的 org | 条件 UPDATE：失败方的 WHERE 把刚设的值过滤掉；抛 `ConflictError`。Postgres 行锁把它们串行化 | `services/github-app-installations.ts:155-183` |
| **R4** | install 元数据 UPSERT 落地但 bind 失败（瞬时 DB 错误、竞争的 invite） | 行被留作未绑定；下次登录的孤儿回收 sweep（按 `accountGithubId` 匹配）在恰好有一个孤儿时自动 claim | `api/auth/github.ts:462-496`、`services/github-app-installations.ts:340-366` |
| **R5** | 用户反复登录且没有 `installation_id`（回访用户） | 幂等地 re-bind 到同一个 org 是 no-op（`bindInstallationToOrg` 返回 true；什么都没变）。`installationId === null` 时不调用 | `api/auth/github.ts:452-461` |
| **R6** | 过期的 `installation: suspend` 在更新的之后到达 | 在 `WHERE suspended_at IS NULL OR suspended_at < new` 上的条件 UPDATE —— 过期事件匹配 0 行 | `services/github-app-installations.ts:236-244` |
| **R7** | 过期的 `installation: unsuspend` 在一个新的 `suspend` 之后到达 | 在 `WHERE suspended_at < unsuspendedAt` 上的条件 UPDATE —— 过期事件匹配 0 行。文档中的洞：一旦 unsuspend 把列置为 NULL，系统就丢失了进一步排序的时间戳锚点 | `services/github-app-installations.ts:262-272` |
| **R8** | `installation: deleted` 到达，然后同一账户上有一个全新的 re-install | GitHub 每次 install 都铸造一个新的 `installation.id`，所以 delete 是针对 id N 的，re-install 是 id M ≠ N。没有冲突。C.12 commit 里存在的那个 60 秒宽限窗口被回退了，因为它会让 install + 立即 uninstall 变成永久 | `services/github-app-installations.ts:274-302` |
| **R9** | webhook delivery 被 GitHub 重投（同一个 `x-github-delivery` GUID） | `processed_events(event_id, platform="github-app")` 的 UNIQUE-on-INSERT 用 deduped 200 短路 | `api/webhooks/github-app.ts:128-141` |
| **R10** | claim 成功后 handler 抛错 | `unclaimEvent` 删掉 claim 行；错误 re-throw 让路由层映射到 5xx；GitHub 重试；下次尝试重新 claim | `api/webhooks/github-app.ts:142-149` |
| **R11** | 同一个 GitHub `login` 的两个并发 OAuth 登录（slug 冲突） | `users.username` 的 UNIQUE 抓住；用 hex 消歧符重试（`auth-identity.ts:181-208`）；`organizations.name` 同一模式（`membership.ts:159-182`） |
| **R12** | 非生命周期事件的 webhook payload 里缺少 `installation` 块 | 200 routed=false reason=`no_installation`。claim 已无意义 —— 没有东西会重新处理一个不可路由的事件。作为 payload bug 记录 | `api/webhooks/github-app.ts:174-182` |
| **R13** | App webhook 到达一个 Hub 不认识的事件类型 | 如果是生命周期：由 `handleInstallationEvent` 里的 `default` case 处理（记录 + 200 ack 让 GitHub 停止重试）。如果是内容：action 闸门过滤；不在 allowlist 上返回 200 handled=false | `api/webhooks/github-app.ts:253-260, 207-210` |
| **R14** | 用户在同一个账户上有多个未绑定 install | sweep 发现 N>1；为避免猜测跳过 auto-claim；记录 `multiple unbound installs match this account`；Settings UI 本应呈现一个选择器（延后 —— #318） | `api/auth/github.ts:485-490` |
| **R15** | org B 的 admin 安装了 App，但 OAuth callback 会默认到他们的 primary org A | `targetOrganizationId` 搭在签名的 state 里（由 `/install-url` 设置）；callback 在实时的 `members` 行上重新校验活跃 admin；如果在铸造和消费之间被 revoke 则用 403 拒绝 | `api/auth/github.ts:394-407` |

---

## 7. D3 Hard Cut

D3（"遗留接口与 App 接口之间没有兼容窗口"）被拆分为 auth 侧切除（PR-323，**已发布**）和
webhook 侧切除（webhook PR，**已延后**）。PR-322 + PR-323 合并后，遗留 webhook 是唯一仍存活的
遗留接口。

### 7.1 Auth 侧切除 — ✅ PR-323

| 移除 | 备注 |
|---|---|
| `services/github-oauth.ts` 遗留 OAuth helper（`buildAuthorizeUrl`、`exchangeCodeForProfile`） | 模块裁剪到只剩 `listUserRepos` + `GithubApiError` 供 Step 2 选择器使用 |
| Web `github-integration-panel.tsx` | 删除 205 行；由 `github-app-installation-panel.tsx`（251 行）替代 |
| 遗留 OAuth-App env var（`FIRST_TREE_HUB_GITHUB_OAUTH_*`） | schema 定义从 `oauth.github` 块移除 |
| `src/index.ts` 里对 `oauth.github` 的半配置检查 | 移除（该块不再存在） |

### 7.2 Webhook 侧切除 — 🔮 deferred to webhook PR

| 待移除（在 webhook PR 里） | 备注 |
|---|---|
| `POST /api/v1/webhooks/github/:orgId` 路由 | 由带反查的 `POST /api/v1/webhooks/github` 替代 |
| `github-webhook-review-requested.test.ts` | 覆盖率移到 App webhook 测试 |
| `org_settings.github_integration` namespace + 行数据 | 迁移 `0038`；共享的 `ORG_SETTINGS_NAMESPACES` 注册表待裁剪 |
| `services/org-settings.ts` 里遗留 `webhookSecretCipher` 字段的处理 | 函数 `getDecryptedGithubWebhookSecret` 待移除 |
| `webhooks/github.ts` 逐 org 路由 handler | 分发 helper（mention 提取、`MENTION_ACTIONS` 等）保留；只移除路由注册 |

在 webhook PR 发布之前，遗留的 `/webhooks/github/:orgId` 路由仍接受 delivery —— 已经配置了遗留
webhook 的 Hub org 继续工作。新 GitHub App 的 webhook URL 指向 `/webhooks/github`（App webhook），
在 webhook PR 落地之前它会 404。

### 7.3 为什么没有兼容窗口

按最初的设计，三个理由（跨两阶段切除都仍然适用）：

1. **遗留路径上没有 GA 租户** —— deployment 还没对外服务，所以没有 "迁移进行中" 的群体需要桥接。
2. **公开的无认证端点** —— 在迁移窗口里同时跑遗留 webhook URL 和 App URL 会让攻击面翻倍。任一侧
   配置失误的 webhook secret 都可能独立泄露。
3. **没有部分价值** —— 单独的 App schema、App schema + 仅登录、App schema + 仅 webhook 在切换
   落地之前都是 dead code。

> **拆分带来的注意点：** PR-322 + PR-323 让 Hub 处于一个中间状态 —— App 流程登录是活的，但 App 的 webhook URL 没有 handler。这没问题，因为：(a) PR-323 合并后 provision 新 App 的运维应当把 App 的 webhook URL 留空（或指向最终的 `/webhooks/github`），(b) staging 是当前唯一使用这套代码的环境，(c) webhook PR 预计在一个 sprint 内跟上。

### 7.4 回滚

每个阶段都只向前。PR-323 的 auth 侧切除删除了遗留 OAuth-App env-var schema；回退需要恢复遗留的
`oauth.github` 配置块。迁移 `0038`（在 webhook PR 里）删除数据；回退需要在每个客户账户上重新
install。没有提供自动回滚路径。每个 PR 都被当作 deploy 时事件对待，只有在运维确认新接口在 staging
上端到端工作后才发布。

---

## 8. 已知缺口 / 延后工作

全部作为 GitHub issue 归档。Severity 是 codex-review 的分类。

| # | 标题 | Severity | 状态 |
|---|---|---|---|
| [#312](https://github.com/agent-team-foundation/first-tree-hub/issues/312) | `/user/installations` 并不证明 admin 访问权 —— claim 端点能劫持 install | P1（security） | Open。在 P0-2 commit 里就已存在；被 C.10 的 claim 端点暴露得更多。需要一个更强的 admin 原语（大概是通过 App API 做逐 installation 的重新检查）。 |
| [#313](https://github.com/agent-team-foundation/first-tree-hub/issues/313) | `upsertInstallationFromMetadata` 在过期事件上把 `suspended_at` 覆盖掉 | P1 | Open。在最初的 Phase 1 里就已存在。需要一个 `last_lifecycle_event_at` 列才能做到 order-safe。 |
| [#314](https://github.com/agent-team-foundation/first-tree-hub/issues/314) | 过期的 `created` / `repositories` 事件让已删除的 install 行复活 | P1 | Open。与 #313 同一个生命周期排序缺口 —— 同一个修复形态。 |
| [#315](https://github.com/agent-team-foundation/first-tree-hub/issues/315) | install URL 的 state 在渲染时铸造 —— 多 tab/多 org 会覆盖 cookie nonce | P2 | Open。每次 `/install-url` GET 都设一个新 cookie；在不同 org 的两个 tab 里打开 Settings 会只让第二个 tab 的 nonce 有效。C.8 里新引入。 |
| [#317](https://github.com/agent-team-foundation/first-tree-hub/issues/317) | claim 成功但 claim 后的工作失败时 webhook `processed_events` 泄漏 | P1（设计层面） | Open。`unclaimEvent` 路径覆盖了抛出的错误，但一个静默吞掉异常的 claim 后异步副作用可能泄漏。历史上对 main 上的逐 org webhook 也适用。 |
| [#318](https://github.com/agent-team-foundation/first-tree-hub/issues/318) | Settings UI 缺少用于多孤儿恢复的 "Claim install" 按钮 | P1 | Open。后端端点在 C.10 里发布了（`POST /claim`）；web UI 延后。多孤儿情形记录日志 + 跳过 auto-claim，今天没有用户侧界面来解决。 |
| [#319](https://github.com/agent-team-foundation/first-tree-hub/issues/319) | `/user/installations` 分页上限 500 —— power user 可能让 callback bind 失败 | P2 | Open。`listUserAccessibleInstallationIds` 走 5 页 × 100。拥有 >500 个 install 的 power user（罕见但在 GitHub Enterprise 规模下可能）会触发上限并让 D9 失败。 |
| [#320](https://github.com/agent-team-foundation/first-tree-hub/issues/320) | webhook 测试绕过真实的 `bindInstallationToOrg`（直接调 `upsertInstallationFromMetadata`） | P2（测试质量） | Open。测试脚手架的捷径；不影响生产行为，但降低了对 binding 路径 webhook 侧覆盖率的信心。 |
| [#321](https://github.com/agent-team-foundation/first-tree-hub/issues/321) | PR 对话评论被错误路由到 issue chat（带 issue.pull_request 的 issue_comment） | P2 | Open。在 main #304 的 `github-entity.ts` 里就已存在；清理不在本 PR 范围内。 |

**修复形态聚类（按 PR 描述）：**

- **#313 + #314** 共享 `github_app_installations` 上的一个生命周期排序列
- **#312 + #319** 共享重建 install-admin 原语
- **#317** 需要对 claim/dedup 语义做一轮设计
- **#318** 是直接的 web UI 工作
- **#315 + #321** 是独立的小修复
- **#320** 是琐碎的测试清理

**其他延后工作**（PR 描述 §"What's NOT in this PR"）：

- 逐 repo 子表（`installation_repositories: added/removed` 重新快照父行，但还没建模单个 repo）
- Phase 4 身份收敛 —— `members:read` 权限已授予，但还没有 sync 在跑
- `FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY` 的 secret-manager 模式（design doc §6 风险 4）
- `breeze` / Hub client 变体的边界清理（design doc §6 风险 2）

---

## 9. 测试面

### 9.1 新增的 server 测试

7 个新测试文件；约 2,300 行覆盖新接口。

| 文件 | 行数 | `test()`/`it()` 块 | 覆盖的接口 |
|---|---|---|---|
| `__tests__/github-app.test.ts` | 529 | 25 | App JWT、install token、user-token refresh、OAuth helper、`listUserAccessibleInstallationIds` |
| `__tests__/github-app-installations.test.ts` | 300 | 17 | 状态机：upsert、bind（race-safe + 幂等）、suspend/unsuspend 乱序、delete、orphan list、count |
| `__tests__/github-app-webhook.test.ts` | 404 | 13 | 端点分发：HMAC、ping、silent filter、生命周期、带 binding 的内容、不带 binding 的内容（503 不 claim）、缺少 installation 块、action 闸门、dedup、claim/unclaim |
| `__tests__/github-app-orphan-recovery.test.ts` | 341 | 10 | D13 sweep：单孤儿 auto-claim、多孤儿 skip、claim 端点授权、手动 claim 的 happy + 403 + 404 + 409 路径 |
| `__tests__/github-app-callback-target-org.test.ts` | 242 | 4 | D10 路径：state 携带的 `targetOrganizationId`、admin 重新检查、被 revoke 的 admin 上 403、invite override |
| `__tests__/github-app-install-url.test.ts` | 118 | 4 | `/install-url`：slug 存在（200）、slug 缺失（503）、state JWT 形状、cookie 设置 |
| `__tests__/oauth-flow.test.ts` | 294 | 18 | 端到端：`/start` → `/callback` 往返、dev-callback opt-in 闸门、joinPath 分类 |
| 对 `oauth-state.test.ts`、`org-settings.test.ts`、`helpers.ts`、`setup.ts` 的修改 | — | — | state JWT 里的 `targetOrganizationId`；`vitest.setup.ts` 设 `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED=1` |

PR 描述声称 **809/809 server 测试通过**（testcontainers PG；相对 Phase-A 前 768/768 的基线 +41）。

### 9.2 需要的手动 smoke 测试

PR 明确把四项检查延后到真实 App 凭据 provision 之后：

- [ ] 通过 App authorize URL 的 GitHub → Hub OAuth 往返（校验 `state` JWT 往返、首次登录时出现
      install 对话框）
- [ ] 真实的 `installation: created` webhook delivery + 对 staging 的 HMAC 校验
- [ ] 对 `https://github.com/login/oauth/access_token` 的 user token refresh
- [ ] C.8 install-URL 流程：从 Settings 面板触发，确认 GitHub 往返 `state` query 参数

这些在单元测试里无法演练，因为它们都接触实时的 GitHub API。运维的 pre-merge runbook（PR 描述
§5）要求在合并前做 staging 验证。

### 9.3 测试脚手架说明

- `vitest.setup.ts` 设 `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED=1`，这样已有的 dev-callback 测试
  无需每测试接线就能跑（D14）。
- App 测试用可注入的 `fetcher` / `now` 来确定性地 stub 网络往返
  （`services/github-app.ts:131-136, 250-256, 313-318, 466-471`）。
- webhook 测试为了 setup 方便绕过 `bindInstallationToOrg`，直接调 `upsertInstallationFromMetadata`
  （作为 #320 承认）。

---

## 10. 运维影响

### 10.1 对运维来说什么变了

**Pre-merge：** 跑遗留 stack 的运维必须在合并本 PR **之前**注册一个 GitHub App。PR 描述
§"Pre-merge runbook" 列出：

1. 创建 staging + prod GitHub App（两套，在本 team 的配置里 dev 与 staging 共享）。
2. 通过 team secret manager 分发这 6 个 secret（`APP_ID` / `CLIENT_ID` / `CLIENT_SECRET` /
   `WEBHOOK_SECRET` / `PRIVATE_KEY` PEM / `APP_SLUG`）。
3. 对 staging 跑 `pnpm --filter @first-tree-hub/server db:migrate`。
4. 在 staging 上 smoke-test 上面那四个待办勾选项。
5. 合并。

**Per-customer：** 客户不再配置自己的 webhook secret。每个客户 admin 在 Settings → Integrations
里每个 Hub team 点一次 "Install on GitHub"；install 对话框引导他们做 repo 选择。Hub 自动把得到的
`installation_id` 绑到他们的 team。

**Install URL 分发：** 没有可分享的 "静态 install 链接"。每次 install 都必须走
`/orgs/:orgId/github-app-installation/install-url`，这样 state JWT 才携带 `targetOrganizationId`。
一个共享链接会丢失这个绑定，退回到 OAuth-callback 的 "primary org" 回退（对任何非个人 team 都是
错的）。

### 10.2 Secret 轮转

- **Webhook secret 轮转：** 替换 `FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET` env var，重启 Hub，
  在 GitHub App 的 settings 页更新 secret。在 Hub 重启和 GitHub 配置更新之间的窗口里会有短暂的
  HMAC 失败；GitHub 的重投覆盖它们。
- **App 私钥轮转：** GitHub 在轮转期间允许每个 App 有多个私钥。流程：在 GitHub 上加新 key，替换
  `FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY`，重启 Hub，在 GitHub 上删旧 key。无 webhook 停机
  （App JWT 每次请求每 9 分钟重新生成）。
- **Client secret 轮转：** 替换 `FIRST_TREE_HUB_GITHUB_APP_CLIENT_SECRET`，重启。需要在 GitHub
  App settings 页上同步轮转 —— OAuth client secret 没有重叠窗口。进行中的 OAuth dance 会失败；
  用户重新点登录。

### 10.3 完全禁用 GitHub App

unset 全部 5 个必需 env var（boot guard 把部分配置视为 fatal）。依赖 App 的路由
（`/auth/github/start`、`/auth/github/callback`、`/api/v1/webhooks/github`）返回 503/501。
Settings 面板渲染 "GitHub App not configured" 的空状态。

### 10.4 可观测性面

boot log 每次启动发出一行：

```
GitHub App not configured — /auth/github/start will return 503. Set FIRST_TREE_HUB_GITHUB_APP_* to enable.
```

（当该块缺失时），或者已配置时无消息。

值得告警的运行时结构化日志标记：

| 标记 | 含义 | 建议动作 |
|---|---|---|
| `github_app.installation_id_unauthorized`（warn） | D9 尝试被阻止 | 调查调用方 —— 可能是 CSRF 或劫持尝试 |
| `github app webhook for unbound installation`（info） | 观察到 R2 race 窗口 | 全新 install 期间正常；如果速率持续则告警 |
| `multiple unbound installs match this account`（info） | R14 多孤儿路径 | Settings UI 缺少选择器（#318）；可能需要手动 claim |
| `github app install bind-to-org failed`（warn） | R4 —— 产生了孤儿 | 应在下次登录时通过 D13 sweep 自愈 |
| `dev-callback request refused`（info） | D14 闸门抓住了一个请求 | 在 prod 里是预期的；如果带有效 query string 出现则告警 |

---

## 11. 风险评估

### 11.1 合并后可能出什么问题

| # | 风险 | Severity | 可能性 | 本 PR 中的缓解 |
|---|---|---|---|---|
| **X1** | 运维没 provision GitHub App 就合并 | 高（登录 503；webhook 501） | 中 | boot guard 拒绝部分配置；runbook 里有手动 smoke-test 步骤 |
| **X2** | 运维粘了带字面 `\n` 的单行 PEM | 高（App JWT 铸造失败） | 中 | boot guard 嗅探 `-----BEGIN PRIVATE KEY-----` 头；错误消息指出失败模式 |
| **X3** | webhook secret 泄露 | 严重（伪造任何租户的事件） | 低 | 一次 env-var 轮转；有文档化的 runbook |
| **X4** | App 私钥泄露 | 严重（冒充任何 installation） | 低 | 同样的 env-var 替换流程；GitHub 允许多 key 轮转 |
| **X5** | `installation: created` 与 OAuth callback bind 之间的 race 永久烧掉该事件 | 中（mention 被静默丢弃） | 中 | D6 —— binding 缺失时 webhook 返回 503（不 claim）；GitHub 的 retry 预算覆盖 bind 窗口 |
| **X6** | 过期的生命周期事件让一个已删除的 install 行复活 | 中（僵尸 binding） | 低（在 GitHub 的重排序窗口内） | 在 #314 里承认；不阻塞 —— 需要生命周期排序列 |
| **X7** | 拥有 >500 个 installation 的 power user 让 D9 检查失败 | 中（无法 bind） | 低 | 在 #319 里承认；当前上限是 5 页 × 100 |
| **X8** | `/user/installations` 的 admin 信号可伪造 | 高（claim 劫持） | 低 | 在 #312 里承认；当前实现把它当作权威 |
| **X9** | 多 tab 的 install URL fetch 覆盖 cookie nonce | 低（一个 tab 的流程 CSRF 检查失败） | 中 | 在 #315 里承认；用户重试 |
| **X10** | 迁移 `0038` 删除遗留 `github_integration` 行 | 如需回滚则高 | 低（只向前是选定模式） | 无缓解；回滚需要在每个客户账户上重新 install |
| **X11** | 测试绕过 `bindInstallationToOrg` 掩盖了 binding 路径的回归 | 中 | 低 | 在 #320 里承认；手动 smoke 测试覆盖生产路径 |
| **X12** | `dev-callback` 在 prod 里被意外启用 | 严重（铸造任意身份） | 极低 | 双闸门防御（`NODE_ENV` + 显式 env var）；任一闸门未过则 404（不是 403） |

### 11.2 建议的批准前检查

架构师在批准前应当显式核实：

1. **`bindInstallationToOrg` 的 race-safety 声明** 在并发负载下确实串行化。条件 UPDATE + 23505
   catch 在纸面上是 sound 的；`github-app-installations.test.ts` 套件覆盖了逻辑，但在不显式设置
   并发隔离的情况下用 testcontainers 跑无法演练真实的并行事务。
2. **未绑定 webhook 的 "不 claim" 决策**（D6）是正确的。如果架构师认为 GitHub 的重投预算会在
   某些边界情形下在 bind 落地之前耗尽，那这就成了一条永久丢事件的路径。当前的判断是 "bind 在
   OAuth 往返的几秒内落地"；这在经验上是真的，但不可强制执行。
3. **孤儿回收语义**（D13）。基于 `accountGithubId` 匹配自动 claim 单个孤儿是一个强的隐式信任信号
   —— 用户就是最初安装该 App 的同一个 GitHub 身份。架构师应当对 User 类型账户的隐式信任是正当的
   感到放心。Org 类型账户只走手动 claim（PR 描述："auto-claim 对 org 来说太冒险"）。
4. **#312 的 severity**（claim 端点通过弱 admin 信号劫持）。如果这是 "公开发布前必须修"，那本 PR
   不应合并。如果是 "对一个没有活跃威胁模型的 deployment 来说 P1 follow-up 可接受"，那合并没问题。
   PR 当前把它当作后者。
5. **迁移顺序兼容性** —— 与跑过旧 PR-300 布局的 deployment。`940ad5c` commit 调高迁移时间戳，让
   改名后的 `0036` 干净地重新 apply。架构师应当在 deployment 跑的那个 PG 版本上核实 `pgMigrator`
   的 `lastApplied.created_at < folderMillis` 语义。

### 11.3 建议的监控（前 30 天）

- `github_app.installation_id_unauthorized` warning 的速率（应接近零;飙升 → 活跃的劫持尝试或
  有 bug 的 client）。
- `github app webhook for unbound installation` info log 的速率（每次 install 后应快速收敛到零;
  持续 → bind 路径在系统性失败）。
- GitHub App settings 页上的 webhook 重投计数（应该低;高 → 503/5xx churn）。
- `processed_events` 行增长速率（对 dedup 表大小的健全性检查）。
- `github_app_installations` 里 `hub_organization_id IS NULL` 超过 24 小时的行（应为零;非零 →
  某个账户的孤儿回收在失败，需要手动 claim）。

---

## 附录 A —— 文件映射

本 PR 中带行范围的关键文件：

| 文件 | 角色 |
|---|---|
| `packages/server/src/api/auth/github.ts:59-323` | OAuth callback、dev-callback、completeOauthFlow |
| `packages/server/src/api/webhooks/github-app.ts:54-217` | webhook 分发 + 状态机路由 |
| `packages/server/src/api/webhooks/github.ts:19-31` | 共享 HMAC 校验（两条 webhook 路由都用 —— 只剩 App webhook） |
| `packages/server/src/api/webhooks/github.ts:395-440` | `handleMentionDelegation` + `MENTION_ACTIONS` |
| `packages/server/src/api/orgs/github-app.ts:42-176` | Admin API：GET install / install-url / claim |
| `packages/server/src/services/github-app.ts:92-559` | App JWT、install token、user-OAuth helper、refresh |
| `packages/server/src/services/github-app-installations.ts:69-380` | 状态机、race-safe bind、orphan helper |
| `packages/server/src/services/oauth-state.ts:50-108` | state JWT 铸造 + 校验 |
| `packages/server/src/services/auth-identity.ts:9-167` | token bundle 持久化 + login-collision 重试 |
| `packages/server/src/api/me.ts:182-277` | 请求路径中的 token refresh（`/me/github/repos`） |
| `packages/server/src/db/schema/github-app-installations.ts:36-110` | Drizzle schema |
| `packages/server/src/db/schema/auth-identities.ts:31-45` | 扩展的 metadata jsdoc |
| `packages/server/drizzle/0037_github_app_installations.sql` | 表 + 索引 + FK |
| `packages/server/drizzle/0038_drop_github_integration_namespace.sql` | DELETE 遗留行 |
| `packages/server/src/boot-guards.ts:7-87` | boot 校验（App config + 生产 publicUrl） |
| `packages/server/src/app.ts:144-150, 427, 466` | `assertBootConfigValid` 调用点 + 路由注册 |
| `packages/shared/src/config/server-config.ts:81-138` | env var schema（App 块） |
| `packages/shared/src/schemas/github-app.ts:1-131` | 共享 Zod schema + DTO |
| `packages/web/src/api/github-app.ts:1-52` | SPA client（GET install + install-url） |
| `packages/web/src/pages/github-app-installation-panel.tsx:1-232` | Settings UI 面板 |

---

## 附录 B —— codex 评审来源

本 PR 经过两轮 codex 评审 + 对抗性 challenge。各项发现追溯到具体 commit：

- **P0-2**（`366a7a3`）—— 对 `installation_id` 做授权（D9）
- **P0-3 + H2**（`b32c89d`）—— race-safe 的 `bindInstallationToOrg`（D8）
- **P1-1**（`7037bfe`）—— 用 App slug 而非 OAuth authorize URL 生成 install URL（codex P1-1；对于
  尚未安装该 App 的用户，authorize URL 从不呈现 install 对话框，所以遗留 CTA 静默地从未产生过
  install）
- **P1-2**（`d49c466`）—— web client 里的 `ApiError.status === 404` 检测（正则原本是在错误消息
  body 里查字面 "404"）
- **P1-3**（`71e6dc2`）—— 通过 state JWT 把 install 绑到 target org（D10）
- **P1-4**（`d49c466`）—— `/me/github/repos` 里的 token-refresh 接线
- **P1-5 + H1**（`753d74b`）—— 孤儿回收 sweep + 手动 claim 端点（D13）
- **P1-6**（`094c74f`）—— webhook 排序：在 claim 之前解析 binding（D7）
- **P1-7**（`45f7d1e`）—— suspend/unsuspend/delete 的 order-safety（D15 —— 不过 delete 宽限期在
  `a2ad802` 里被回退了）
- **P1-8**（`a4b2d87`）—— `buildApp` 里的 boot guard + App secret 上的 `.min(1)`（D11/D12）
- **P1-9**（`5b1ca20`）—— `/dev-callback` 的显式 opt-in（D14）
- **Post-rollup P1**（`940ad5c`）—— 调高迁移时间戳，让旧 PR-300 DB 布局拾起改名后的 `0036`
