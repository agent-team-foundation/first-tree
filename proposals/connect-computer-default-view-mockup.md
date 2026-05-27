# Settings → Computers 默认视图 · 示意图

配套 proposals/connect-computer-optimization.md 的 P0-3 IA 重组。

布局核心原则：

- **单台机器 = 详情卡片**（不是表格）
- **顶部一句话状态描述**（不是 chip 数字堆，也不是抽象的"健康度"）
- **状态用 4 个明确的 pill 来表达**，每个都从现有数据库字段直接派生
- **行动按钮跟着异常状态走**——出问题就在那里给入口，不藏在 kebab
- **"+ Add another" 永远在角落、低显眼度**

---

## 状态 pill 定义（4 种，互斥，按优先级判定）

**所有 pill 都用现有字段计算，不引入新的 server 字段、不引入阈值。**

| Pill | 触发条件 | 顶部一句话 | 含义 |
|---|---|---|---|
| 🟢 **Ready** | `status=connected` AND `authState=ok` AND 至少一个 `capabilities[*].state=ok` | "Your computer is ready" | 可以跑 agent |
| 🔴 **Auth expired** | `authState=expired` | "Your computer needs to log in again" | 需要重新 `first-tree login` |
| 🟡 **Setup incomplete** | `status=connected` AND `authState=ok` AND 所有 `capabilities[*].state ≠ ok` | "Finish setting up your computer" | 在线但没装好任何 runtime |
| ⚪ **Offline** | `status=disconnected` AND `authState=ok` | "Your computer is offline" | 暂时没在线，没过期 |

判定顺序（自上而下，命中即停）：
1. `authState=expired` → 🔴 Auth expired
2. `status=disconnected` → ⚪ Offline
3. `status=connected` 且所有 capability ≠ ok → 🟡 Setup incomplete
4. 其余 → 🟢 Ready

派生来源：
- `clients.status` — 服务端 register/disconnect/cleanupStaleClients 维护
- `deriveAuthState(row, refreshTTL)` — 服务端纯函数，已存在
- `clients.metadata.capabilities[*].state` — SDK 启动时探测上报

无需新阈值（心跳多久 stale、SDK 多旧 outdated 都不参与判定）。

---

## Variant A · 🟢 Ready（最高频）

> 用户机器正常运行，进来扫一眼就走

```
┌─────────────────────────────────────────────────────────────┐
│  Computer                                  [ + Add another ]│
│  ✓ Your computer is ready                                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ╭─ MacBook-Pro.local ──────────────── 🟢 Ready ─╮        │
│   │                                                │        │
│   │  Heartbeat       12 sec ago                    │        │
│   │  first-tree      v1.3.2                        │        │
│   │  OS              macOS 14.4                    │        │
│   │                                                │        │
│   │  Runtimes                                      │        │
│   │    ✓ Claude Code   v0.8.1 · authenticated      │        │
│   │    ⊘ Codex         not installed   [ Install ] │        │
│   │                                                │        │
│   │  Agents · 3 online                             │        │
│   │    ● code-reviewer       Online                │        │
│   │    ● design-reviewer     Online                │        │
│   │    ● support-bot         Online                │        │
│   │                                                │        │
│   │                          [ ⋯ More actions ]    │        │
│   ╰────────────────────────────────────────────────╯        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**说明**：
- 顶部 ✓ + "Your computer is ready" 是一句确认，让用户安心离开
- Heartbeat / first-tree version / OS / Runtimes / Agents 都是事实展示，**不参与 pill 判定**
- Codex 显示 "not installed" 但**不算问题**（只要 Claude Code 是 ok，pill 就是 Ready）
- Codex 行末有低显眼度的 `[ Install ]` 按钮——给想"加一个 runtime"的用户一个不打眼的入口；点击展开命令复制框
- "⋯ More actions" 收纳 Disconnect / Retire 等低频操作

---

## Variant B · 🔴 Auth expired（用户主动来排查最常见的一种）

```
┌─────────────────────────────────────────────────────────────┐
│  Computer                                  [ + Add another ]│
│  ⚠ Your computer needs to log in again                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ╭─ MacBook-Pro.local ─────────── 🔴 Auth expired ─╮      │
│   │                                                  │      │
│   │  This computer hasn't checked in for 8 days.     │      │
│   │  Your access token has expired.                  │      │
│   │                                                  │      │
│   │  To fix, run on MacBook-Pro.local:               │      │
│   │                                                  │      │
│   │    first-tree login <token>                      │      │
│   │              [ Generate new token ]              │      │
│   │                                                  │      │
│   │  ─────────────────────                           │      │
│   │  Heartbeat       8 days ago                      │      │
│   │  first-tree      v1.0.4                          │      │
│   │  Claude Code     ✓ authenticated (last reported) │      │
│   │  Agents · 3 offline                              │      │
│   ╰──────────────────────────────────────────────────╯      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**说明**：
- Card 头部 pill 即诊断，下面紧跟"为什么 + 怎么办"
- "Generate new token" 是行内按钮（点了在原位展开 token 文本 + 复制按钮）
- 旧的事实数据（heartbeat / first-tree version）放在下方分隔线后，作为补充
- Agents 显示离线影响范围，让用户理解修复后能恢复什么

