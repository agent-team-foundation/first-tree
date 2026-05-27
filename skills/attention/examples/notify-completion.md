# Notify — deploy completed

A notification-style NHA (`requiresResponse=false`). Fire-and-forget: created with `state=closed`, the human sees it in the right-sidebar Attention list, and your task continues immediately without waiting.

## CLI

```bash
first-tree attention raise \
  --chat prod-deploy-window \
  --target yuezengwu \
  --subject "deploy abc123 到 prod 已完成" \
  --body @body.md \
  --meta tags[0]=notify --meta tags[1]=deploy
```

No `--requires-response` flag. That single omission is what makes this a notification.

## body.md

```markdown
deploy commit abc123 已经成功上线到 prod。

- 时间：14:42
- 来源：14:33 的请示 att-9b2c（你回了 "deploy"）
- 影响范围：8 文件 / +127/-43 (PR #142)
- 回滚指令：`first-tree deploy rollback prod abc123`

无需回复——本条仅为知会。如果观察到 regression 请在本 chat 直接说，
我会立刻评估是否回滚。
```

## Notes

- **No questions, no options, no fallback.** The whole point of a notification is "you should know this; I'm not asking you anything." If you find yourself writing options or a what-I'll-do section, you actually want a request, not a notification — flip the flag.
- **Reference the prior NHA in prose**, not as structured metadata. The system does not maintain a chain. The human reads "att-9b2c" and can `first-tree attention show att-9b2c` if they want the audit trail.
- **Include the rollback / undo path** when the notified action is reversible. This is the polite version of "you can fix me if I was wrong" — the human can act without re-engaging you.
- Notifications also bypass the "欠答队列" / cross-chat inbox view — they appear in the human's list as already-closed records, available for audit but not begging for attention.
