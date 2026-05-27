# Endorse — deploy approval

A request-style NHA that asks a named human to authorize a prod deploy. Demonstrates structured `options` so the UI can render one-click buttons, plus the implicit body sections (问题 / 背景 / 我会怎么做 / 有效范围).

## CLI

```bash
first-tree attention raise \
  --chat prod-deploy-window \
  --target yuezengwu \
  --subject "批准 deploy commit abc123 到 prod" \
  --body @body.md \
  --requires-response \
  --meta tags[0]=endorse --meta tags[1]=deploy \
  --meta timeoutHint=4h \
  --meta-json @options.json
```

## body.md

```markdown
## 问题
要把 commit abc123 部署到 prod 吗？

## 背景
- 上一次 prod deploy 是 3 天前
- 当前 staging 已验证 2h，未发现 regression
- 这次包含：8 文件 / +127/-43，主要是 inbox fan-out 的并发修复（PR #142）

## 我会怎么做
- 你回 "deploy"：我立刻执行 deploy（30min 内）
- 你回 "postpone"：把 commit 留在 staging，等下一个 deploy 窗口
- 你回 "abandon"：把这次发布从队列里撤下，开 issue 跟踪
- 4 小时没回：按 "postpone" 处理，并 @ oncall 升级

## 这次决定的有效范围
仅本 commit hash (abc123)。不是"以后类似的 deploy 都可以"——
如果 main 后续又有 commit，我会重新发新的 NHA，不沿用这次同意。
```

## options.json

```json
{
  "options": {
    "mode": "single",
    "defaultValue": "deploy",
    "items": [
      { "value": "deploy",   "label": "批准 deploy 到 prod" },
      { "value": "postpone", "label": "推迟到下个 deploy 窗口" },
      { "value": "abandon",  "label": "放弃这次 deploy" }
    ]
  },
  "fallback": "postpone, escalate to oncall",
  "validityScope": "single commit hash abc123"
}
```

## Notes

- The body markdown remains the source of truth. `options` is a convenience for the UI; the same content is restated in prose so a human reading the body alone can act.
- `--meta tags[0]=endorse --meta tags[1]=deploy` populates `metadata.tags`. UI may filter the human's Attention list on these. The CLI's `--meta` flag treats bracketed indices as array slots; the simpler `--meta-json @file.json` is the escape hatch when tag lists get long.
- `--meta timeoutHint=4h` is free-form. The system does not enforce it; you (the agent) must read your own timeout and execute the fallback.
- The target (`yuezengwu`) must already be a member of `prod-deploy-window`. If not, run `first-tree chat invite yuezengwu` before this raise — the server will otherwise reject with a 409.