---

## Variant B-2 · 🟡 Setup incomplete

```
┌─────────────────────────────────────────────────────────────────┐
│  Computer                                      [ + Add another ]│
│  ⚠ Finish setting up your computer                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ╭─ MacBook-Pro.local ──────── 🟡 Setup incomplete ─╮         │
│   │                                                    │         │
│   │  This computer is online, but no runtime is        │         │
│   │  ready. Install one of the following on this       │         │
│   │  computer to start running agents:                 │         │
│   │                                                    │         │
│   │  ┌─ Claude Code ────────────────────────┐          │         │
│   │  │  On MacBook-Pro.local, run:           │          │         │
│   │  │    npm install -g @anthropic-ai/      │          │         │
│   │  │      claude-code                      │          │         │
│   │  │    claude login                       │          │         │
│   │  │                       [ Copy commands ]│          │        │
│   │  └────────────────────────────────────────┘         │         │
│   │                                                    │         │
│   │  ┌─ Codex ────────────────────────────────┐        │         │
│   │  │  On MacBook-Pro.local, run:             │        │         │
│   │  │    npm install -g @openai/codex         │        │         │
│   │  │    codex login                          │        │         │
│   │  │                       [ Copy commands ] │        │         │
│   │  └─────────────────────────────────────────┘        │         │
│   │                                                    │         │
│   │  ─────────────────────                             │         │
│   │  Heartbeat       12 sec ago                        │         │
│   │  first-tree      v1.3.2                            │         │
│   │  Agents · 0                                        │         │
│   ╰────────────────────────────────────────────────────╯         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**说明**：
- **两个 runtime 对等展示**——不强推任意一个，用户按自己习惯/已有账号选
- 每个 runtime 一个独立 box，含安装 + 登录命令 + 复制按钮
- 全部 capability ⊘ 算严格的 "no runtime ready"——只要装好一个，pill 就跳到 Ready
- 如果其中一个状态是 `unauthenticated` 而不是 `missing`，对应 box 文案变为 "Claude Code is installed but not logged in" + 只显示 `claude login` 命令

---

## Variant B-3 · ⚪ Offline

```
┌─────────────────────────────────────────────────────────────┐
│  Computer                                  [ + Add another ]│
│  ⚠ Your computer is offline                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ╭─ MacBook-Pro.local ─────────────── ⚪ Offline ─╮        │
│   │                                                │        │
│   │  Last seen 2 hours ago.                        │        │
│   │  Make sure the machine is awake and connected. │        │
│   │                                                │        │
│   │  If the daemon isn't running, on MacBook-Pro:  │        │
│   │                                                │        │
│   │    first-tree daemon start                     │        │
│   │                                                │        │
│   │  ─────────────────────                         │        │
│   │  first-tree      v1.3.2                        │        │
│   │  Claude Code     ✓ authenticated (last reported)│       │
│   │  Agents · 3 offline                            │        │
│   ╰────────────────────────────────────────────────╯        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**说明**：
- Offline 跟 Auth expired 区别：Auth expired = 凭证已死、必须重新 login；Offline = 凭证还活着，只是这台机器没在跑
- 引导从轻到重：先确认机器是否开机、网络是否通 → 再考虑 daemon 重启

---

## Variant C · 双设备用户（15-25%）

