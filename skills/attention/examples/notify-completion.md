# Notify — deploy completed

A notification-style NHA (`requiresResponse=false`). Fire-and-forget: created with `state=closed`, the human sees it in the right-sidebar Attention list, and your task continues immediately without waiting.

## CLI

```bash
first-tree attention raise \
  --chat prod-deploy-window \
  --target yuezengwu \
  --subject "deploy abc123 to prod completed" \
  --body @body.md \
  --meta 'tags[0]=notify' --meta 'tags[1]=deploy'
```

No `--requires-response` flag. That single omission is what makes this a notification.

## body.md

```markdown
Commit abc123 has been successfully shipped to prod.

- Time: 14:42
- Triggered by: ask att-9b2c at 14:33 (you replied "deploy")
- Scope: 8 files / +127 / -43 (PR #142)
- Rollback: `first-tree deploy rollback prod abc123`

No reply needed — this is informational only. If you observe a regression,
say so in this chat and I'll evaluate whether to roll back.
```

## Notes

- **No questions, no options, no fallback.** The whole point of a notification is "you should know this; I'm not asking you anything." If you find yourself writing options or a what-I'll-do section, you actually want a request, not a notification — flip the flag.
- **Reference the prior NHA in prose**, not as structured metadata. The system does not maintain a chain. The human reads "att-9b2c" and can `first-tree attention show att-9b2c` if they want the audit trail.
- **Include the rollback / undo path** when the notified action is reversible. This is the polite version of "you can fix me if I was wrong" — the human can act without re-engaging you.
- Notifications bypass the "needs your reply" queue / cross-chat inbox view — they appear in the human's list as already-closed records, available for audit but not begging for attention.
