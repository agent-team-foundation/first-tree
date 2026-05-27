# Proposal — Connect Computer 体验优化

| | |
|---|---|
| **作者** | @gandy-assistant（需求对接） |
| **日期** | 2026-05-26 |
| **目标实现方** | @gandy-developer |
| **范围** | Settings → Computers 入口，包含 `/clients`、`/settings/computers`、NewConnectionDialog、相关 server 端 dedup 与孤儿治理 |
| **优先级** | P0 必须做、P1 应该做、P2 延后 |

---

## 1. 背景

### 1.1 这是什么页面？谁来用？

Settings → Computers（实现为 `ClientsPage`，路径 `/settings/computers` 与 `/clients` 双入口）是 first-tree-hub 让用户**看到并管理"agent 在跑的那台机器"**的地方。

数据层叫 client，用户面前一律叫 **Computer**——一台已通过 `first-tree login` 配对、跑着 daemon、能承载 agent 的机器。**Agent 必须钉到一台具体 computer 上才能工作**，所以这台机器的状态直接决定 agent 是死是活。

按当前 1:1 简化策略，绝大多数用户在自己的物理机上**只装一台 computer**。所以这个页面对他们而言，本质是「**我那台 agent 在跑的机器现在怎么样了**」的状态面板，不是机群管理面板。

### 1.2 用户什么时候来这里？

按真实频率推断：

1. **排查故障**（最高频）："我的 agent 没反应了，是不是机器断了？认证过期了？版本不对？"
2. **Admin 帮成员排查**："Alice 反馈不工作，我去看看她那边状态"
3. **新增机器**（低频）：买了新电脑，想加进来
4. **生命周期管理**（极低频）：清理不用的旧机器、换电脑迁移

### 1.3 当前用户来这里会撞到什么

具体的 UX 失败（按严重度排序）：

- **想加新机器，弹窗永远在 "Waiting…"**——点 "Connect computer"，命令复制粘贴跑过去如果出错（CLI 没装、token 过期、网络问题），modal **没有任何反馈**，只是一直转圈。新用户束手无策、老用户重复踩坑
- **页面里出现两、三、五台 computer，但用户只有一台**——数据库里堆积的"孤儿行"被原样展示，用户分不清哪台是真的、哪台是历史残留，连主线诉求"看看我那台机器怎么样"都做不到
- **agent 出问题时找不到答案**——用户来就是想知道"机器哪里坏了"，但当前列里只有 *连接时间*（不是心跳时间）、*first-tree 版本字符串*（无状态指示）、*AUTH EXPIRED 红标*（但没有"点这里恢复"的入口）。**用户能看到症状，但点不到解药**
- **Admin 想帮成员排查，但看不到关键信息**——team view 的行**完全不能展开**，capability 详情 / 认证状态全部隐藏，admin 无法判断成员是 SDK 没装、auth 过期、还是 daemon 挂了。"帮团队排障"这个场景在 Web 上根本做不到
- **新用户的安装阻塞无引导**——onboarding 已经有 75s "stuck panel" 兜底（提示 npm 没装、Node 版本等常见原因），但 Settings 这个 modal 完全没复用。回流的用户撞到同一面墙的同一个位置

### 1.4 共同后果

这个页面没有发挥它该发挥的「**我的 computer 状态面板**」作用：
- agent 出问题时进来找不到答案
- admin 想支持团队也找不到入口
- 用户对产品的"机器可观测"判断会从这里开始崩塌

### 1.5 为什么现在做

- **孤儿行只增不减**——不修，每次用户重装/换 channel 都在累加噪音
- **范围明确、不需要前置决策**——本期不涉及 Workspace 抽象、不涉及 cloud runtime，是一次纯局部优化，可快速交付
- **是"agent 当员工"叙事的下限**——员工出问题至少要让经理（用户/admin）一眼看到问题在哪、点哪里能修

本 proposal 梳理产品定位、用户场景、根因、优化方案，并分期落地。

---

## 2. 产品定位与设计原则

### 2.1 Computer 是虚拟概念

数据层名为 `client`（DB 表、TS 类型、API 都用此名），用户面前一律称 "Computer"。这是有意的语言分裂。

身份由 `~/.first-tree/config/client.yaml` 中的 `client.id` 标识，**跟物理硬件不绑定**（当前 SDK 完全不采集硬件指纹）。

