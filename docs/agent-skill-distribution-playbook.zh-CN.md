<!-- markdownlint-disable MD013 -->

# Agent Skill 分发设计手册

[English canonical source](agent-skill-distribution-playbook.md)

> **技术真源：** `agent-skill-distribution-playbook.md`
>
> **同步日期：** 2026-07-16
>
> **版本：** 1.0
>
> **读者：** 产品团队、Skill 作者、Agent Runtime 维护者、安全评审者与发布工程师

## 目的

本手册定义如何把一项 Agent 能力做成可发现、可安装、可验证、可维护、可卸载的产品入口。

核心原则是：

> `SKILL.md` 是能力契约和引导入口，不是包管理器、安全边界，也不能替代确定性的执行接口。

完整分发链路是：

```text
发现 -> 检查 -> 授权 -> 安装 -> 验证 -> 注册
     -> 激活 -> 执行 -> 更新或卸载
```

这条链路必须同时服务两类使用者：

- 人需要一个易懂的入口、明确的信任决策和可预期的结果。
- Agent 需要机器可读的路由元数据、明确流程、确定性工具、可操作错误和验证步骤。

本手册用 **MUST（必须）**、**MUST NOT（禁止）**、**SHOULD（应该）**、
**SHOULD NOT（不应）** 和 **MAY（可以）** 表示规范强度。

## 适用范围

本手册覆盖：

- 单个 Agent Skill；
- 由脚本、CLI、MCP Server 或 API 支撑的 Skill；
- 包含多个 Skill 的 Plugin 或 Marketplace Bundle；
- 项目级、用户级、组织级和 Runtime 托管的安装范围；
- 发现、激活、安全、版本、更新、回滚和卸载；
- 确定性检查和基于模型的路由评测。

本手册不定义：

- 通用 Skill Registry 或包管理器；
- 通用依赖或 Lockfile 格式；
- 应用程序文档的替代品；
- 把常驻规则改造成按需 Skill 的理由；
- 执行不可信仓库中指令的授权。

## 1. 先选择交付形态

不要从编写 `SKILL.md` 开始，应先给能力分类。

| 能力类型 | 推荐交付形态 | 原因 |
| --- | --- | --- |
| 领域知识、评审标准或可重复流程 | `SKILL.md` 加聚焦的参考资料 | 模型获得正确上下文后即可完成工作。 |
| 确定性的本地转换或验证 | `SKILL.md` 加脚本或 CLI | 代码应负责重复性、解析和精确输出。 |
| 远程服务、凭证或持久外部状态 | `SKILL.md` 加 MCP 或 API 集成 | 执行边界需要明确认证和类型化操作。 |
| 多个相关能力，共享依赖或发布周期 | 包含多个 Skill 的 Plugin 或 Marketplace Bundle | Bundle 负责安装、兼容和协同更新。 |
| 所有任务都必须遵守的团队规则 | Runtime Briefing、Policy 或系统配置 | 按需 Skill 可能不激活，不适合作为强制层。 |
| 没有 Agent 专属流程的人类产品 | 常规应用和产品文档 | Skill 应增加 Agent 工作流，而不是复制 README。 |

应使用能提供可靠执行契约的最小交付形态。没有实际需要就增加 Plugin、MCP 或 CLI，会增加生命周期和安全成本；把确定性工作留在自然语言里，则会增加可靠性成本。

## 2. 分离三个平面

生产级 Skill 分发包含三个职责不同的平面。

| 平面 | 职责 | 常见产物 |
| --- | --- | --- |
| 能力平面 | 告诉 Agent 能力做什么、何时使用、如何操作 | `SKILL.md`、参考资料、示例 |
| 执行平面 | 执行确定性工作并返回可检查结果 | 脚本、CLI、MCP Server、API |
| 分发平面 | 解析来源、版本、依赖、安装范围、更新与卸载 | Git Release、包管理器、Plugin Manifest、Installer、托管状态记录 |

三个平面可以位于同一仓库，但契约必须保持独立。尤其是：

- 不得因为 Agent 能执行其中的命令，就把 `SKILL.md` 当成可执行产物。
- 包工具需要检查的分发元数据，不得只藏在自然语言正文里。
- 执行行为不得依赖模型猜测未记录的参数、路径、Schema 或错误恢复方式。