> 两台机器并列，浓缩卡片

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Computers                                           [ + Add another ]  │
│  🟢 1 ready · ⚪ 1 offline                                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ╭─ MacBook-Pro ────── 🟢 Ready ─╮  ╭─ Mac-mini ────── ⚪ Offline ─╮ │
│   │  Heartbeat 12 sec               │  │  Last seen 2 hours ago        │ │
│   │  Claude Code ✓                  │  │  Claude Code ✓ (last reported)│ │
│   │  Agents 3 online                │  │  Agents 2 offline             │ │
│   │                                 │  │                               │ │
│   │  [ View details ]   [ ⋯ ]      │  │  [ Wake guide ]   [ ⋯ ]      │ │
│   ╰─────────────────────────────────╯  ╰───────────────────────────────╯ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**说明**：
- 顶部一句话拆分成 "N pill-name" 计数（比如 "1 ready · 1 offline"）
- 卡片是 Variant A/B 的浓缩版，主操作 + ⋯
- View details / 状态对应的恢复入口（Wake guide / Re-authenticate / Setup runtime）按 pill 显示
- **布局响应式**：视口宽（≥ 1024px）2-up 并列；窄屏（< 1024px）自动堆叠为单列卡片栈，每张卡片宽度 = 视口宽 - padding

---

## Variant D · Admin team view（admin 切到 team tab）

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Computers                                                              │
│  ⊙ Your computer 🟢 (active)   |   ⊙ Team computers (8)                 │
├─────────────────────────────────────────────────────────────────────────┤
│  Filter:  [ All ▾ ] [ With issues ▾ ] [ Sort by: state ▾ ]              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  🔴  Alice  · alice-MBP        Auth expired                             │
│       Heartbeat 8 days ago · Claude Code ✓ (last reported)              │
│       2 agents offline                                                  │
│       [ Copy suggestion → Alice ]   [ View details ]                    │
│  ─────────────────────────────────────────────────────────────────────  │
│  🟡  Bob    · bob-linux        Setup incomplete                         │
│       Heartbeat 15 sec ago · No runtime ready                           │
│       1 agent waiting                                                   │
│       [ Copy suggestion → Bob ]   [ View details ]                      │
│  ─────────────────────────────────────────────────────────────────────  │
│  ⚪  Eva    · eva-MBP          Offline                                  │
│       Last seen 4 hours ago · Claude Code ✓                             │
│       1 agent offline                                                   │
│       [ Copy suggestion → Eva ]   [ View details ]                      │
│  ─────────────────────────────────────────────────────────────────────  │
│  🟢  Cara   · cara-MBP         Ready                                    │
│       Heartbeat 8 sec ago · Claude Code ✓ · 4 agents online             │
│       [ View details ]                                                  │
│  ─────────────────────────────────────────────────────────────────────  │
│  ... (3 more ready, collapsed)                       [ Show all 8 ]    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**说明**：
- **默认 tab 是 "Your computer"**（更高频），admin 主动切到 "Team computers" 才进入支持模式
- **默认按 pill 优先级排序**：🔴 → 🟡 → ⚪ → 🟢，admin 不用扫，问题自然冒上来
- 每行一句话状态结论 + 当前事实（heartbeat、capability、agent 数）
- 健康的成员折叠 / 简化显示，节省视觉带宽

### "Copy suggestion" 消息模板

**产品提供按 pill 状态的固定模板，admin 点击后弹出可编辑预览**（保证消息质量基线，同时允许个性化润色）。

模板示例：

#### 🔴 Auth expired
```
Hi {member_name}, your computer "{hostname}" needs you to re-login.

On {hostname}, run:
  first-tree login <token>

Generate the token at https://{hub_host}/settings/computers
This will bring back {agent_count} agent(s): {agent_names}.
```

#### 🟡 Setup incomplete
```
Hi {member_name}, your computer "{hostname}" is online but needs a runtime installed.

On {hostname}, install at least one of:

  Claude Code:
    npm install -g @anthropic-ai/claude-code && claude login

  Codex:
    npm install -g @openai/codex && codex login

Once installed, {agent_count} agent(s) will come online: {agent_names}.
```