### 2.2 当前 1:1 简化策略

**一台物理设备 = 一个 computer**。非管理员用户在自己的物理机上只装/跑一个 computer。这是产品当前的有意简化，是为了：

- 心智简单：用户不需要管理"一台机器跑几个 worker"
- IA 简单：UI 不需要为"多 worker per machine"留位置

放开 1:1 是未来选项，**当前不做**。

### 2.3 用户分布预期

| 用户群 | 占比（估） | computer 数 |
|---|---|---|
| 单设备用户 | 70-80% | 1 |
| 双设备 | 15-25% | 2 |
| 多设备/重度 | <5% | 3+ |

**绝大多数用户在该页面只会看到 1 行**。这是页面 IA 必须服务的主线。

---

## 3. 用户场景

按**重要性（频率 × 痛感）**排序——主线优先，边角靠后。

### S1｜排查自己机器的故障（最高频、最痛，主线）

普通用户「agent 没反应」时来这里找答案。每个子场景都对应一种现实异常：

| 子场景 | 描述 | 用户当下心理 |
|---|---|---|
| S1.a | "我的 agent 不工作了，是不是机器掉线了" | 紧急、想立刻知道答案 |
| S1.b | "我看到 AUTH EXPIRED 红标，这是什么、怎么办" | 困惑、想要明确指引 |
| S1.c | "Claude Code 那边的 cred 过期了 / 换 key 了，怎么刷新到 hub 这边" | 知道问题在哪、想要操作入口 |
| S1.d | "我的 CLI 提示版本旧，hub 这边怎么显示" | 想确认是不是 hub 不接受了 |
| S1.e | "daemon 挂了我自己不知道——agent 表面上"在"，实际不响应" | 被动发现、想要主动告警 |
| S1.f | "我笔记本重启过，agent 会自动回来吗" | 不确定、想验证 |

**主线诉求**：**进来一眼看到机器状态（4-pill）+ 每个异常都有明确的下一步动作**。状态 pill 与判定见 proposals/connect-computer-default-view-mockup.md。

### S2｜Admin 帮成员排障（次主线，high-impact，决定团队信任）

Admin 不会主动改 team 成员的机器，但需要**看见诊断信息然后给出建议**：

| 子场景 | 描述 | Admin 当下行动 |
|---|---|---|
| S2.a | 成员私信"我 agent 不工作"——admin 打开看成员机器状态 | 看 lastSeen / SDK / auth / capability 信息 → 翻译成"请你跑这个命令" |
| S2.b | 主动巡检：哪些团队成员的机器有隐患 | 扫所有 team 行，按异常排序 |
| S2.c | 推升级前确认范围："谁的 CLI 低于 v1.3"，"谁的 Claude Code 没装" | 按 SDK / capability 筛选 |
| S2.d | 离职成员的孤儿机器需要清理（admin 视角） | 找到该用户的所有 computer + 退役 |

**主线诉求**：**team view 能看到跟自己机器一样多的诊断信息**，并能一键复制"给成员的修复建议"。

### S3｜首次接入（频率：每用户至多 1-2 次）

| 子场景 | 描述 | 谁接 |
|---|---|---|
| S3.a | 新用户配置第一台机器 | **onboarding 已接住**，不是本页主线 |
| S3.b | 跳过/中断 onboarding 后回来补 | 本页面的"+ Connect computer"应能接住 |

**主线诉求**：onboarding 流的兜底（stuck panel、command 自带 install）必须**回流到本页面的 modal**，避免回流用户撞同一堵墙。

### S4｜新增机器 / 生命周期（低频，每用户每年 0-2 次）

| 子场景 | 描述 |
|---|---|
| S4.a | 买了新电脑，想加进来 |
| S4.b | 笔记本进水/丢/换新机，想迁移 agent |
| S4.c | 清理多月不用的旧机器 |

**设计含义**：这是"+ Connect computer"和"Retire"按钮真正的服务对象，但**频率远低于 S1**——不应该作为页面顶部最显眼操作。

### S5｜创建/编辑 agent 时选 computer（不在本页面）

发生在 `/agent/:id` 详情页，本 proposal 范围外，但影响**本页面对外的语义契约**：本页面是 agent 的 computer 真值源，所以列表数据必须可靠。

### 暂不进入本期设计视野