## 3. 定义可移植的 Skill 契约

### 3.1 核心目录

可移植的 Agent Skills 核心是一个包含 `SKILL.md` 的目录，可以附带脚本、参考资料和资产：

```text
report-automation/
├── SKILL.md
├── scripts/
│   └── validate-report.sh
├── references/
│   ├── command-reference.md
│   └── troubleshooting.md
└── assets/
    └── report-template.md
```

分发系统可以在可移植核心之外增加文件：

```text
report-automation/
├── SKILL.md
├── VERSION
├── agents/
│   └── openai.yaml
├── scripts/
├── references/
└── assets/
```

增加非标准文件时，项目必须说明由哪个工具消费这些文件。可移植客户端没有义务理解 `VERSION`、Provider 元数据、Plugin Manifest 或项目特定 Lockfile。

### 3.2 Frontmatter

每个 `SKILL.md` 必须包含合法的 YAML Frontmatter，并至少声明：

- `name`：稳定的小写连字符标识符，且与父目录同名；
- `description`：Skill 做什么，以及 Agent 应在何时使用它。

可选标准字段包括 `license`、`compatibility`、`metadata` 和实验性的 `allowed-tools`。不同客户端对 `allowed-tools` 的支持并不一致，因此不得把它当作可移植的授权边界。

示例：

```markdown
---
name: report-automation
description: Use when creating, validating, or updating structured business reports from source data. Do not use for slide decks, spreadsheets, or general prose editing.
license: Apache-2.0
compatibility: Requires the reportctl CLI and local filesystem access.
metadata:
  author: example-org
  version: "1.0.0"
---
```

### 3.3 Description 是路由表

Description 是运行时路由元数据，不是营销标语。它必须写清：

1. Skill 负责的用户结果；
2. 可识别的任务语言或产物类型；
3. 重要排除项，以及不属于它的相邻 Skill；
4. 仅在影响激活时写明环境约束。

Description 应至少针对以下输入做测试：

- 必须激活的正向 Prompt；
- 不得激活的近邻负向 Prompt；
- 没有提到产品或格式名称、但表达相同意图的 Prompt；
- Agent 应先检查或询问再选择的模糊 Prompt。

重命名 Skill 或扩大 Description，会改变所有已安装 Workspace 的路由。应把这类变化视为兼容性变化，而不是普通文案调整。

### 3.4 渐进式披露

Skill 必须按三级加载设计：

1. **目录层：** Session 启动时只提供名称和 Description。
2. **指令层：** Skill 激活后才加载完整 `SKILL.md` 正文。
3. **资源层：** 仅在需要时加载脚本、参考资料和资产。

主 `SKILL.md` 应聚焦每次匹配任务都需要的核心指令。Agent Skills 规范建议少于 5,000 Token 和 500 行。详细内容应移入聚焦且被直接引用的文件。

每份参考资料都要有明确加载条件。推荐：

```markdown
Read `references/troubleshooting.md` when installation or verification returns
a non-zero exit status.
```

不要笼统要求读取整个参考资料目录。

## 4. 设计公开入口

### 4.1 稳定地址

产品可以发布一个稳定的 HTTPS 地址，例如：

```text
https://example.com/SKILL.md
```

该地址应该：

- 足够简短，便于在 README、聊天、Issue 或产品界面分享；
- 以纯文本形式提供，无需登录即可检查；
- 对应公开源码位置或有文档化的来源链路；
- 跨版本保持稳定，并在安装前展示最终解析的版本；
- 使用 TLS，并由正常的域名和发布控制保护。

稳定但可变的 URL 可以作为发现指针，但安装时应解析到不可变的 Release、Tag、Commit、内容哈希或签名产物，确保检查内容和执行内容一致。

### 4.2 面向用户的指令

更安全的一行入口是意图声明，而不是静默执行：

```text
阅读 https://example.com/SKILL.md。先告诉我来源、版本、将修改的文件、
联网目标和所需权限；全局修改前征得我的同意，然后安装并验证。
```

如果文档展示 `curl https://example.com/SKILL.md`，必须说明该命令只是在获取指令，并不会让这些指令自动变得可信。Agent 仍需检查来源并为后续操作取得授权。

### 4.3 人工安装后备路径

每个 Agent-first 安装入口必须提供人类可读的替代方案，覆盖：

