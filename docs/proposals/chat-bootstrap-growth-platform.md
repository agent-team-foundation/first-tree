# Proposal：Onboarding 重构与 Growth 基础平台

状态：架构评审草案

## 摘要

First Tree 当前有两条正在并行推进的工程主线：

- **Onboarding 重构**：把新用户首次体验收敛到 value-first 路径，即连接电脑、创建或复用用户自己的 agent，然后尽快打开第一个有价值的 chat。
- **Growth 增长平台建设**：以 quickstart scan campaign 这条增长试点链路为起点，把外部 campaign/repo intent 带入应用，并复用现有 client、agent、skill、chat 能力完成一次可转化的价值展示。

这两条线现在遇到的是同一个架构问题：**业务已经从单一 onboarding 扩展到 onboarding + quickstart growth + Context Tree setup，但底层仍然通过 onboarding kickoff 命名和接口来启动这些 chat。**

当前代码里的 `/me/onboarding/kickoff`、`kickoffOnboarding`、`chats.onboarding_kickoff_key` 已经不只是 onboarding 逻辑。它们实际承担的是“创建或复用一个 chat，并发送第一条服务端可信消息”的基础动作。这个动作本身的并发和幂等设计是有价值的，但继续放在 onboarding 命名下，会让 growth 和 Context Tree setup 长期依赖错误的业务边界。

本文建议先完成一次必要的边界整理：onboarding 只负责首次设置和 membership lifecycle；growth 拥有自己的 campaign/service/event 基础；Context Tree setup 从 onboarding namespace 中退出。后文把那段“幂等创建 chat + 发送第一条系统消息”的内部机制暂称为 `chatBootstrapService`，它只是实现细节，不是新的产品概念。

## 本 proposal 要解决的问题

这个 proposal 不是为了抽象而抽象，也不是要引入一个新的通用聊天平台。它要解决的是一个已经发生的 ownership 问题：

- Onboarding 的历史接口正在被 growth 和 Context Tree setup 复用。
- Quickstart campaign 已经开始依赖 onboarding kickoff 管道。
- Context Tree setup recovery 仍然挂在 onboarding namespace 下。
- Campaign 数量一旦增加，更多增长入口会继续把业务逻辑写进 onboarding 周边代码。

如果不处理，后续会出现三个直接风险：

1. **Onboarding 继续变重**：本来应该只负责首次设置和完成状态，却会继续承载 campaign、repo scan、Context Tree setup 等非 onboarding 逻辑。
2. **Growth 无法复用**：每增加一个 campaign，都要复制 quickstart 的特殊流程，或者继续往 onboarding kickoff 上加参数。
3. **幂等和归因容易出错**：同一用户、同一 agent、同一 campaign 对不同 repo 重复运行时，如果 key 和事件模型仍然来自 onboarding，很容易复用错 chat 或无法准确分析转化。

因此，这个改动的价值在于：

- 让 onboarding 保持简单，降低新用户路径的维护成本。
- 给 growth campaign 一个可复用的服务边界，而不是把每个 campaign 做成一次性入口。
- 把“创建 chat 并发送第一条系统消息”的并发/幂等逻辑保留下来，但从 onboarding 命名中移出。
- 为增长漏斗提供 Postgres 产品事实源，避免从 log、GA4 或 chat metadata 反推。
- 保持单一 chat model，不引入 chat type、全局 `kind` 或新的 metadata 编排层。

这件事现在有必要做，因为 quickstart campaign 已经进入代码主干，后续 growth 还会继续增加入口。如果等 campaign 数量变多再拆，迁移成本会更高，也更容易把 onboarding 改成事实上的业务杂物层。

## 背景

### Onboarding 重构背景

当前 onboarding 的方向是正确的：首次体验应该尽快证明 agent 有用，而不是要求用户先完成 GitHub App 安装、repo 授权或 Context Tree setup。

当前主路径已经基本收敛为：

- 连接用户自己的电脑。
- 在当前 org 下创建或复用用户自己的个人 agent。
- agent 在线后启动一个 chat。
- start-chat 成功后，再写 onboarding completion。