- 多机调度 / agent fail-over / hosted runtime — 与 1:1 简化策略冲突，留待后续
- Workspace 抽象层（agent → workspace → computer 三层）— 同上

---

## 4. 当前问题清单与根因

### 4.1 问题清单

| # | 问题 | 影响范围 | 严重度 |
|---|---|---|---|
| Q1 | "永远 connecting…" — NewConnectionDialog 卡死无出路 | 所有点击 "Connect computer" 的用户 | 🔴 高 |
| Q2 | 数据库出现重复 computer 孤儿行 | 重装/换 channel/手动清理过的用户 | 🔴 高 |
| Q3 | 页面按机群管理设计，与 1 台机器的现实不符 | 单设备用户（70-80%） | 🟡 中 |
| Q4 | Admin team view 不能展开诊断信息 | Admin 排查团队问题时 | 🔴 高 |
| Q5 | 用户无法识别"该升 SDK / 重新认证" | 所有出故障的用户 | 🟡 中 |
| Q6 | "+ Connect computer" 被误点击（用户想修不想加） | S1（排查故障）用户 | 🟡 中 |
| Q7 | install/upgrade 卡点无引导（command not found 等） | 新用户、版本旧的用户 | 🟡 中 |

### 4.2 根因分析

#### Q1 根因｜NewConnectionDialog 只有 "waiting" 一种出路

`packages/web/src/pages/clients/new-connection-dialog.tsx` 进入 `phase=waiting` 后**只有一种成功条件**（检测 `connectedAt ≥ openedAt`），所有失败场景都表现为同一个 spinner：

| 实际状态 | UI 表现 | 用户能识别吗 |
|---|---|---|
| 用户还没复制命令 | spinner | ✓ |
| CLI 未装，命令报 `command not found` | spinner | ✗ |
| Token 已过期（>10min） | spinner | ✗ |
| 网络/防火墙问题 | spinner | ✗ |
| 跑错 channel | spinner | ✗ |

**关键缺失**：token 过期不切 error、没有 stuck 兜底面板（onboarding 75s 面板未回流）。

#### Q2 根因｜重复 computer 行来自多条路径，无清理机制

主要根因（已确认 code path）：

1. **服务端只用 `client.id` 做 unique key**，没有 `(user_id, hostname, os)` 软去重。`packages/server/src/services/client.ts:51-127` `registerClient` 仅 ON CONFLICT on `client.id`
2. **多 channel 各自独立 yaml**（`first-tree` / `first-tree-staging` / `first-tree-dev` 三套 channel home），登录到同一 hub 会注册成多行。详见 `packages/shared/src/config/resolver.ts:53-59`
3. **`client.yaml` 被销毁 → 自动生成新 id**（`packages/shared/src/config/resolver.ts:138-139` + `:348-360`），旧行在 server 留下成孤儿
4. **完全无自动清理**：`cleanupStaleClients` (`client.ts:459-479`) 只翻 status 到 disconnected，不删行
5. **daemon 跟 yaml 没联动**：手动 rm yaml 但 daemon 还在跑会产生幽灵心跳

**注意**：经过仔细排查，**`logout` 命令本身实现是正确的**（先停 daemon、默认保留 yaml；详见 `apps/cli/src/commands/logout.ts`）。重复行不是 logout 的 bug，是其他几条路径累加 + 无清理。

#### Q3 根因｜表格 IA 假设 N 台机器

`packages/web/src/pages/clients.tsx` 顶部 summary chip `"X total · Y connected · Z agents bound · W need re-auth"`、admin 双栏、表格列结构——这些都是面向 N 台机器的 IA。对**只有 1 台的 70-80% 用户**，这是过度设计。

#### Q4 根因｜admin "看" 和 "动" 被一起 restrict

代码中 `restricted = true` 同时压制了三件事：
- 隐藏 action 按钮（合理，server 也 403）
- 禁止行展开（**不合理**）
- 禁止 capability matrix 请求（**不合理**）

**更深层**：server `GET /clients/:id` 对非 owner 直接 403。这把"admin 不能动 team 机器"和"admin 不能看 team 机器"混在一起，跟"admin 帮 team 排查"的产品意图冲突。

#### Q5 根因｜状态信号未上行