- 支持的平台和前置条件；
- 手工下载或包管理器安装；
- 目标路径和配置变化；
- 验证；
- 更新、回滚和卸载。

Agent-first 入口降低的是接入成本，不能替代可审计的人类文档。

## 5. 规定安装契约

安装是一项状态迁移，而不是一串 Shell 命令。Installer 或执行安装的 Agent 必须遵循以下顺序。

### 5.1 Preflight

修改状态前：

1. 检测操作系统和 CPU 架构。
2. 检测目标 Agent 客户端及其支持的安装 Scope。
3. 检测现有安装的来源、版本和所有权模式。
4. 检查所需命令、Runtime、网络、凭证和文件权限。
5. 识别与现有 Skill 或 Binary 的冲突。
6. 缺少硬前置条件时，以可操作诊断停止。

所有检测都必须是只读的。

### 5.2 变更计划与同意

发生实质性修改前，应展示：

- 来源和最终解析的版本；
- 将新建、替换或删除的文件与目录；
- 涉及的 Binary、Package、Service、Hook 或 MCP Registration；
- 网络目标；
- 所需权限级别；
- 是否自动更新；
- 回滚和卸载路径。

以下操作必须先取得用户明确同意：

- 管理员或提权操作；
- 全局 Package 安装；
- 修改 Shell Profile 或系统启动项；
- 注册后台服务；
- 保存凭证；
- 启用自动更新；
- 破坏性替换非托管安装。

用户已经要求的项目内写入，可以沿用宿主 Agent 的常规 Workspace 权限模型。

### 5.3 产物解析与验证

分发平面应该：

1. 从获准 Channel 解析版本。
2. 下载到临时位置。
3. 使用独立发布记录中的 Checksum 或签名验证。
4. 检查或校验 Package 结构。
5. 平台允许时，将已验证 Payload 原子移动到目标位置。

不得依赖未固定的分支完成可复现安装。如果 Checksum 和 Artifact 能通过同一条未保护路径一起被静默替换，则该 Checksum 不能构成可靠验证。

### 5.4 幂等与所有权

使用相同来源、版本、Scope 和配置重复运行安装，必须到达相同状态，且不得重复创建文件、Hook、Registration 或 Service。

托管 Installer 必须记录足够状态，以区分：

- 它拥有并可 Reconcile 的文件；
- 必须保留的用户文件或 Fork 文件；
- 已安装来源和版本；
- 它创建的 Registration 和 Service；
- 可以清理的退役 Payload。

未展示冲突并取得明确替换决定前，Installer 不得覆盖已修改或来源未知的安装。

### 5.5 安装后验证

验证通过前，安装不算完成。验证应包括：

- 版本或身份检查；
- 从目标 Agent Scope 发现 Skill；
- 一次只读 Help 或能力查询；
- 执行平面的最小 Smoke Test；
- 检查 Registration、路径或托管状态；
- 清晰的最终总结。

验证失败时，工作流必须说明哪些状态已改变、哪些已回滚、哪些仍然保留，以及最安全的恢复命令或操作。

## 6. 让执行接口适合 Agent

低摩擦入口无法补偿一个迫使 Agent 猜测的执行接口。

### 6.1 Help 与发现

CLI 和工具应该提供：

- 每一级命令的 `--help`；
- 永不启动服务或修改状态的只读 Help；
- 使用合法属性名和值格式的示例；
- 当接口较大时提供机器可读的 Schema 或能力发现；
- 检查当前配置和 Registration 的 Inspect 命令。

Skill 必须要求 Agent 查询 Help，而不是自行发明语法。

### 6.2 结构化输入输出

确定性接口应该接收结构化输入并返回结构化输出。支持 `--json` 的 CLI 应保持响应结构稳定并加以说明。

错误应该包含：

- 稳定错误码；
- 人类可读解释；
- 失败字段、路径或操作；
- 已知时给出合法范围或替代项；
- 建议的下一步检查；
- 失败时使用非零进程退出码。

不要要求 Agent 从装饰性终端输出中抓取文本来判断正确性。

### 6.3 安全操作阶梯

复杂或破坏性工作应暴露类似的递进流程：

```text
检查 -> 计划或 Dry Run -> 修改 -> 验证 -> 渲染或复查 -> 提交
```