这个路径的核心价值是降低首次成功体验的阻力。GitHub App、repo 选择、Context Tree 初始化仍然重要，但它们不应该回到 onboarding 的关键路径里。它们更适合放在 Settings、Context tab、task-time setup，或 onboarding 之后由 agent 引导完成。

因此，onboarding 后续应该只承担 membership 生命周期相关的状态：

- 当前 membership 是否需要 onboarding。
- 用户是否已经拥有可用的个人 agent。
- 用户是否 finish later / suppressed。
- 用户是否真正完成了 onboarding。

它不应该长期拥有“创建 chat 并发送第一条系统引导消息”的底层实现。

### Growth 平台背景

quickstart scan campaign 是增长平台的第一条内部闭环链路。它的架构流程可以压缩成：

1. 外部 landing 把 `campaign` 和目标 `repo` 带到 `/quickstart`。
2. Web 校验 intent，并在登录后恢复这份 intent。
3. Web 复用现有 connect-computer 和 agent setup 能力，让本地 client 上线并创建或复用用户的 private agent。
4. 服务端按 campaign 绑定对应的 server-owned scan skill。
5. 服务端启动一个 scan chat，agent 根据已绑定 skill 和首条引导消息执行 repo scan。
6. Skill 产出报告和具体 deliverable，并通过 ask-user card 承接后续转化动作，例如打开 PR、设置 team 或构建 Context Tree。

这条链路已经覆盖长期 growth 平台的核心元素：外部入口、intent 传递、登录回跳、本地 client 连接、agent provisioning、campaign skill binding、价值展示和转化动作。

当前问题不是 quickstart 的产品方向，而是它仍然复用了 onboarding 命名的底层 start-chat/kickoff 管道。随着 campaign 数量增加，这会让增长平台继续依赖 onboarding 语义，长期不稳定。

### 需要拆出的内部机制

Onboarding、quickstart growth、Context Tree setup、未来 GitHub/Slack/Linear 等外部触发器，都会遇到同一个内部动作：

1. 根据业务提供的唯一 key 找到或创建一个 chat。
2. 确保同一个 key 不会重复创建多个 chat。
3. 确保第一条服务端可信消息只发一次。
4. 通知目标 agent。

这个动作应该从 onboarding 命名中拆出来，成为一个和具体业务无关的内部服务。本文后续把它称为 `chatBootstrapService`。

## 当前架构问题

### 1. `onboarding kickoff` 已经变成通用 bootstrap 管道

当前 route 是 `POST /me/onboarding/kickoff`，service 叫 `kickoffOnboarding`，DB 字段叫 `chats.onboarding_kickoff_key`。但这条路径已经不只服务 onboarding，quickstart growth campaign 也通过它启动 campaign chat。

这说明底层能力的真实职责已经变成：

- 按 idempotency key 创建或复用 chat。
- 发送且只发送一次 server-authored bootstrap message。
- 允许调用方在发送前完成必要 side effect。
- 通知参与者。

这些职责不是 onboarding 专属。继续让 growth、Context Tree、未来 integration flow 依赖 onboarding 命名，会让系统边界越来越模糊。

### 2. 底层管道开始理解业务意图

当前 kickoff shape 里有 `kind`，例如 intro、work、tree；quickstart 又往同一条路径里加入 campaign。

这会诱导后续继续往 core 层增加预设类型，例如 campaign_scan、github_review、security_scan。这个方向不符合 First Tree 的产品模型。

我们应该坚持：

- 只有一种 chat。
- chat core 不知道这次 chat 是 onboarding、scan、tree setup 还是 GitHub review。
- agent 要做什么，由 skill 和 bootstrap 内容定义。
- 业务恢复和分析，由 domain service 的状态和事件定义。

因此，长期不应该在 core 层引入全局 `kind` 或 chat type。

### 3. 幂等 key 的语义需要由业务域拥有

当前 key 形态适合 onboarding，但不适合长期 growth。