#### ⚪ Offline
```
Hi {member_name}, your computer "{hostname}" hasn't checked in for {duration}.

Please make sure the machine is awake and connected.
If the daemon isn't running, on {hostname} run:
  first-tree daemon start

{agent_count} agent(s) are currently offline: {agent_names}.
```

模板里的 `{...}` 占位符由前端按当前行数据填好，admin 在编辑预览里看到的就是最终文本——可以原样复制、也可以改完再复制。

---

## 跟当前实现的对比

| | 当前 | 提议 |
|---|---|---|
| 默认视图 | 表格（无论几台机器） | 单台→卡片、多台→卡片列表 |
| 顶部摘要 | "X total · Y connected · Z agents bound · W need re-auth" | 一句话状态描述（"Your computer is ready" 等） |
| 状态指示 | 多个 chip（status / authExpired 分散） | **一个 pill = 4 状态之一**（互斥优先级判定） |
| 心跳信号 | 显示 connectedAt | 显示 lastSeenAt |
| 版本字段名 | "SDK" | "first-tree" |
| 版本健康 | 字符串 v1.0.4 | 字符串 v1.0.4（不参与判定，仅展示） |
| Capability | 必须展开行才能看 | 主视图直接显示 |
| 操作入口 | kebab 菜单（Disconnect/Retire/Reconnect） | 状态化主行动（Generate new token / Wake guide / Setup runtime）+ ⋯ More |
| "+ Connect" 显眼度 | 页面顶部主按钮 | 角落次要按钮 |
| Admin team view | 表格 + 行不可展开 | 一句话诊断列表 + 一键复制建议 |
| Admin 排序 | 按 lastSeenAt | 按 pill 优先级（🔴→🟡→⚪→🟢） |

---

## Runtime 行为细则（横跨所有 variant）

| Runtime state | 在 Ready 卡片 | 在 Setup incomplete 卡片 | 在 Auth expired / Offline 卡片 |
|---|---|---|---|
| `ok` | ✓ Claude Code v0.8.1 · authenticated (method)，无 action | 不出现（既然有 ok，pill 就不是 Setup incomplete） | 标 "(last reported)" 不可操作 |
| `unauthenticated` | ⚠ installed v0.8.1, not authenticated · 行末有 [ Sign in ] 按钮 | 在 box 里独立展示，文案改成 "installed but not logged in"，只给 `claude login` 命令 | 不展示登录入口（机器没在线）|
| `missing` | ⊘ not installed · 行末有 [ Install ] 按钮（低显眼度） | 在 box 里独立展示，给完整 install + login 命令 | 不展示安装入口 |
| `error` | ❌ error: {message} · 文档链接 | 在 box 里独立展示 error 详情 + 文档链接 | 不展示 |

**error 状态处理（C 选项）**：
- 显示 capability.error 文字
- 加一个 troubleshooting 文档链接
- **不做** "Retry probe" / "Reinstall" 自动化按钮（留待后续）

---

## 已敲定（全部）

- 4 个 pill 名称：**Ready / Auth expired / Setup incomplete / Offline**（英文）
- Setup incomplete 严格定义：**所有 capability 都 ≠ ok 才触发**
- Agent 状态语言：**online / offline**（沿用线上 PresenceChip）
- 版本字段名：**first-tree**（替代 "SDK"）
- Ready 卡片：行末给 [ Install ] / [ Sign in ] 入口（低显眼）
- Setup incomplete 卡片：**Claude Code 与 Codex 对等展示**，用户自选
- Runtime error 状态：error message + 文档链接，不做 retry 按钮
- **多设备布局**：响应式（≥1024 2-up 并列，<1024 单列堆叠）
- **Admin 默认 tab**：Your computer（更高频）
- **Copy suggestion**：产品给按 pill 状态的固定模板，admin 点击后弹出可编辑预览

## 下一步

Mockup 设计部分已收尾，可以：

1. **转技术 spec**：交 @gandy-developer 基于本 mockup + proposals/connect-computer-optimization.md 出技术设计文档（含数据模型变更、API 变更、UI 组件拆分、迁移计划、测试覆盖）
2. **同步更新 proposal 主文档**：把 §5 P0-3/P0-4 里跟"健康"等含糊措辞对齐到本 mockup 的精确 pill 定义

@gandy2025 拍板要先做哪个、还是两个并行交付。
