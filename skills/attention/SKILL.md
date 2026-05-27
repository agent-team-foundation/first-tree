---
name: attention
description: How to ask humans well — when to raise an NHA, how to write the body, how to wait, what to do on no-response. Use whenever you (an agent) are about to ask a human something, escalate a decision, or notify a human that something already happened. NHA replaces ad-hoc "can someone…" chat messages with a typed event that has a target, a subject, a body, an optional response expectation, and a lifecycle.
---

# Attention — asking humans well

## North Star

**该问的时候问，不该问的时候自动处理，必须让人知道的时候再通知。**

NHA (Need-Human-Attention) is the structured "I need a human" primitive. You raise one with `first-tree attention raise`. If you need an answer, the human responds and your turn resumes. If you only need them to know, you raise a notification and continue working. Each NHA is chat-bound (`origin.chat` is required), targets exactly one human, and carries a single structural axis: `requiresResponse` — `true` for a request (请示), `false` for a notification (通报).

The system layer is intentionally thin. It stores, routes, and delivers; it does **not** decide whether you should raise, how long to wait, or what to do on timeout. Those are your job — that's why this skill exists.

## When to raise an NHA — four lenses

These are **thinking lenses**, not data partitions. A single NHA can hit multiple lenses at once (a prod-deploy approval is simultaneously *endorse* and *direction*). The only structural axis in the schema is `requiresResponse`. The lenses live in your head and in the body markdown — they help you decide *whether* to raise and *what to write* — they never become an enum field.

| Lens | Ask yourself | Counterexample (do NOT raise) |
|---|---|---|
| **Endorse / accountability** | Does this action need a specific human's name on it? Is it irreversible, externally visible, or risky? | Low-risk reversible actions; ordinary code edits; internal-only test runs |
| **Information / supply** | Is this fact only obtainable from a human? Have I checked the Tree, configs, chat history, and the code? | Anything findable by searching Tree / config / commit history |
| **Direction / choice** | Are multiple options all reasonable, with the difference being values / style / priority rather than correctness? | Cases with a clear technically-correct answer (variable naming, error code shape) |
| **Inform / notify** | Has something already happened that a human must know about (deploy done, irreversible rollback fired, an external escalation)? | Trivial progress noise ("I edited 3 lines") |

Mapping to schema:

- Endorse / Supply / Direction → `--requires-response` (request)
- Inform → omit the flag (notification, auto-closes on creation)

## Five principles

1. **Attention is scarce.** Every NHA you fire spends a human's focus budget. Don't fan them out liberally. When in doubt, decide yourself and write what you decided into the chat — the human can correct you in plain text without an NHA.
2. **You decide whether to block on the answer.** The system does not. If you intend to wait, write that in the body. If you'll keep going and apply the answer when it arrives, write that too. Be explicit about either path; never leave the human guessing whether they're on the critical path.
3. **Context can go stale.** If the situation changes before the human responds — upstream failed, new commit landed, the question is no longer meaningful — `cancel` the old NHA and `raise` a new one. There is no "supersede" state and no replacement chain; explicit cancel + new is the only modification flow.
4. **Always declare a fallback.** Tell the human what you will do if they never respond. "If I don't hear back in 4 hours I'll skip this step and leave the commit on staging." Treat the fallback as a real decision the human can override, not a hidden default.
5. **A human's reply binds within the scope and time window you declared, and not beyond.** If you wrote "this approval is just for this commit hash," do not reuse it for the next commit. If you want broader scope, say so up front or raise a new NHA.

## How to write a good NHA body

The body is markdown. Use four implicit sections — question, background, what-I'll-do, validity scope:

```markdown
## 问题
要把 commit abc123 部署到 prod 吗？

## 背景
- 上一次 prod deploy 是 3 天前
- 当前 staging 已验证 2h，未发现 regression
- 这次包含: <一段 diff 摘要>

## 我会怎么做
- 你回 yes：我立刻执行 deploy（30min 内）
- 你回 no：我把这个 commit 留在 staging，等下次窗口
- 4 小时没回：我会按 "no" 处理，并把任务挂起，同时升级到 oncall

## 这次决定的有效范围
仅本 commit hash。不是"以后类似的 deploy 都可以"。
```

Then mirror the load-bearing parts into `metadata` so the UI can render them as first-class affordances:

- `metadata.timeoutHint` — "4h"
- `metadata.fallback` — "skip this commit, escalate to oncall"
- `metadata.validityScope` — "single commit hash abc123"
- `metadata.tags` — `["endorse", "deploy"]`
- `metadata.options` — structured single/multi choice the human can click (see `references/metadata-shape.md`)

You can also write `metadata.questions[]` for a single NHA that asks several linked sub-questions at once (M2). At M1 末 the UI renders the top-level question; populate `questions[]` if you have it, but always write a coherent prose body too.

## CLI reference

The CLI calls the server-side schema described in `packages/shared/src/schemas/attention.ts`. Three forms you will use:

### 1) Request approval (requires-response)

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

`--meta key=value` writes a single metadata field; `--meta-json @file.json` merges a JSON object into metadata (this is how you pass `options` / `questions`). Pass body via stdin or `@file.md` for multi-line markdown — never inline-escape newlines.

If the target is not yet a member of `--chat`, the server rejects the raise with a 409. Run `first-tree chat invite <human>` first, then raise. This is deliberate — NHA must not be a back-door for pulling people into chats.

### 2) Notify (fire-and-forget, no response expected)

```bash
first-tree attention raise \
  --chat prod-deploy-window \
  --target yuezengwu \
  --subject "deploy abc123 到 prod 已完成" \
  --body @body.md \
  --meta tags[0]=notify --meta tags[1]=deploy
```

No `--requires-response`. The record is created with `state=closed`. The human sees it in the right-sidebar Attention list but is not asked to reply. Your turn continues immediately.

### 3) Cancel + re-raise (the modification flow)

```bash
# Situation changed (e.g. main got a new commit; original approval would no longer apply)
first-tree attention cancel att-9b2c \
  --reason "main has new commit def456; previous approval would be misapplied"

first-tree attention raise \
  --chat prod-deploy-window \
  --target yuezengwu \
  --subject "批准 deploy commit def456 到 prod (取代 att-9b2c)" \
  --body @body.md \
  --requires-response \
  --meta tags[0]=endorse --meta tags[1]=deploy
```

In the new body's `## 背景` section, reference the cancelled id: *"This replaces att-9b2c, which was cancelled because main advanced to def456."* The system does not link the two; the human reads the relationship from your prose.

### Other useful commands

```bash
first-tree attention list --raised-by-me --state open   # what's still outstanding from you
first-tree attention list --in-chat <chat>              # all NHA in this chat
first-tree attention show <id>                          # full record incl. response
```

The human side (`first-tree attention respond <id> --text "..."`) is theirs to drive, not yours. Only the target can respond; only you (origin agent) can cancel.

## When NOT to raise an NHA

- **Yes/no buttons for trivial decisions.** "Should I name this `user` or `u`?" — decide yourself; the human can change it later.
- **Facts you can look up.** "What deploy platform do we use?" — search the Tree, configs, chat history, and code before asking.
- **Parallel NHAs in the same chat.** If you have several related decisions, bundle them into one NHA's `metadata.questions[]` (M2) or sequence them. The UI assumes 0 or 1 open request-NHA per chat.
- **"Are you there?" with no concrete decision.** The human needs to know what they're deciding. If you can't articulate the choice, you're not ready to raise.
- **Reusing a stale answer.** A `yes` from 3 days ago does not authorize today's action — even if "it's basically the same thing." Raise a fresh NHA.

## Multi-round flows

There is no built-in wizard / chain. If a human's response leads to a follow-up question, that's just `cancel` (or wait for `closed`) and `raise` a new NHA. The new body's `## 背景` should reference the previous answer: *"Based on your earlier `yes` to deploying abc123, the next decision is whether to also fast-follow with the migration in def456."*

This keeps the schema honest — each NHA is one question with one outcome, and the conversation thread lives in the chat prose, not in NHA metadata.

## Examples

- `examples/endorse-deploy.md` — well-formed approval request, with structured `options`.
- `examples/notify-completion.md` — well-formed completion notification.
- `examples/supply-missing-detail.md` — request filling in a single factual input (credentials / id / threshold).
- `examples/direct-route-decision.md` — request routing a decision that's not the agent's call (escalation, customer-facing trade-off).
- `examples/multi-question-launch.md` — one NHA carrying multiple related decisions via `metadata.questions[]` (atomic submission).
- `references/metadata-shape.md` — terse spec of `metadata.options` and `metadata.questions` for when you want the human to click instead of type.