Skill 应引导 Agent 使用能完成任务的最小权限操作。只有高层操作无法满足请求时，才下沉到更低层 API、原始格式或破坏性参数。

### 6.4 验证闭环

每个产物生成工作流都应该包含适合该领域的反馈闭环：

```text
创建或编辑 -> 验证 -> 检查结果 -> 修正 -> 再次验证
```

验证可以是结构、语义、视觉或远程状态检查。关键是 Agent 可以观察工作是否成功，而不是只依赖“没有抛异常”。

## 7. 建立安全边界

远程 Skill 分发同时涉及指令加载、软件供应链、工具执行和模型行为，应把它视为高权限扩展入口。

### 7.1 威胁模型

至少评审以下威胁：

| 威胁 | 示例 | 必要应对 |
| --- | --- | --- |
| 指令注入 | 新克隆仓库中的 Skill 静默要求无关操作 | 要求 Workspace Trust，并从目录中排除不可信 Skill。 |
| 可变入口漂移 | 稳定 URL 在检查和安装之间发生变化 | 解析并展示不可变版本或哈希。 |
| 产物被入侵 | Installer 或 Binary 与已评审 Release 不一致 | 验证签名或 Checksum，失败时关闭流程。 |
| 名称遮蔽 | Project Skill 覆盖可信 User Skill | 使用确定性优先级并展示冲突。 |
| 权限提升 | 指令要求 `sudo`、启动 Hook 或全局写入 | 解释后果并取得明确同意。 |
| 凭证泄露 | 脚本打印 Token 或发送到未声明 Host | 使用最小权限凭证、脱敏输出并限制目标。 |
| 持久执行 | 安装注册 Daemon 或 Hook | 预先声明、提供状态检查并支持删除。 |
| 不安全自动更新 | 新指令未经审查直接执行 | 显示更新策略并支持固定版本和回滚。 |

### 7.2 信任规则

- 不可信 Workspace 中的仓库级 Skill 不得自动加载。
- 下载 Markdown 不得被视为已经授权执行其中命令。
- Skill 元数据中的 Tool Allowlist 不得替代宿主权限或用户同意。
- Installer 必须使用最小权限，且应优先使用项目级或用户级 Scope，而非系统级 Scope。
- 示例、命令历史、日志和生成文件不得包含 Secret。
- 安装或首次使用前应枚举网络目标。
- 来源、签名或 Checksum 验证失败时必须 Fail Closed。

### 7.3 `curl | shell` 策略

把可变网络响应直接流入 Shell，会把下载、检查、验证和执行压缩成一步。项目应该优先采用：

```text
下载 -> 检查来源 -> 验证 Digest 或签名 -> 执行
```

如果项目仍提供流式 Installer，则必须：

- 使用受控域名上的 HTTPS；
- 发布等价的手工安装路径；
- 记录所有持久修改；
- 尽量不要求提权；
- 自行验证实际安装产物；
- 下载或验证失败时停止；
- 提供固定版本的替代方式；
- 记录卸载和回滚方式。

## 8. 定义 Scope、优先级与组合

### 8.1 安装 Scope

常见 Scope 包括：

| Scope | 用途 | 常见优先级 |
| --- | --- | --- |
| Project | 仓库特定行为和约定 | 最高 |
| User | 跨个人项目可用的能力 | 低于 Project |
| Organization | 团队集中分发的能力 | 由 Runtime 定义 |
| Built-in | Agent 客户端随附能力 | 由 Runtime 定义 |

Agent Skills 格式定义 Skill 内容，并不定义通用文件路径或优先级算法。每个客户端或 Installer 都必须记录扫描目录和优先级。发生冲突时，必须输出诊断，指出两个来源和最终选择结果。

### 8.2 组合

应优先设计 Description 不重叠的独立 Skill。能力必须组合时：

- 明确一个 Router 或入口 Skill；
- 列出专业 Skill 及其激活条件；
- 声明所需执行依赖；
- 避免同时加载指令冲突的多个 Skill；
- 规定规则在单轮、单个 Artifact 还是整个 Session 内持续；
- 测试组合后的上下文成本和行为。

不得只在示例中隐藏强制依赖。如果分发层不支持依赖解析，Bundle Installer 必须校验并安装完整依赖集合。

## 9. 覆盖完整生命周期

