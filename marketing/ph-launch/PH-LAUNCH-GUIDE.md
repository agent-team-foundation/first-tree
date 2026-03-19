# Context Tree - Product Hunt 打榜前四周准备指南

> **目标**: 在 Product Hunt 上成功发布 Context Tree，冲击 AI Agent 类目 Top 5

---

## 产品定位

### Tagline (≤60字符)
```
Context Tree: AI Agent 团队的持久记忆，92%+ 检索准确率
```

### 核心价值主张
| 传统方案 | Context Tree 方案 |
|---------|------------------|
| 向量数据库 (RAG) | 文件级 Context Tree |
| ~60% 检索准确率 | **92%+ 检索准确率** |
| Agent 无记忆 | **持久化 Team Memory** |
| 单 Agent 工作 | **多 Agent 协作同步** |

---

## 第一周：产品页面准备

### 1.1 Landing Page 必备元素

#### Hero Section
```
┌─────────────────────────────────────────────────────┐
│  Context Tree                                       │
│  AI Agent 团队的记忆基础设施                          │
│                                                     │
│  [Watch Demo]  [Get Started Free]                  │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │                                             │   │
│  │     🎬 Demo GIF / 截图                      │   │
│  │     展示 Agent Team 协作流程                │   │
│  │                                             │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

#### 资产清单
| 资产类型 | 规格要求 | 用途 |
|---------|---------|------|
| Demo 视频 | 1-2分钟, 1080p | 展示完整工作流 |
| GIF 动图 | <5MB, 800x600 | 首屏展示 |
| 高清截图 | 2-3张, PNG | 功能详情页 |
| 架构图 | SVG/PNG | 技术说明 |

### 1.2 Demo 视频脚本 (90秒)

```
[0:00-0:10] 问题引入
"你的 AI Agent 总是忘记之前的对话吗？
 多个 Agent 之间上下文混乱？"

[0:10-0:30] 解决方案
"Context Tree 为 Agent Team 提供持久化记忆。
 不是向量数据库，而是文件级的 Context Tree。"

[0:30-0:60] 核心功能演示
- brv pull: 同步团队上下文
- Agentic Search: 精准检索 (显示 92% 准确率)
- 多 Agent 协作: Agent A 写代码 → Agent B 审查

[0:60-0:80] 真实场景
"看，一个 Agent Team 如何共享 Context Tree
 完成复杂的代码重构任务"

[0:80-0:90] CTA
"Context Tree - 让你的 Agent Team 拥有团队记忆。
 立即体验 context-tree.dev"
```

### 1.3 Maker 故事模板

```markdown
## 为什么我们构建 Context Tree？

**背景**: 我们在开发 AI Agent 时遇到了一个痛苦的问题 —
Agent 每次对话都像"失忆"一样，多 Agent 协作更是混乱。

**发现**:
- 向量数据库 (RAG) 检索准确率只有 ~60%
- Agent 无法记住 10 轮对话前的决策
- 多 Agent 之间上下文不同步

**解决方案**: Context Tree
- 文件级结构化存储 (不是向量)
- 92%+ 检索准确率 (实测数据)
- 类似 Git 的团队同步机制

**结果**: 现在 Agent Team 可以像人类团队一样协作了。

我们相信：**没有记忆的 Agent，就像没有硬盘的电脑。**
```

---

## 第二周：社区建设

### 2.1 目标受众

| 平台 | 目标粉丝数 | 关键动作 |
|------|-----------|---------|
| Twitter/X | 150+ | 分享 Agent 开发心得 |
| Discord | 100+ | 建立开发者社区 |
| Reddit (r/MachineLearning) | - | 发技术深度帖 |
| 中文 AI 群 | 150+ | 早期用户反馈 |

### 2.2 内容日历模板

| Day | 平台 | 内容类型 |
|-----|------|---------|
| Mon | Twitter | 技术洞察: "为什么 RAG 不够用" |
| Tue | Discord | 开发日志: 本周功能更新 |
| Wed | Reddit | 深度文章: Context Tree 原理 |
| Thu | Twitter | 用户案例: 某团队使用故事 |
| Fri | 中文群 | 答疑: Agent 记忆问题 |

### 2.3 PH 预热动作

**每日任务** (建立信誉):
```bash
# 每天执行
1. Upvote 5-10 个 AI Agent 产品
2. 评论 3-5 个相关产品 (真诚反馈)
3. 关注 5 个 AI 领域的 Hunter/Maker
```

**为什么重要**:
- PH 算法偏好老用户的 upvote
- 建立你的 Maker 身份
- 了解竞品的优缺点

---

## 第三周：资产准备

### 3.1 Maker Comment (置顶评论)

```markdown
👋 Hi Product Hunt! 我是 [Name]，Context Tree 的 Maker。