例如同一个用户、同一个 agent、同一个 campaign，如果扫描不同 repo，必须把 repo canonical key 或 run id 纳入 bootstrap key。否则不同 repo 的 campaign 可能复用同一个 chat。

Core service 不应该根据固定字段拼 key，因为 core 不知道业务唯一性边界。正确做法是：

- domain service 生成 `bootstrapKey`；
- `chatBootstrapService` 只接受并执行这个 key；
- key 的格式和唯一性规则由业务域负责。

### 4. Campaign 行为真相源分裂

当前 Web 管 campaign bootstrap 文案，Server 管 campaign scan skill。对第一批 campaign 还能工作，但不适合增长平台长期扩展。

长期 campaign 行为应该 server-owned，至少包括：

- campaign slug 校验。
- scan skill payload 和版本。
- bootstrap 内容。
- conversion policy。
- 需要写入的事件名称和 properties。

Web 应该负责解析 handoff、展示 setup 状态、调用 campaign API，而不是成为 agent 行为的真相源。

### 5. Growth 缺少稳定的产品事实源

当前 onboarding/growth 事件分散在 server log、GA4、message metadata、session events 中。

这些各自有价值：

- GA4 适合外部流量和页面分析。
- Server log 适合诊断。
- Session events 适合 agent runtime 观察。
- Chat messages 是用户协作记录。

但它们都不应该成为增长漏斗的唯一事实源。增长平台需要 Postgres 中可查询、append-only 的产品事件表，用来回答：

- 哪个 campaign 带来了多少 connect？
- 哪个 repo scan 完成了？
- 哪个 ask-user card 被展示和接受？
- 哪个 campaign 转化到了 team/context tree setup？

### 6. Context Tree setup 仍残留 onboarding namespace

Context Tree setup recovery 本质是 org-level capability，不是 onboarding membership lifecycle 的一部分。

当前 `/me/onboarding/tree-setup-status` 可以短期保留，但长期应该迁到 Context Tree 或 org setup 语义下。它可以复用同一个 chat bootstrap primitive，但不应该继续挂在 onboarding namespace。

## 目标

### Onboarding 目标

- 保持 onboarding 主路径极简。
- Onboarding 只负责 membership lifecycle。
- start-chat 成功后再完成 onboarding。
- GitHub App 和 Context Tree setup 不阻塞首次成功体验。
- Growth 和 Context Tree flow 不再调用 onboarding 命名的 bootstrap API。

### Growth 平台目标

- 支持多个长期可复用 campaign，例如 production scan、agent readiness、security scan、migration audit、repository review。
- 支持同一用户对不同 repo、不同 campaign、不同时间重复运行。
- 避免不同 campaign/repo/run 之间的幂等冲突。
- Campaign execution behavior 由 server 统一拥有。
- 有 Postgres 产品事件事实源，支持 funnel、conversion、experiment 分析。
- 复用现有 computer connection 和 agent provisioning 能力，不重复造 setup flow。

### 平台层目标

- 保持单一 chat model。
- 不引入 chat type。
- 不引入全局 `kind`。
- 不把 message metadata 变成业务编排层。
- Skill 和 domain service 定义业务意图。
- Chat bootstrap core 保持小、稳定、幂等、可复用。

## 建议架构

### 1. 抽出 `chatBootstrapService`

新增内部服务 `chatBootstrapService`，封装“按 key 创建或复用 chat，并发送第一条系统引导消息”的实现细节。

建议输入：

```ts
type ChatBootstrapInput = {
  organizationId: string;
  creatorAgentId: string;
  participantAgentIds: string[];
  bootstrapKey: string;
  topic: string;
  bootstrapContent: string;
};
```

该服务只保证：

- 非空 `bootstrapKey` 最多对应一个 chat。
- 对该 chat 最多发送一次 bootstrap message。
- 并发重试、刷新、双击可以安全收敛。
- 只有真正发送了 message 时才通知参与者。

该服务不负责：

- onboarding completion；
- campaign 选择；
- Context Tree 状态；
- GitHub App 授权；
- skill 决策；
- growth event；
- global kind；
- chat type。