### 9.1 唯一真源

每个分发 Skill 都必须有一个权威来源。生成的 Mirror 必须标记源版本。除非 Installer 明确提供 Fork 模式，否则 Runtime 安装副本不得变成需要用户编辑的独立真源。

### 9.2 Managed 与 Forked 模式

项目可以同时支持两种模式，但必须清楚区分：

- **Managed 模式：** 只读或 Reconcile 安装，跟随发布更新，并保持已知来源关系。
- **Forked 模式：** 复制到项目供本地修改，不再默认与上游一致，且永不被自动覆盖。

产品应该在安装时让用户明确选择。

### 9.3 版本与 Channel

分发平面应该提供：

- 不可变 Release 版本；
- 可见的 Source Commit 或 Artifact Digest；
- 需要时提供 Stable、Preview 或 Development Channel；
- Agent 客户端和执行依赖的兼容要求；
- 路由、权限和持久状态变化的迁移说明。

Description、Scope、默认权限、安装路径、依赖或清理行为的变化，即使领域任务没有改变，也可能是破坏性变化。

### 9.4 更新与回滚

更新前应展示当前版本和目标版本，以及权限、依赖、文件、Registration 和行为的变化。更新必须幂等，并保护用户拥有的文件。

回滚必须恢复完整兼容集合：Skill Payload、执行依赖、Provider 元数据、Registration 和托管状态。只回滚 `SKILL.md`、却保留不兼容 Binary，不属于有效回滚。

### 9.5 卸载与退役

卸载必须删除该安装拥有的所有资源，包括：

- Skill Payload 和 Provider Mirror；
- 仅为该能力安装的 Binary 或 Package；
- MCP Registration、Hook、启动项或后台服务；
- 可安全删除的生成配置；
- 托管状态记录。

除非用户明确要求，必须保留用户数据和已修改文件。

托管 Runtime 应在 Session Bootstrap 或其他已记录的生命周期点 Reconcile 期望状态，避免退役 Skill 长期累积。用户仍调用旧名称时，退役过程应提供迁移或替代提示。

## 10. 发布前验证

验证包含四层。

### 10.1 静态验证

用确定性检查覆盖：

- Agent Skills Frontmatter 和目录命名；
- Markdown 链接及被引用文件是否存在；
- 脚本、Schema、Plugin Manifest 和 Provider 元数据；
- 意外 Secret 和不安全示例值；
- 分发产物间版本一致性；
- Release Payload 中不存在占位指令。

可行时使用官方 `skills-ref` Validator 验证可移植格式。项目特定 Validator 可以增加更严格规则，但不得声称这些规则属于开放格式。

### 10.2 路由评测

维护一个小型路由测试集，包含：

- 必须命中的正向 Prompt；
- 不应命中的近邻负向 Prompt；
- 隐式意图 Prompt；
- 冲突或多 Skill Prompt；
- 应要求澄清的 Prompt。

常规 CI 运行确定性元数据检查。Description、Skill 清单、Runtime Catalog 或激活指令变化时，运行真实模型路由测试。记录所用模型和客户端，保证结果可比较。

### 10.3 安装矩阵

在干净隔离环境中，覆盖支持的操作系统、CPU 架构、Agent 客户端和安装 Scope。每个矩阵行都应测试：

1. 全新安装；
2. 重复安装；
3. 升级；
4. 验证失败；
5. 回滚；
6. 卸载；
7. 卸载后重装。

测试必须使用一次性凭证和隔离的 Home/Config 目录。

### 10.4 执行质量

确定性行为应放在产品测试中。模型判断测试适合验证路由、指令遵循、Artifact 质量和跨界面流程，但应该保持为独立、可观察的测试层，并显式配置成本和 Provider。

### 10.5 发布门槛

所有适用项都满足后，版本才可发布：

- [ ] 已选择并记录正确交付形态。
- [ ] `name` 和 `description` 通过格式与路由测试。
- [ ] 干净环境可以得到第一个有效结果。
- [ ] 重复安装是幂等的。
- [ ] 使用前披露实质性权限和持久修改。
- [ ] 已验证 Artifact 来源与完整性。
- [ ] Help 和错误输出支持自恢复。
- [ ] 主工作流包含可观察验证。
- [ ] 已记录版本固定和更新行为。
- [ ] 回滚能恢复兼容集合。
- [ ] 卸载能删除所有权状态并保留用户数据。
- [ ] 托管退役能删除废弃 Payload。
- [ ] 人类文档和 Agent 指令描述相同行为。

