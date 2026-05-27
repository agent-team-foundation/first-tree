---
name: attention
description: How to ask humans well — when to raise an NHA, how to write the body, how to wait, what to do on no-response. Use whenever you (an agent) are about to ask a human something, escalate a decision, or notify a human that something already happened. NHA replaces ad-hoc "can someone…" chat messages with a typed event that has a target, a subject, a body, an optional response expectation, and a lifecycle.
---

# Attention — asking humans well

## Channel binary

This document spells every CLI invocation as `first-tree …` — the canonical
prod binary name. **Substitute your local channel** when running:

| Channel | Binary | Home |
|---|---|---|
| Prod (npm) | `first-tree` | `~/.first-tree/` |
| Staging | `first-tree-staging` | `~/.first-tree-staging/` |
| Dev (in-tree) | `first-tree-dev` (alias `ftd`) | `~/.first-tree-dev/` |

Operators on staging would type `first-tree-staging attention raise …` —
flags and behaviour are identical across channels. Running agents inherit
their channel from the daemon that started them; you can check via
`echo $FIRST_TREE_HOME` (the runtime sets it).

## North Star

**Ask when you need to ask. Decide for yourself when you can. Notify when the human must know.**

NHA (Need-Human-Attention) is the structured "I need a human" primitive. You raise one with `first-tree attention raise`. If you need an answer, the human responds and your turn resumes. If you only need them to know, you raise a notification and continue working. Each NHA is chat-bound (`origin.chat` is required), targets exactly one human, and carries a single structural axis: `requiresResponse` — `true` for a request (Ask), `false` for a notification (Notify).

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
## Question
Should we deploy commit abc123 to prod?

## Background
- Last prod deploy was 3 days ago
- Staging has been verified for 2h, no regression
- This release: <one-paragraph diff summary>

## What I'll do
- You reply yes: I run the deploy within 30 min
- You reply no: I leave the commit on staging until the next window
- 4h with no reply: I treat it as "no", park the task, and escalate to oncall

## Validity scope
This commit hash only. Not "any similar deploy from now on".
```

Then mirror the load-bearing parts into `metadata` so the UI can render them as first-class affordances:

- `metadata.timeoutHint` — "4h"
- `metadata.fallback` — "skip this commit, escalate to oncall"
- `metadata.validityScope` — "single commit hash abc123"
- `metadata.tags` — `["endorse", "deploy"]`
- `metadata.options` — structured single/multi choice the human can click (see `references/metadata-shape.md`)

You can also write `metadata.questions[]` for a single NHA that asks several linked sub-questions at once. The UI renders each question; populate `questions[]` whenever you have multiple related sub-decisions for the same human, but always write a coherent prose body too.

## CLI reference

The CLI calls the server-side schema described in `packages/shared/src/schemas/attention.ts`. Three forms you will use:

### 1) Request approval (requires-response)

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

`--meta key=value` writes a single metadata field; `--meta-json @file.json` merges a JSON object into metadata (this is how you pass `options` / `questions`). Pass body via stdin or `@file.md` for multi-line markdown — never inline-escape newlines.

If the target is not yet a member of `--chat`, the server rejects the raise with a 409. Run `first-tree chat invite <human>` first, then raise. This is deliberate — NHA must not be a back-door for pulling people into chats.

### 2) Notify (fire-and-forget, no response expected)

```bash
first-tree attention raise \
  --chat prod-deploy-window \
  --target yuezengwu \
  --subject "deploy abc123 to prod completed" \
  --body @body.md \
  --meta 'tags[0]=notify' --meta 'tags[1]=deploy'
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
  --subject "Approve deploy of commit def456 to prod (supersedes att-9b2c)" \
  --body @body.md \
  --requires-response \
  --meta 'tags[0]=endorse' --meta 'tags[1]=deploy'
```

In the new body's `## Background` section, reference the cancelled id: *"This replaces att-9b2c, which was cancelled because main advanced to def456."* The system does not link the two; the human reads the relationship from your prose.

### Other useful commands

```bash
first-tree attention list --raised-by-me --state open   # what's still outstanding from you
first-tree attention list --in-chat <chat>              # all NHA in this chat
first-tree attention show <id>                          # full record incl. response
```

The human side (`first-tree attention respond <id> --text "..."`) is theirs to drive, not yours. Only the target can respond; only you (origin agent) can cancel.

### How to wait for the response

The runtime does **not** yet wake your session on `attention:responded`. To resume after a human reply, **poll `attention show <id>` periodically** (or `attention list --raised-by-me --state closed` if you're checking a batch). Recommended cadence: every 30-60s for the first 10 minutes, then back off. Don't tight-loop — and don't `sleep 4h` either; if you're idle that long, exit the turn and let the next session check.

If you absolutely need a sync wait without burning a session, your handler can `exit` and rely on the next external wake (next chat message, scheduled run, etc.) to re-enter and check.

## When NOT to raise an NHA

- **Yes/no buttons for trivial decisions.** "Should I name this `user` or `u`?" — decide yourself; the human can change it later.
- **Facts you can look up.** "What deploy platform do we use?" — search the Tree, configs, chat history, and code before asking.
- **Parallel NHAs in the same chat.** If you have several related decisions, bundle them into one NHA's `metadata.questions[]` or sequence them. The UI assumes 0 or 1 open request-NHA per chat.
- **"Are you there?" with no concrete decision.** The human needs to know what they're deciding. If you can't articulate the choice, you're not ready to raise.
- **Reusing a stale answer.** A `yes` from 3 days ago does not authorize today's action — even if "it's basically the same thing." Raise a fresh NHA.

## Multi-round flows

There is no built-in wizard / chain. If a human's response leads to a follow-up question, that's just `cancel` (or wait for `closed`) and `raise` a new NHA. The new body's `## Background` should reference the previous answer: *"Based on your earlier `yes` to deploying abc123, the next decision is whether to also fast-follow with the migration in def456."*

This keeps the schema honest — each NHA is one question with one outcome, and the conversation thread lives in the chat prose, not in NHA metadata.

## Examples

- `examples/endorse-deploy.md` — well-formed approval request, with structured `options`.
- `examples/notify-completion.md` — well-formed completion notification.
- `examples/supply-missing-detail.md` — request filling in a single factual input (credentials / id / threshold).
- `examples/direct-route-decision.md` — request routing a decision that's not the agent's call (escalation, customer-facing trade-off).
- `examples/multi-question-launch.md` — one NHA carrying multiple related decisions via `metadata.questions[]` (atomic submission).
- `references/metadata-shape.md` — terse spec of `metadata.options` and `metadata.questions` for when you want the human to click instead of type.