### 2. 业务意图留在 domain service 和 skill 中

调用方负责准备业务上下文、绑定必要 skill/resource、生成 bootstrap 内容、写入业务事件。

建议拆分以下 domain services。

#### `onboardingStartChatService`

职责：

- 解析当前 membership。
- 解析 human agent。
- 解析 target agent。
- 构造 onboarding welcome bootstrap。
- 生成 onboarding 语义的 `bootstrapKey`。
- 调用 `chatBootstrapService`。
- chat bootstrap 成功后写 `members.onboarding_completed_at` 和 suppression 字段。

#### `quickstartCampaignService`

职责：

- 校验 campaign slug。
- 校验并规范化 repo URL。
- 创建或复用目标 agent。
- 绑定 server-owned campaign scan skill。
- 生成包含 repo 或 run identity 的 `bootstrapKey`。
- 调用 `chatBootstrapService`。
- 写入 growth activation events。

#### `contextTreeSetupService`

职责：

- 检查 GitHub App installation。
- 检查 source repo/resource。
- 创建或采用 Context Tree repo。
- 生成 Context Tree setup 的 `bootstrapKey`。
- 调用 `chatBootstrapService` 启动 setup chat。
- 在 Context Tree namespace 下暴露 setup status 和 recovery。

### 3. `bootstrapKey` 由业务域生成

Core 不拼 key，只接受 key。

示例：

```txt
onboarding:<membershipId>:<agentId>:welcome
quickstart:<campaignSlug>:<repoCanonicalKey>:<memberId>:<agentId>
context-tree-setup:<orgId>:<agentId>:<treeRepoCanonicalKey>
github-pr-review:<installationId>:<repoCanonicalKey>:<prNumber>
```

这里重要的不是具体字符串格式，而是唯一性边界由业务域显式决定。

### 4. 不引入全局 `kind`

不要在新的 core 里引入 `kind`。

现有 intro/work/tree 可以留在兼容 wrapper 中，帮助旧路径迁移。但长期 core 不应该通过全局枚举理解业务意图。

如果某个业务域需要分类：

- analytics 用 domain event；
- recovery 用 domain state；
- agent 行为用 skill；
- UI 展示用 domain API 返回的状态。

不要让 chat core 承担这些职责。

### 5. Metadata 最小化

不要新增业务 metadata contract。

短期可以保留当前 trusted system marker 以兼容已有 reader。中期如果要迁出 onboarding 命名，可以把系统标记从 onboarding-specific value 迁到 generic bootstrap marker，但这必须等所有 reader 都迁移后再做。

Message metadata 应该只用于：

- 标记这是服务端可信系统消息；
- 兼容历史 reader；
- 必要的安全/审计信息。

它不应该成为 campaign、onboarding、Context Tree workflow 的状态存储。

### 6. 新增 `activation_events`

新增 append-only 产品事件表，作为 onboarding 和 growth 的事实源。

建议结构：

```txt
activation_events
- id
- user_id
- member_id
- organization_id
- flow
- event
- properties jsonb
- created_at
```

示例事件：

- `onboarding_started`
- `onboarding_agent_created`
- `onboarding_chat_started`
- `quickstart_started`
- `campaign_skill_bound`
- `campaign_chat_started`
- `campaign_ask_shown`
- `campaign_ask_accepted`
- `context_tree_setup_started`
- `context_tree_setup_completed`

它不替代 GA4 和 log：

- GA4 继续做外部页面和来源分析。
- Log 继续做诊断。
- `activation_events` 作为产品事实源。

`activation_runs` 可以后置。只有当产品明确需要跨 tab、跨设备、长流程恢复时，再引入 run model，避免过早做 workflow engine。

## 关键调用链路

### Onboarding start-chat

1. Web onboarding 确认用户已经有 connected client 和 personal agent。
2. Web 调用 onboarding start-chat domain API。
3. `onboardingStartChatService` 解析 membership、human agent、target agent。
4. Service 构造 onboarding bootstrap 内容和 `bootstrapKey`。
5. Service 调用 `chatBootstrapService`。
6. Bootstrap 成功后，service 写 onboarding completion。
7. Web 跳转到 chat。