- "Connected" 列实际显示 `connectedAt`，不是 `lastSeenAt`——admin 无法分辨"daemon 还活着 vs 早就挂了"
- 多个状态信号（`status` / `authState` / 每个 `capabilities[*].state`）分散在不同列与展开行里，**没有一个汇总判定**告诉用户/admin "这台机器现在能不能跑 agent"
- AUTH EXPIRED 是纯客户端时间推断（`deriveAuthState`），但 UI 没有把它跟 connection/capability 状态合并成单一行动结论

#### Q6 根因｜入口语义与用户意图错位

页面最显眼的 "+ Connect computer" 按钮假设用户主要意图是"加新机器"。**但实际访问者大多数（S1（排查故障））是来排查问题的**，期望按钮帮自己"修好"，结果它只服务"加全新机器"——用户点错后陷入 Q1 的死路。

#### Q7 根因｜两条 connect 流未统一

- Onboarding (`step-connect-computer.tsx`) 命令是双行 `npm install -g first-tree\nfirst-tree login <token>`，自带 install + 75s stuck 面板 + 终端引导
- Daily NewConnectionDialog 命令是单行 `first-tree login <token>`，**假设用户已装 CLI**，无 stuck 兜底、无引导

---

## 5. 优化方案

按优先级分三层。

### P0 ｜核心治本（必须做）

#### P0-1 服务端去重 + 孤儿治理

**目标**：消灭重复 computer 行的产生与堆积。

- **服务端 soft dedup**：`registerClient` 在 ON CONFLICT 之前先按 `(user_id, hostname, os)` 查找同一用户的 `connected` 行；存在则复用其 `client.id`，把 yaml 回写为该 id；不创建新行
- **daemon ↔ yaml 联动**：daemon 启动 + 周期校验 yaml 里 client.id 跟它内存的是否一致，不一致自杀
- **自动孤儿归档**：服务端定时任务，`disconnected > 30 天 + 0 agents pinned` 的行自动归档（soft delete or hide）

#### P0-2 NewConnectionDialog 修正

**目标**：消灭"永远 connecting"。

- 到 `token.expiresIn` 自动切到 `phase=error`，提示重新生成
- 抽取 onboarding 的 75s stuck 面板，复用到 daily modal（同一组件）
- 命令统一为 self-bootstrapping 双行 `npm install -g first-tree\nfirst-tree login <token>`
- modal 副标题加先决条件提示
- 加 "我已经跑了但没反应" troubleshooting 入口

#### P0-3 页面 IA 重组（详细示意见 mockup 文件）

**目标**：让 70-80% 单设备用户看到适合 1 台的视图。

- 1 台 computer 时显示**详情卡片视图**（不显示表格）
- 2+ 台时退化为卡片列表（响应式：≥1024 2-up 并列，<1024 单列堆叠）
- 顶部一句话状态描述（按 4-pill 派生），不再是 "X total · Y connected" chip 堆
- "+ Connect computer" 按钮**降权到次要位置**

详细示意见 proposals/connect-computer-default-view-mockup.md（Variant A/B-1/B-2/B-3/C）。

#### P0-4 状态 pill 派生 + 信号上行

**目标**：让 S1（排查故障）用户和 admin 一眼看到机器现在能不能用、坏在哪。

- **引入 4-pill 状态**（前端纯函数派生，**无新 server 字段、无阈值**）：
  - 🟢 **Ready** = `status=connected` AND `authState=ok` AND 至少一个 capability `state=ok`
  - 🔴 **Auth expired** = `authState=expired`
  - 🟡 **Setup incomplete** = `status=connected` AND `authState=ok` AND 所有 capability `state≠ok`
  - ⚪ **Offline** = `status=disconnected` AND `authState=ok`
  - 判定顺序自上而下，命中即停
- 显示 `lastSeenAt`（"心跳 12 秒前"）替代/补充 `connectedAt`
- `first-tree` 版本字段名替代"SDK"（不参与 pill 判定，仅展示——本期不引入版本健康对比）
- capability matrix 主视图可见，不再深埋展开行

### P1｜操作可达性（应该做）

#### P1-1 行内 state-aware 操作

**目标**：把"我下一步该做什么"直接呈现，不让用户猜。

| 卡片 pill | 行内主操作 |
|---|---|
| 🟢 Ready | 无主操作；可选行末"Install Codex"/"Sign in"等次要入口 |
| ⚪ Offline | "Start the daemon on this machine" + 复制 `first-tree daemon start` |
| 🔴 Auth expired | **行内 "Generate new token" → 配 `first-tree login <token>` 复制框** |
| 🟡 Setup incomplete | **Claude Code 与 Codex 对等展示**，每个独立 box 含 install + login 命令 |
| Capability `error` | 显示 error message + troubleshooting 文档链接 |

