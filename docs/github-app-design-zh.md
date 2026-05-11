# GitHub App 迁移设计

**状态**：Proposal，等待团队 review。已定 D0–D2，待定 D3–D4（见 §4）。
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

## 4. 决策

### 4.1 已定

| ID | 决策 | 备注 |
|---|---|---|
| **D0a** | 做 GitHub App，替代现有 OAuth App | 主理由是 webhook 自助化 |
| **D0b** | Permission 声明策略 A：一次性声明完整 read+write | 避免未来 admin 被 GitHub 弹 "review new permissions" |
| **D1** | Install 触发点 = 登录即安装 | 走 GitHub 的 "Request user authorization (OAuth) during installation"。一个跳转完成 OAuth + install + repo 选择 |
| **D2** | 覆盖范围 = Org + Personal 都接 | `installation.account_type ∈ {"User", "Organization"}`，1:1 绑到 Hub team |

### 4.2 待定（团队 review 重点）

**D3：老 per-repo webhook 迁移策略**

| 选项 | 描述 | 取舍 |
|---|---|---|
| a — 硬切 | 上线日老 endpoint 410，所有 org 重装 | 干净，但断流 |
| b — 双轨 + sunset | 两套并行 ~6 个月，UI 引导，设强制下线日期 | 运营负担重 |
| c — 软硬结合 | 老 endpoint 长期接收已配置 org，UI 不再展示老入口，新 org 一律走 App | 无 sunset 压力，代码长期共存（handler 是独立文件，清理成本低）|

**初步倾向**：c。

**D4：是否把 first-tree-automation 并到同一个 App**

那个独立的 Vercel 部署 GitHub App 当前 paused（见 [new-user-onboarding-design.md §10](new-user-onboarding-design.md)）。

| 选项 | 描述 |
|---|---|
| 共用同一 App | 未来 Step 4 复活直接复用 installation |
| 独立 App | 两条产品线解耦 |

**初步倾向**：现在不并，但 App permissions 设计上**留余量**（声明 `workflows:write` 等），automation 真的复活时再 review。

---

## 5. 关键改动

### 5.1 GitHub App 创建（GitHub UI 一次性配置）

- **Where can this GitHub App be installed**：Any account（对应 D2）
- **Request user authorization (OAuth) during installation**：enabled（对应 D1）
- **Webhook URL**：`<publicUrl>/api/v1/webhooks/github`（单一 endpoint，不带 orgId）
- **Permissions**（对应 D0b，一次性声明）：
  - Repository: `contents:write`, `pull_requests:write`, `issues:read`, `metadata:read`, `workflows:write`
  - Organization: `members:read`
- **Events 订阅**：`issues`, `issue_comment`, `pull_request`, `pull_request_review`, `push`, `installation`, `installation_repositories`, `member`

需要在 dev / staging / prod 三个环境各创建一个 App。

### 5.2 Env / Secrets

新增：

- `FIRST_TREE_HUB_GITHUB_APP_ID`
- `FIRST_TREE_HUB_GITHUB_APP_PRIVATE_KEY`（PEM，建议走 secret manager 而非直接拼字符串）
- `FIRST_TREE_HUB_GITHUB_APP_WEBHOOK_SECRET`
- `FIRST_TREE_HUB_GITHUB_APP_CLIENT_ID`
- `FIRST_TREE_HUB_GITHUB_APP_CLIENT_SECRET`

老 env `FIRST_TREE_HUB_GITHUB_OAUTH_CLIENT_ID/_SECRET` 在 D3 决议前保留作为回滚后路。

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
| [api/auth/github.ts](../packages/server/src/api/auth/github.ts) | OAuth start endpoint 切换到 App user authorization URL；callback 处理 `installation_id`；token refresh |
| 新增 `services/github-app.ts` | App JWT 签名（RS256 + private key）；installation token 申请；user token refresh |
| 新增 `api/webhooks/github-app.ts` | 单一 endpoint；payload 里 `installation.id` 反查 `hub_organization_id`；下游复用现有 `github-adapter` pipeline |
| [api/webhooks/github.ts](../packages/server/src/api/webhooks/github.ts) | 按 D3 处理（保留只读 / 废弃） |
| `services/github-oauth.ts` | 重命名为 `github-api.ts`，新增按 installation token 调 GitHub API 的封装（建议 Octokit App auth） |