## 11. 衡量分发体验

应衡量能揭示摩擦和风险的指标，而不只是下载量：

- 从使用入口到第一个验证成功结果的时间；
- 按平台和 Agent 客户端划分的干净安装成功率；
- 需要人工恢复的安装比例；
- 路由精确率和漏激活率；
- 目录层和激活层的上下文成本；
- 验证失败分类；
- 更新和回滚成功率；
- 卸载完整度；
- 名称冲突和权限提升频率；
- 安装 Payload 与声明来源之间的漂移。

不要为了增加激活次数而牺牲路由精度。一个广泛但错误激活的 Skill 会增加上下文成本，并可能在其授权范围之外改变 Agent 行为。

## 12. 在新项目中应用本手册

每个新能力都使用以下顺序。

### 第一步：编写能力简报

记录：

- 目标用户和 Agent；
- 用户问题与期望结果；
- 代表性 Prompt 和 Artifact；
- 所需确定性操作；
- 外部系统、凭证和持久状态；
- 非目标和相邻能力。

### 第二步：选择交付形态

选择 Skill-only、Skill 加执行平面或 Bundle，并记录为什么更简单的一档无法满足要求。

### 第三步：先定义路由，再写指令

起草名称、Description、正向 Prompt 和负向 Prompt。写正文前先解决与现有 Skill 的重叠。

### 第四步：设计安装与信任

定义来源、Scope、版本、Preflight、权限、Artifact 验证、托管所有权、更新、回滚和卸载。

### 第五步：设计执行契约

规定命令或 Tool、结构化输入输出、Help、稳定错误、Inspect、Dry Run 和验证。

### 第六步：按渐进披露编写

核心流程放在 `SKILL.md`。详细参考资料、Schema、模板和可复用确定性代码进入各自目录。

### 第七步：建立测试层

增加静态验证、路由用例、干净安装生命周期覆盖、产品测试，以及必要的可选模型质量评测。

### 第八步：发布并观察

发布不可变版本，让稳定入口指向该版本，记录来源，监控失败，并把反复出现的恢复知识回写到 Help、诊断、测试或 Skill。

## 13. 常见反模式

### 把 `SKILL.md` 写成巨型手册

**失败表现：** 每次激活都加载与当前任务无关的参考资料。

**修正：** 主流程保持聚焦，按明确条件加载参考资料。

### 把 Description 写成营销文案

**失败表现：** Agent 无法判断何时激活。

**修正：** 写清负责结果、任务语言、Artifact 和排除项。

### 把 Markdown 当成安全例外

**失败表现：** 远程指令被视为无害，但它们能触发 Tool 执行。

**修正：** 执行命令前应用来源、信任、权限和最小权限规则。

### 只有安装、没有生命周期

**失败表现：** 项目没有所有权记录、安全升级、回滚或卸载。

**修正：** 发布第一个 Installer 前设计所有生命周期迁移。

### 用自然语言承担确定性工作

**失败表现：** 模型反复重新实现解析、修改或验证，结果不一致。

**修正：** 把可重复机械操作移入脚本、CLI、MCP 或 API。

### 隐藏依赖

**失败表现：** 只有另一个 Skill 或 Tool 恰好已安装时才能工作。

**修正：** 在分发平面声明并验证完整依赖集。

### Scope 冲突静默发生

**失败表现：** Project Skill 无提示地覆盖可信 User Skill。

**修正：** 使用确定性优先级并展示两个来源。

### 可变自动更新且不可回滚

**失败表现：** 新指令或 Binary 在没有可恢复版本边界时到达用户。

**修正：** 发布不可变版本，公开更新策略，并保存兼容回滚集合。

## 14. 可复制的编写模板

完成交付形态、安装契约和执行接口设计后，再使用本模板。

