# Endorse — deploy approval

A request-style NHA that asks a named human to authorize a prod deploy. Demonstrates structured `options` so the UI can render one-click buttons, plus the implicit body sections (Question / Background / What I'll do / Validity scope).

## CLI

```bash
first-tree attention raise \
  --chat prod-deploy-window \
  --target yuezengwu \
  --subject "Approve deploy of commit abc123 to prod" \
  --body @body.md \
  --requires-response \
  --meta 'tags[0]=endorse' --meta 'tags[1]=deploy' \
  --meta 'timeoutHint=4h' \
  --meta-json @options.json
```

## body.md

```markdown
## Question
Should we deploy commit abc123 to prod?

## Background
- Last prod deploy was 3 days ago
- Staging has been verified for 2h with no regression
- Diff: 8 files / +127 / -43, mostly the inbox fan-out concurrency fix (PR #142)

## What I'll do
- You reply "deploy": I run the deploy within 30 min
- You reply "postpone": commit stays in staging until the next deploy window
- You reply "abandon": pull this release from the queue and open a tracking issue
- 4h without a reply: I treat it as "postpone" and @ oncall for escalation

## Validity scope
This commit hash (abc123) only. Not "any similar deploy from now on" —
if more commits land on main, I raise a fresh NHA instead of reusing this approval.
```

## options.json

```json
{
  "options": {
    "mode": "single",
    "defaultValue": "deploy",
    "items": [
      { "value": "deploy",   "label": "Approve deploy to prod" },
      { "value": "postpone", "label": "Postpone to next deploy window" },
      { "value": "abandon",  "label": "Drop this deploy" }
    ]
  },
  "fallback": "postpone, escalate to oncall",
  "validityScope": "single commit hash abc123"
}
```

## Notes

- The body markdown remains the source of truth. `options` is a convenience for the UI; the same content is restated in prose so a human reading the body alone can act.
- `--meta 'tags[0]=endorse' --meta 'tags[1]=deploy'` populates `metadata.tags`. UI may filter the human's Attention list on these. The CLI's `--meta` flag treats bracketed indices as array slots; the simpler `--meta-json @file.json` is the escape hatch when tag lists get long. (Quote the value in zsh — `[` is a glob char.)
- `--meta 'timeoutHint=4h'` is free-form. The system does not enforce it; you (the agent) must read your own timeout and execute the fallback.
- The target (`yuezengwu`) must already be a member of `prod-deploy-window`. If not, run `first-tree chat invite yuezengwu` before this raise — the server will otherwise reject with a 409.
