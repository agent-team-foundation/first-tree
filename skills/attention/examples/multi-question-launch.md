# Multi-question — bundle related decisions into one NHA

When you have several **related** decisions all blocked on the same human, raise **one** NHA with `metadata.questions[]` instead of several parallel NHAs. The human answers all questions atomically (the UI submits them together); skip-rate stays low because the human sees the full picture at once.

Use sparingly. Rule of thumb: questions belong together iff (a) they're answered in the same head-state and (b) deferring some while acting on others is incoherent.

## CLI

```bash
first-tree attention raise \
  --chat product-launch-q3 \
  --target yuezengwu \
  --subject "下周一上线 checkout v2 — 3 个上线参数我没法自己定" \
  --body @body.md \
  --requires-response \
  --meta tags[0]=launch-decision \
  --meta timeoutHint=24h \
  --meta-json @questions.json
```

## body.md

```markdown
## 问题
checkout v2 准备下周一上线。回归测试都通过，但有 3 件事我没法自己定：

1. **流量切换节奏**（10% 灰度 vs 直接 100%）
2. **回滚阈值**（pn95 latency 高出多少触发自动回滚）
3. **客户公告时机**（上线前发 vs 上线后发）

每个问题底下我都列了选项和我的建议；如果你想自由表达，最后再"改用自由回复"一次。
```

## questions.json

```json
{
  "questions": [
    {
      "id": "rollout-pace",
      "prompt": "流量切换节奏",
      "context": "上一次类似改动用了 24h 灰度（10/50/100），这次回归更充分一些。",
      "options": {
        "mode": "single",
        "defaultValue": "gradual",
        "items": [
          { "value": "gradual",  "label": "10/50/100 三段灰度（24h）" },
          { "value": "fast",     "label": "10/100 两段（4h）" },
          { "value": "full",     "label": "直接 100%（不灰度）" }
        ]
      }
    },
    {
      "id": "rollback-threshold",
      "prompt": "自动回滚阈值（p95 latency 增量）",
      "options": {
        "mode": "single",
        "defaultValue": "p50",
        "items": [
          { "value": "p20", "label": "+20% 触发" },
          { "value": "p50", "label": "+50% 触发（默认）" },
          { "value": "off", "label": "本次不开自动回滚，人盯" }
        ]
      }
    },
    {
      "id": "announce",
      "prompt": "客户公告时机",
      "options": {
        "mode": "single",
        "items": [
          { "value": "before", "label": "上线前发（强调"准备一下"）" },
          { "value": "after",  "label": "上线后发（强调"已生效"）" },
          { "value": "skip",   "label": "不发，等周报一起带" }
        ]
      }
    }
  ],
  "fallback": "gradual + p50 + announce after — escalate to @baixiaohang if no reply in 24h",
  "validityScope": "this single launch window only"
}
```

## Notes

- 提交语义是**原子**的：UI 在 3 题都答完之前不允许提交。如果你想让人逐题答，拆成 3 个串行 NHA（前一个 closed 再发下一个），并接受人会"看到下一个时已经没耐性"的代价。
- `questions[*].id` 是返回 `answers` 时的 key。你的 handler 读到 `answers["rollout-pace"]` / `answers["rollback-threshold"]` / `answers["announce"]` 后再去执行。
- 不要让 `questions[]` 长到要分屏滚动 — 视觉成本会让人放弃读完。如果真的超 5 题，多半是任务还没被你切清楚。
- 不要混"决策"和"信息补全"在同一个 multi-question 里。`endorse + supply` 同发会让人困惑该用哪种心智答。
- `fallback` 在多题场景下写一个整体兜底（每题的兜底答案+整体策略），不要给每题分开写 fallback。