**为什么做这个？**
我们团队在开发 AI Agent 时发现一个痛点：
Agent 总是"忘记"之前的对话，多 Agent 协作更是混乱。
现有方案（向量数据库）检索准确率只有 60%。

**Context Tree 的不同**:
📁 文件级结构存储（不是向量）
🎯 92%+ 检索准确率（实测数据）
🔄 类 Git 的团队同步（brv pull）
🤝 原生多 Agent 协作支持

**适合谁用？**
- 正在构建 AI Agent 的开发者
- 需要多 Agent 协作的团队
- 对 RAG 准确率不满意的项目

免费试用，欢迎反馈！
```

### 3.2 邮件模板 (预热)

**发送时间**: Launch 前 3 周

```
Subject: 我们正在构建 Agent Team 的"大脑皮层"

Hi [Name],

我们团队最近在做一个有趣的项目 - Context Tree。

简单说：它让 AI Agent 拥有持久记忆，
而且支持多 Agent 之间的上下文同步。

核心数据：
- 92%+ 检索准确率（对比向量库 ~60%）
- 文件级存储，可追溯可回滚

我们计划在 [Date] 在 Product Hunt 发布。
如果你对 AI Agent 开发感兴趣，
欢迎提前试用并给我们反馈 👇

[试用链接]

（不会求 upvote，但真诚希望听到你的建议）

Best,
[Your Name]
```

### 3.3 PH Teaser 页面

**创建步骤**:
1. 登录 Product Hunt
2. 进入 Creator Studio
3. 创建 "Coming Soon" 页面
4. 填写:
   - Product Name: Context Tree
   - Tagline: AI Agent 团队的持久记忆
   - Thumbnail: 产品 Logo
   - Launch Date: [设定日期]

---

## 第四周：Launch Day

### 4.1 时间选择

| 时区 | 时间 | 原因 |
|------|------|------|
| PST | 12:01 AM | PH 每日重置时间 |
| UTC | 08:01 AM | 欧洲用户活跃 |
| 北京 | 4:01 PM | 国内支持者方便 |

### 4.2 Launch Day Checklist

```markdown
## 发射当天 00:00 PST

### 立即执行
- [ ] 产品正式上线
- [ ] 发布 Maker Comment (置顶)
- [ ] 发送邮件通知订阅者 (不含"求upvote")
- [ ] 社交媒体同步发布

### 持续动作 (0-12小时)
- [ ] 每小时回复一次评论
- [ ] 感谢每个 upvote 和评论
- [ ] 更新社交动态 (不刷屏)

### 支持者提醒
- [ ] 2-3 位早期支持者自然评论
- [ ] 注意: 不要群发"请upvote"消息
```

### 4.3 应急预案

| 问题 | 应对 |
|------|------|
| 竞品同日发布 | 专注差异化，不直接对比 |
| 负面评论 | 真诚回复，承认不足 |
| 流量激增 | 提前扩容服务器 |
| 技术问题 | 准备降级方案 |

---

## AI Agent 产品专属 Tips

### 技术差异化

```markdown
## vs 向量数据库 (RAG)

| 维度 | 向量数据库 | Context Tree |
|------|-----------|--------------|
| 检索方式 | 语义相似度 | 结构化路径 |
| 准确率 | ~60% | 92%+ |
| 可解释性 | 黑盒 | 完全可追溯 |
| 团队协作 | 无 | 原生支持 (brv pull) |
```

### 展示策略

**必须展示**:
- ✅ 真实准确率数据
- ✅ 多 Agent 协作截图
- ✅ 完整工作流 Demo

**避免**:
- ❌ 过度承诺
- ❌ 贬低竞品
- ❌ 没有数据支撑的声明

---

## 附录

### A. 资产清单

```markdown
## 必备资产 (Launch 前 1 周完成)

### 视觉资产
- [ ] 产品 Logo (SVG + PNG)
- [ ] Demo 视频 (1-2 min, 1080p)
- [ ] GIF 动图 (<5MB)
- [ ] 高清截图 (3-5 张)
- [ ] 架构图 (SVG)

### 文案资产
- [ ] Tagline (≤60 字符)
- [ ] 产品描述 (≤260 字符)
- [ ] Maker Comment (≤500 字符)
- [ ] 邮件模板
- [ ] 社交文案

### 技术资产
- [ ] Landing Page 上线
- [ ] Demo 环境稳定
- [ ] 文档完善
```

### B. 关键指标

| 指标 | 目标值 |
|------|-------|
| Launch 日排名 | Top 5 |
| Upvotes | 500+ |
| 评论数 | 100+ |
| 新用户注册 | 1000+ |
| 社区新增 | 200+ |

### C. 参考资料

- [Product Hunt 官方指南](https://producthunt.com/help)
- [成功案例分析: ByteRover](https://producthunt.com/products/byterover)

---

> 📝 **最后更新**: 2026-03-17
>
> 💡 **提示**: 本文档应在 Launch 后复盘更新
