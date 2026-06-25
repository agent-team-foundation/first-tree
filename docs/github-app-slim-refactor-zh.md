# GitHub App 瘦身 + 绑定/安装简化（设计）

## 出发点

1. **让用户更信任 GitHub App** —— 权限最小化。
2. **让「绑定 GitHub + 安装 App」更简单**。

## 改动

1. **App 缩权。** 终态权限只保留：`Metadata: read` + `Pull requests: read` + `Issues: read` + `Contents: read`（仅为 web 显示 tree）。砍掉：org `Members: read`、`Administration: write`、`Workflows: write`、`Pull requests: write`、`Contents: write`。

2. **Context Tree 创建/初始化/更新交给 agent 用本地 `gh`**（不再走 App 的 server 端写）。`gh` 标准 `repo` scope 已覆盖建库/读写普通文件；**唯一例外** = `.github/workflows/validate-tree.yml`（写 `.github/workflows/` 需 `workflow` scope）。
   - **`workflow` 提权是交互式的**：`gh auth refresh -s workflow` 会走一次 GitHub OAuth 重新授权（device-code / 浏览器），**必须由用户本人在 GitHub 前端手动点确认**，agent 无法替他完成。
   - 因此**优先方案 = 不在本地 seed 该 workflow**（它只是可选 CI 校验，可省或后续由用户手动加），从而完全免掉这次手动提权。

3. **不再区分 GitHub user / org。** 二者作为「repo owner」对称，`gh repo create <owner>/<name>` 通吃 → 去掉 provisioner 的 user/org 建库分叉代码（`ensureOrganizationRepo` / `ensureUserRepo` 合一）。

4. **Org creator = GitHub install + login。** 不再探测用户的 repo/org admin 权限（去掉 `verifyUserCanAdministerInstallation` 的探测），交给 GitHub 原生 gating：有权 → self-install；无权 → GitHub 自动给 owner 发批准请求。这同时拔掉 `Members: read` 的**唯一消费者**（它原本只用于 `GET /user/memberships/orgs/{org}` 的 org-admin 探测）。

5. **Invitee = GitHub login only。** invitee 是 First Tree org member，团队的**一个** installation 已覆盖那些 repo，invitee **不需要也不应再装** App（个人账号场景下他物理上**不能**装到创建者账号；org 场景下也只是冗余 no-op）。✅ 已确认。

6. **记录 install 成功。** 监听 `installation.created` webhook（已有 → `upsertInstallationFromMetadata` 写 `github_app_installations`）。前端 `GET /me/onboarding/tree-setup-status` 探针 + `findInstallationByOrg` 查状态。invitee 据此安全跳过 install。

## 安装 / 登录流程（统一入口、install 按需）

- **login 普适**：人人都做，建 identity → agent 路由。
- **install 按条件出现**：仅当「team 还没 installation」**且**「当前用户能装」时提示 —— org 提示 owner / repo-admin；个人账号只有创建者本人能装。
- **不 hard-block**：没装成也能 login 进产品（已有 `finish-later` / `no_installation` 优雅态 / recovery 探针；tree setup 本就只对 admin 提示）。装好后**异步可知**，invitee 自动跳过。

## 关键约束 / 风险

- **绑定防伪（改动 4 的前提）**：去掉 admin 探测后，**不能再信任浏览器回传的 `installation_id`**（否则贴别人的 id 即可伪造绑定）。改用 **install+login 合一次往返、回调直接带回的 `installation_id`**，或 **`installation.created` webhook** 作为可信锚点绑定 team。即 **改动 4 依赖「install+login 合一步」**。
  - 注意 `installation.created` webhook 落库时是 **unbound** 的（webhook 不知道是哪个 First Tree 用户装的）；「绑到哪个 team」仍需一次用户认领（OAuth 回调）。delayed-approval（owner 后来才批准）场景要有「回来认领」的收尾。