```markdown
---
name: capability-name
description: Use when the user needs [owned outcomes] involving [recognizable artifacts or task language]. Do not use for [neighboring tasks owned elsewhere].
license: Apache-2.0
compatibility: Requires [runtime, command, network, or platform constraint].
metadata:
  author: organization-name
  version: "1.0.0"
---

# Capability Name

State the concrete outcome this skill owns in one paragraph.

## Preconditions

1. Inspect whether the required execution dependency is installed.
2. Inspect the current version and configuration without changing state.
3. If a prerequisite is missing, follow the installation section before work.

## Installation

1. Show the source, resolved version, destination paths, network access, and
   permissions.
2. Obtain consent for global, elevated, persistent, or credential changes.
3. Install the verified, pinned artifact through the documented distribution
   path.
4. Run the version check and read-only smoke test.
5. Stop and report residual state if verification fails.

## Operating procedure

1. Inspect the target and current state.
2. Select the least powerful operation that can produce the requested result.
3. Use structured input and request structured output when available.
4. Perform the operation.
5. Run domain validation and inspect the produced result.
6. Correct validation failures and validate again.

## Help and recovery

- Read `references/command-reference.md` before inventing command syntax.
- Read `references/troubleshooting.md` after a non-zero exit status or failed
  verification.
- Preserve the original artifact until validation succeeds.

## Update and removal

- Show the current and target versions before update.
- Preserve user-owned data and modified files.
- Verify the complete compatible set after update or rollback.
- Use the documented uninstaller to remove owned payloads, registrations,
  hooks, services, and managed-state entries.
```

发布前必须替换所有方括号编写字段。Release Validator 应在分发 Payload 中仍存在这些字段时失败。

## 15. 来源说明

本手册综合了开放 Agent Skills 格式中的事实，以及生产导向 Skill 仓库中的工程模式。两者必须区分：

- Agent Skills 规范定义可移植 Skill 目录、Frontmatter 和渐进披露模型。
- Client 实现指南描述常见发现 Scope、优先级、激活和 Workspace Trust。
- OfficeCLI 展示稳定 Skill URL 如何成为 Agent-facing 产品入口，并由确定性 CLI、Help、结构化输出、验证和专业路由支撑。
- `mattpocock/skills` 展示可编辑复制集和托管 Plugin 订阅的产品差异。
- Google Stitch Skills 展示如何把开放格式 Skill 打包成相关 Plugin Bundle。

本文中的能力平面、分发平面、安全、生命周期和发布门槛，是从这些来源提炼出的工程指导，并不全部属于 Agent Skills 开放规范的要求。

本版本评审时固定的来源：

- [Agent Skills 规范](https://github.com/agentskills/agentskills/blob/38a2ff82958afee88dadf4831509e6f7e9d8ef4e/docs/specification.mdx)
- [Agent Skills Client 实现指南](https://github.com/agentskills/agentskills/blob/38a2ff82958afee88dadf4831509e6f7e9d8ef4e/docs/client-implementation/adding-skills-support.mdx)
- [优化 Skill Description](https://github.com/agentskills/agentskills/blob/38a2ff82958afee88dadf4831509e6f7e9d8ef4e/docs/skill-creation/optimizing-descriptions.mdx)
- [Agent Skills 编写最佳实践](https://github.com/agentskills/agentskills/blob/38a2ff82958afee88dadf4831509e6f7e9d8ef4e/docs/skill-creation/best-practices.mdx)
- [OfficeCLI README](https://github.com/iOfficeAI/OfficeCLI/blob/4ba79f0b984e141f57f58d4398ba2df29e8187e8/README.md)
- [OfficeCLI `SKILL.md`](https://github.com/iOfficeAI/OfficeCLI/blob/4ba79f0b984e141f57f58d4398ba2df29e8187e8/SKILL.md)
- [`mattpocock/skills` README](https://github.com/mattpocock/skills/blob/c70cb091933617c61acf9bd6c3b01c1140329cf1/README.md)
- [`mattpocock/skills` Plugin ADR](https://github.com/mattpocock/skills/blob/c70cb091933617c61acf9bd6c3b01c1140329cf1/.agents/adr/0002-ship-as-a-claude-code-plugin.md)
- [Google Stitch Skills README](https://github.com/google-labs-code/stitch-skills/blob/ad4b8bc8c51991f53214b573c98eb4f46807e178/README.md)
- [Google Stitch Design Plugin Manifest](https://github.com/google-labs-code/stitch-skills/blob/ad4b8bc8c51991f53214b573c98eb4f46807e178/plugins/stitch-design/plugin.json)