#### P1-2 Admin team view 解锁诊断

**目标**：让 admin 真正能帮 team 排查。

- **server 端**：admin 可读 team 机器的 capability / auth state（保留 action 限制）
- **UI**：team 行可展开展示同样信息，仅没有 action 按钮
- **默认 tab 是 "Your computer"**（更高频，team 是支持场景再切）
- 每行用**单一 pill** 展示状态（🔴/🟡/⚪/🟢），按 pill 优先级排序，问题自然冒上
- **"Copy suggestion → 成员名"按钮**：按 pill 状态选固定模板，弹可编辑预览，placeholder 自动填充（详细模板见 mockup §"Copy suggestion 消息模板"）
- 大团队支持：按 pill / heartbeat / hostname 筛选排序

#### P1-3 用户清理孤儿入口

**目标**：给已经污染的 DB 一条逃生通道。

- UI：检测到"看起来是同一台机器的旧记录"时提示合并/隐藏
- CLI：`first-tree computer prune`，扫同用户名下重复+老的 disconnected 行

#### P1-4 S1 排查路径梳理

**目标**：每个 pill 状态都明确映射到下一步动作（详细见 mockup Variant B-1/B-2/B-3）。

- 🔴 Auth expired → 行内 "Generate new token" + `first-tree login <token>` 复制框
- ⚪ Offline → 行内说明 "Make sure the machine is awake; if daemon isn't running, run `first-tree daemon start`"
- 🟡 Setup incomplete → 对等展示 Claude Code / Codex 两个 install box
- Capability `error`（横跨任何 pill）→ 显示 error 详情 + 文档链接

### P2｜延后（可以不做，等数据说话）

- **Machine fingerprint**：仅在 P0/P1 落地后还有用户因"洗牌重来"产生重复时再做。涉及 3 个 OS API、协议变更、schema 变更、隐私评估。**当前不必要**
- **Adopt 命令**：让新机器继承已有 client 身份。1:1 策略下主要为"换电脑"场景，频率低
- **OS-aware 安装命令**：按 UA 区分 mac/linux/windows 安装方式
- **Hosted runtime / cloud worker**：与 1:1 策略相关的大方向，已搁置

---

## 6. 实施分期

### 第一交付（建议 2-3 周）

**目标**：消灭"永远 connecting"和重复行 bug；让单设备用户的视图对齐现实。

包含：
- P0-1 服务端去重 + 孤儿归档 + daemon ↔ yaml 联动
- P0-2 NewConnectionDialog 修正
- P0-3 页面 IA 重组（单设备卡片视图 + 响应式多卡片）
- P0-4 状态 pill 派生 + lastSeenAt + first-tree 版本字段（无版本对比）

**验收信号**：
- 单设备用户在 Settings → Computers 看到状态卡片，不是表格
- 多次 logout/重装的用户不会再产生新孤儿行
- "永远 connecting" 不再发生（要么成功、要么明确报错有出路）

### 第二交付（建议 2-3 周）

**目标**：让 admin 能在 Web 端帮成员排查；让用户清理已有孤儿。

包含：
- P1-1 行内 state-aware 操作
- P1-2 admin team view 解锁诊断 + 修复建议复制
- P1-3 用户/CLI 清理孤儿
- P1-4 S1 排查路径梳理

**验收信号**：
- Admin 在 team view 能看到每个成员机器的 SDK 版本、auth 状态、capability，并能一键复制修复建议
- 用户能在 UI 或 CLI 清理掉自己历史的重复行
- 出现 AUTH EXPIRED 的用户能直接点行内按钮恢复，无需多步

### 后续（数据说话再决定）

P2 各项。在第一/第二交付落地后跑 1-2 个月数据，看：
- 是否还有用户因"洗牌重来"产生重复（决定是否做 fingerprint）
- 多机用户的换电脑频率（决定是否做 adopt）
- 安装失败率分布（决定是否做 OS-aware 命令）

---

## 7. 待决策的产品问题

UI 设计部分的决策已全部锁定（详见 proposals/connect-computer-default-view-mockup.md §"已敲定（全部）"）。

