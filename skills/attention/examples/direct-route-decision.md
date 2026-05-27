# Direct — route a decision that's not your call

A request-style NHA used when the agent has discovered a fork in the road that **belongs to the human** (product trade-off, customer-facing tone, legal ambiguity, who-owns-what). The agent is **not** asking permission to do something it can do; it's reporting that the decision itself is out of scope.

## CLI

```bash
first-tree attention raise \
  --chat support-q4 \
  --target yuezengwu \
  --subject "客户要求退全款 + 道歉信，超我处理上限，请定决策" \
  --body @body.md \
  --requires-response \
  --meta tags[0]=direct \
  --meta tags[1]=customer-escalation \
  --meta timeoutHint=2h \
  --meta validityScope="this ticket only" \
  --meta-json @options.json
```

## body.md

```markdown
## 问题
TICKET-8821（VIP 客户）要求：(a) 退全款 $4,200，(b) CTO 签字的道歉信，(c) 公开发布 root cause 报告。
我的处理上限是 $500 + 模板道歉信，剩下两条都需要你定。

## 背景
- 故障是上周三 prod 数据库主从切换那次（已修，post-mortem 见 incident-2026-05-21.md）
- 客户损失：3 笔订单延迟 90min（已自动 refund）+ 1 笔订单错单（已人工 refund）
- 客户的态度截图我已转给你（见 chat 上一条）
- legal 同事 @baixiaohang 没在线，但他之前对"公开 root cause"的策略一向谨慎

## 我会怎么做
- 你回 "approve full"：我执行全部三条
- 你回 "partial"：你在自由回复里写明哪几条
- 你回 "escalate-legal"：我把案子转给 baixiaohang，关掉本 NHA，等他上线再发新的

## 这次决定的有效范围
仅本工单 TICKET-8821。不是"以后类似投诉都按这个走"。
```

## options.json

```json
{
  "options": {
    "mode": "single",
    "items": [
      { "value": "approve-full",   "label": "三条全做" },
      { "value": "partial",        "label": "部分做（请在自由回复里写明）" },
      { "value": "escalate-legal", "label": "转给 baixiaohang，等 legal 决策" }
    ]
  },
  "fallback": "escalate-legal",
  "validityScope": "TICKET-8821 only"
}
```

## Notes

- "Direct" 的关键是把**决策类型**说清楚：哪些是你能做的、哪些超你权限。不要假装请教，实质是要授权。
- `escalate` 是合法选项，但要在 body 里写清楚后续路径。让用户选 "escalate" 不能等于把决策权扔回去——你要明确"我会关掉这条 NHA + 怎么联系 legal"。
- 涉及金额、人事、法律、客户公开承诺这四类，几乎一定是 direct，不是 endorse / supply。
- timeoutHint 是给人看的，不是给系统兜底用的。这种紧迫场景必要时还会用 chat 普通 @mention 配合催。