- **一个 team = 一个 installation = 一个 GitHub 账号**（schema `UNIQUE(hub_organization_id)`）。automation 覆盖范围 = 那一个 installation 选中的 repo。
- **tree repo 必须在 App installation 覆盖范围内**，否则：① Context Tree PR reviewer 收不到 PR webhook；② web 显示 tree 的 git-fetch 读不到。改动 2 由 agent 建 tree repo 后，要把它纳入 installation 的 repo 选择（或安装时选 "all repos"）。
- **`Contents: read` 是核心取舍**：它是 **installation 级**权限 = 能读**所有被授权 repo**（不只 tree repo）的源码，与「信任」最冲突。web 的 context 页面其实是两块拼的，数据源不同：
  - **tree 图 / dashboard** = 服务端 **git-fetch tree repo**（= `Contents: read`）。**去掉 Contents:read → 这块坏**（`snapshotStatus: "unavailable"`）。
  - **下方的 context feed（IO 活动流 + usage）** = 来自 **`context_tree_io_events` 等 DB 遥测**，**不碰 GitHub**。**去掉 Contents:read 它照常活**（写归因会从「git 派生 + 遥测对账」退化为「纯遥测」，但 feed 本身不丢）。
  - ⚠️ 注意：目前 UI 把 feed 渲染**门控在 snapshot 可用之下**（snapshot unavailable 时整页走「未就绪」分支、feed 一起被藏）。所以「去 Contents:read 但保住 feed」**需要一处小改动**：把 `ContextUsageFeed` 与 tree 图解耦、即使 snapshot 不可用也独立渲染。
  - **三个选项**：(4a) **保留 `Contents: read`** → dashboard + feed 都全（本次默认）；(4b) **去掉 `Contents: read`** → dashboard 退化、feed 解耦后保留（信任满分、改动小）；(4c) 新建 **agent → server 推 tree snapshot** 通道 → 零源码读取 + dashboard 也保住（信任满分、工程量最大，后续可选）。**本次取 4a，把 4b/4c 列为后续可选优化。**

## Context Tree Review Agent —— 不冲突（已调研）

`context-reviewer-pr.ts`：

- 由 **tree repo 上的 PR webhook**（`pull_request` opened/synchronize、`issue_comment`）触发，在 First Tree **chat 内**评审。
- **不回写 GitHub、不在 server 端读 diff**（diff 由 agent 本地 `gh` 读）。
- 依赖的就是**保留下来的 `Pull requests: read` + `Issues: read`**，与缩权完全兼容。
- 唯一前提同上：**tree repo 在 installation 覆盖内**（PR webhook 才到）。

**结论：6 项改动均不影响 Context Tree Review Agent。**

## 权限对照（前 → 后）

| 权限 | 现在 | 改后 | 原因 |
|---|---|---|---|
| org `Members: read` | ✓ | ✗ | 唯一消费者（admin 探测）去掉 |
| `Administration: write` | ✓ | ✗ | 建 repo 改走本地 gh |
| `Workflows: write` | ✓ | ✗ | validate-tree.yml 改走本地 gh |
| `Contents: write` | ✓ | ✗ | tree 写改走本地 gh |
| `Pull requests: write` | ✓ | ✗ | 自动化纯入站、无回写 |
| `Contents: read` | ✓ | ✓ | 仅为 web 显示 tree（取舍项） |
| `Pull requests: read` | ✓ | ✓ | 路由 + reviewer + live 状态 |
| `Issues: read` | ✓ | ✓ | 路由 + reviewer + live 状态 |
| `Metadata: read` | ✓ | ✓ | repo 访问底座（GitHub 强制） |

安装门：**owner-only → repo-admin 自助**（缩权后 App 不再请求 org / administration 权限）。

## 相关任务

- #1301 —— 去掉 follow-commit（commit 实体解析）。注：因本次**保留** `Contents: read`，#1301 在权限上不再省东西，但仍值得做（删无用功能 + 去掉一条读源码 commit 的路径）。