**剩余需要敲定**（主要是后端/治理向）：

1. **去重 key**：`(user_id, hostname, os)` 是否可接受？hostname 不稳，会有少数误判（macOS WiFi 切换偶尔加 `-2` 后缀）。备选：仍用 hostname 但加 "merge candidates" 提示让用户手动确认
2. **孤儿归档阈值**：30 天 + 0 agents pinned 算保守。可以更激进（14 天）或更保守（90 天），看你想要的清理速度
3. **页面命名/路径**：当前双入口 `/clients` + `/settings/computers`，是否合并/重定向？保留哪条为正？
4. **`logout --purge` 警告**：当前实现正确（先停 daemon 再删 yaml），是否要加"这会让你失去这台机器的身份"明确警告？

**已锁定**（不再讨论）：
- UI 状态展示用 4-pill（Ready / Auth expired / Setup incomplete / Offline），无新 server 字段、无阈值
- 不引入 SDK 版本对比（first-tree 版本只展示、不参与判定）
- Copy suggestion 用产品提供模板 + admin 可编辑
- Admin 默认 tab 是 Your computer
- 多设备布局响应式（1024px 断点）

---

## 8. 关键代码定位（供 @gandy-developer 参考）

### 服务端
- `packages/server/src/services/client.ts:51-127` — `registerClient`（P0-1 dedup 改动入口）
- `packages/server/src/services/client.ts:419-448` — `retireClient`
- `packages/server/src/services/client.ts:459-479` — `cleanupStaleClients`（P0-1 孤儿归档挂这里）
- `packages/server/src/services/client.ts:376-385` — `deriveAuthState`（P0-4 pill 派生输入之一）
- `packages/server/src/api/clients.ts` — 客户端 HTTP 路由
- `packages/server/src/api/orgs/clients.ts:13-31` — admin team 列表（P1-2 解锁 read 权限点）
- `packages/server/src/api/agent/ws-client.ts:435-497` — `client:register` WS 处理

### Web 前端
- `packages/web/src/pages/clients.tsx` — ClientsPage 主视图（P0-3 IA 重组主战场）
- `packages/web/src/pages/clients/new-connection-dialog.tsx` — NewConnectionDialog（P0-2 修正主战场）
- `packages/web/src/pages/onboarding/steps/step-connect-computer.tsx` — 75s stuck 面板源（P0-2 复用）
- `packages/web/src/components/connect-command-panel.tsx` — 共用 panel
- `packages/web/src/hooks/use-disconnected-computers.ts` — disconnected chip 数据源
- `packages/web/src/api/activity.ts` — `HubClient` 类型 + API 函数
- `packages/web/src/pages/agent-detail/setup-section.tsx` — agent ↔ computer 绑定 UI

### CLI
- `apps/cli/src/commands/logout.ts` — **当前实现已正确**（参考但不需要改）
- `apps/cli/src/commands/login.ts` — login 主流程
- `apps/cli/src/commands/upgrade.ts` — upgrade 命令（P1-4 引导关联）

### Shared / config
- `packages/shared/src/config/client-config.ts:17-25` — `client.id` 字段定义
- `packages/shared/src/config/resolver.ts:138-139` — `auto-generate` client_id（P0-1 daemon 联动关联点）
- `packages/shared/src/config/resolver.ts:348-360` — yaml 缺失时的 auto-gen 路径

---

## 9. 不在本 proposal 范围内（明确排除）

为了聚焦，以下议题**不在此次优化中**：

- 多机 fail-over / agent 在多台机器间漂移
- Cloud / hosted runtime
- Workspace 抽象层（agent → workspace → computer 三层）
- Computer 重命名（保留 "Computer" 用户面前不变）
- 机器迁移命令（adopt）
- Solo vs Team 的 IA 大调整

这些已在前期讨论中明确推迟，待第一/第二交付的数据出来后再议。

---

## 10. 下一步

1. 用户（@gandy2025）对 §7 待决策问题给出方向
2. @gandy-assistant 将决策同步给 @gandy-developer
3. @gandy-developer 针对**第一交付**出技术设计文档（含数据迁移方案、API 变更、UI 草图、测试覆盖计划）
4. 技术方案回传 @gandy2025 确认
5. 进入开发

---

*Generated by @gandy-assistant. Reviewed against latest main (`ae96016`).*