### 5.5 Web 改动

- **登录页**：按钮文案 "Sign in with GitHub" 不变，链接目标改为 App user authorization URL（合并 OAuth + install）。
- **Settings → Integrations**：新增 panel，展示当前 installation：account login + type + permissions + selected repos，加 "Manage on GitHub" 跳转链接。
- **Step 3 repo picker**：不动。继续用 user token 调 `/user/repos`。可选 hint："这些 repo 已通过 App 接入 webhook"。
- **Step 3 tree destination todo**：`installation.account_login` 可作为预填来源，但解耦在独立 todo 里，不在本设计范围。

### 5.6 现有依赖路径处理

- **`github-adapter` agent + #283 dedup**：保留，作为统一下游 pipeline。新 App webhook 与老 per-repo webhook 都喂进它。
- **CLI（`first-tree-hub client connect`）**：不受影响。Client 用 Hub user JWT，跟 GitHub 凭证完全无关。
- **Dev 旁路**：现有 `/auth/github/dev-callback` 是 non-production 的假 OAuth 回调。App 模式下需要新增 `dev-installation` 旁路，返回固定 fake `installation_id`，否则本地开发跑不通完整流程。

---

## 6. 风险与待 sanity-check

1. **Phase 4 identity convergence 在 personal account 上的语义**：personal account 没有 members 概念。建议 `members/` 同步在 personal-installation 上 no-op 或只同步 owner 自己。**不阻塞本次落地**。
2. **与 breeze (Candidate A) 的边界**：breeze 是 Hub client variant，持有用户的 `gh` login（user-level）。Hub App installation 是 account-level（org 或 personal）。两者**不冲突但要避免 UI 混淆**——"装了 App 之后 breeze 还要不要单独登录 gh"。breeze 实装时再厘清，本次不解决。背景见 memory `unified-product-direction.md` Candidate A。
3. **Token 安全模型变化**：从"不过期的 access token"变成"8h TTL + refresh token"。refresh token 本身要加密存储，且 refresh 失败要有明确 UX（提示重新登录）。
4. **D3 决议影响代码组织**：选 c（共存）意味着新 `webhooks/github-app.ts` 与老 `webhooks/github.ts` 并存，[app.ts](../packages/server/src/app.ts) 路由注册时要清晰区分。
5. **App private key 的运维**：PEM 不能扔 env var 拼字符串。需要确认团队现有 secret manager pattern。
6. **Dev / staging / prod 三套 App 的私钥与回调 URL**：三个独立 App 各自一套配置。CI 流程要明确。

---

## 7. 落地建议顺序（Phase 1 候选）

1. 创建 GitHub App（dev / staging / prod 三套），团队层面分配 secret
2. DB migration：新增 `github_app_installations` 表 + `auth_identities` 扩字段
3. OAuth 切换：登录走 App user authorization；保留老 OAuth client_id 作为回滚后路
4. Install 回调 + installation 入库
5. 新 App webhook endpoint + 下游复用 `github-adapter` pipeline
6. Settings → Integrations UI 上线
7. **按 D3 决议**处理老 endpoint

---

## 8. 给 review 的工程师的关键问题

1. **D3 选哪个**？（推 c）
2. **D4** 是否同意 "现在不并 automation 但 permissions 留余量"？
3. **installations 表的 1:1**（Hub team ↔ GitHub account）是否同意？还是允许多绑？
4. **App private key 存储**：团队现在有没有标准 secret manager pattern 可复用？
5. **Token TTL 变 8h** 对客户端 / API 调用有没有运维影响？

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