### Quickstart campaign

1. `/quickstart` 解析 campaign/repo handoff。
2. Web 确保 client connected 和 runtime available。
3. Web 创建或复用用户 private agent。
4. Web 调用 quickstart campaign domain API。
5. `quickstartCampaignService` 校验 campaign 和 repo。
6. Service 绑定 campaign scan skill。
7. Service 生成包含 repo identity 的 `bootstrapKey`。
8. Service 调用 `chatBootstrapService`。
9. Service 写 `activation_events`。
10. Web 跳转到 campaign chat。

### Context Tree setup

1. Context Tree setup surface 调用 Context Tree domain API。
2. `contextTreeSetupService` 检查 GitHub App 和 Context Tree prerequisites。
3. Service 注册 source repos 或创建/adopt tree repo。
4. Service 生成 Context Tree setup 的 `bootstrapKey`。
5. Service 调用 `chatBootstrapService`。
6. Service 写 setup event。
7. Web 跳转到 setup chat 或展示 recovery 状态。

## 迁移计划

### Phase 0：抽 core，不改行为

- 新增 `chatBootstrapService`。
- 把当前幂等创建 chat 和发送 bootstrap message 的核心逻辑迁入该服务。
- 保留 `kickoffOnboarding` 作为 thin wrapper。
- 保留现有 route 行为。
- 更新 `chats.onboarding_kickoff_key` 注释，标记为 legacy bootstrap key name。

### Phase 1：调用方回到各自 domain

- 新增 onboarding start-chat domain service。
- 新增 quickstart campaign start-chat domain service。
- Campaign bootstrap 迁到 server-owned catalog。
- Quickstart 改为调用 campaign domain API，而不是 onboarding API wrapper。
- Quickstart bootstrap key 加入 repo canonical key 或 run identity。
- Context Tree setup 暂时保留现有路径，等 bootstrap core 稳定后迁移。

### Phase 2：补 growth 事实源

- 新增 `activation_events`。
- Onboarding 和 quickstart domain service 写入事件。
- GA4 和 log 保留为 secondary analytics / diagnostics。
- Growth funnel 查询基于 Postgres events。

### Phase 3：迁移 DB 命名和旧接口

- 新增 `chats.bootstrap_key`。
- 双写 old/new key。
- 回填历史数据。
- 读逻辑切到 `bootstrap_key`。
- 退休 `onboarding_kickoff_key` 的业务使用。
- Context Tree setup status 从 onboarding namespace 迁出。
- 所有调用方迁移后，删除 legacy kickoff wrapper。

## 非目标

- 不增加 chat type。
- 不增加全局 `kind` 系统。
- 不在本 proposal 中构建通用 workflow engine。
- 不让 message metadata 成为业务编排状态。
- 不把 GitHub App installation 或 Context Tree setup 放回 onboarding critical path。

## 架构评审问题

1. 是否同意 `chatBootstrapService` 成为服务端可信 bootstrap chat 的内部共享原语？
2. 是否同意保持单一 chat model，业务意图由 skill 和 domain service 定义，而不是由全局 kind 定义？
3. 是否同意在增加更多 campaign 前，将 quickstart campaign 行为迁到 server-owned catalog？
4. 是否同意先建设 `activation_events` 作为 growth/onboarding 产品事实源，并推迟 `activation_runs`？
5. 是否同意短期保留 `onboarding_kickoff_key`，后续分阶段迁移到 `bootstrap_key`？

## 预期结果

完成该重构后：

- Onboarding 只关注首次设置和 membership lifecycle。
- Growth 获得可复用的 campaign 基础平台。
- Context Tree setup 可以从 onboarding namespace 中退出。
- 所有需要服务端可信首条消息的流程都能复用同一个小而稳定的 chat bootstrap core。
- Chat model 仍然只有一种，agent 行为继续由 skill 定义。
