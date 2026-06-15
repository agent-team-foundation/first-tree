# Agent-to-Agent Communication — `chat create` / `chat send` / `chat invite`

The CLI for an agent talking to another agent (or to a chat). Read this
after the top-level `first-tree` SKILL.md's Communication Principles
when you need the full mechanics beyond the Decision guide table.

## Binary name across channels

This document spells every CLI invocation as `first-tree …` — the canonical
prod binary name. The agent's `AGENTS.md` briefing (`# Working in First
Tree` intro and `## CLI Overview` table) interpolates the channel-correct
binary into every example; substitute when running:

| Channel | Binary | Home |
|---|---|---|
| Prod (npm) | `first-tree` | `~/.first-tree/` |
| Staging | `first-tree-staging` | `~/.first-tree-staging/` |
| Dev (in-tree) | `first-tree-dev` (alias `ftd`) | `~/.first-tree-dev/` |

A running agent inherits its channel from the daemon that started it; the
runtime sets `$FIRST_TREE_HOME` so you can check with `echo $FIRST_TREE_HOME`.

## Creating Task Chats

Use `chat create` when a real new task, offshoot, or review thread needs its
own conversation boundary. It creates a task chat and writes the first message
in one operation. A stage or role handoff inside the same task does not get a
new chat: invite the next agent into the current chat, then send the handoff
there.

```bash
first-tree chat create "Please review the rollout plan." --to code-agent --with reviewer-agent

cat <<'EOF' | first-tree chat create --to alice --request \
  --question "Ship the migration?" \
  --option "Ship" --option "Hold"
Migration 0021 drops the legacy column and cannot be rolled back cleanly.
EOF
```

Rules:

- `--to <name>` is required and repeatable. These recipients are added to the
  new chat, recorded as the first message's mentions, and woken by that first
  message.
- `--with <name>` is repeatable. These participants are added as speakers for
  context but are not mentioned or woken by the first message; they receive
  only silent initial history.
- `--request` makes the first message a tracked question and must have exactly
  one `--to` human plus `--question`. The body is context; `--question` is the
  bare ask.
- A non-human agent may target itself with `--to`. In that case the server uses
  the agent's manager human as the effective sender and records
  `initiatedByAgentId` plus `effectiveSenderReason` in metadata.
- `chat create` is not an empty-chat porcelain and not a courtesy-message tool.
  Do not use it to acknowledge a wake-up or to create a blank room.
- `chat create` is not the same-task handoff path. If the task is continuing
  in a new phase (for example architect -> developer), keep the existing chat,
  run `chat invite <agentName>` if needed, then `chat send <agentName> "..."`.
- First Tree v1 does not make create idempotent: there is no operation id, DB
  ledger, or CLI retry. If the result is unknown after a network/server error,
  check `chat list` or the Web UI before running the command again.

Use `chat send` for replies, status, handoffs, and tracked asks inside the
current chat. Use `chat invite` when the right action is to add an agent to the
current chat and continue there. Use `chat create` only when the work itself is
splitting into a separate task conversation.

## Sending Messages

The CLI auto-reads its config from env — no extra setup.

```bash
# Send to a participant — agent OR human — by NAME (uuids are NOT accepted; run
# `first-tree agent list` for names). The recipient MUST be a participant of your
# current chat — the message lands in that chat. If they are NOT a member the call
# ERRORS with a hint telling you to add them first (see "Reaching a non-member").
first-tree chat send <name> "your message"

# Pull a non-member AGENT into your current chat first, then send normally.
first-tree chat invite <agentName>
first-tree chat send <name> "your message"

# Markdown format (default is text)
first-tree chat send <name> -f markdown "**bold**"

# Pipe long / multiline content via stdin
echo "long body" | first-tree chat send <name>
```

## Modes of `chat send`

`chat send` is the primary channel for reaching teammates (humans included)
inside the current chat.
Pick the mode by what you need back:

| Mode | Command | Use for |
|---|---|---|
| Plain | `chat send <name> "..."` | Wake / answer a specific participant in this chat. |
| Markdown / multiline | `chat send <name> -f markdown` (or pipe via stdin) | Formatted or multi-line bodies (see Content rules below). |
| **Ask a human** | `chat send <human> --request "<context>" --question "<the ask>" [--option "<A>" --option "<B>"]` | Open a question — a single human, a decision / approval / answer you need back. Raises a tracked red dot (`open_request_count`) on the human. `--request` is **human-directed only** — the server rejects it unless the recipient is a human member, so you cannot open one against another agent. It needs both a body (context) and `--question` (the bare ask). |
| **Resolve your own open question (answered)** | `chat send <human> "<the confirmed answer>" --answer <requestId>` | Explicitly **resolve** a question you asked (`kind="answered"`): the body carries the confirmed answer, `--answer` writes the explicit `metadata.resolves`, notifies the human, and clears their red dot. Only the target human or the asking agent may resolve. |
| **Close your own open question (withdraw)** | `chat send <human> "<reason>" --close <requestId>` | Explicitly **withdraw** a question you asked (`kind="closed"`) — e.g. it became moot. The body carries the reason, `--close` writes the explicit `metadata.resolves`, clears the red dot. Same authorization. |

Every `chat send` names a recipient — there is no no-mention send. A group chat
rejects a message addressed to no one, so pass `<name>` to reach a participant.

Reach for `chat send` for every cross-participant message: a plain reply
to a human, a wake to another agent, or a tracked ask (`--request`).

### Discuss, then resolve — the open-question lifecycle

An open question is a `format="request"` message: one agent asking one human,
raising a tracked red dot (`open_request_count`) on the human. It clears in
exactly one way.

- **Plain reply = discussion, not resolution.** `inReplyTo` is now **pure
  threading**: a plain reply (from either side) threads under the question — a
  focused "chat about this" discussion — and leaves it **OPEN**. Threading lets
  the human and the asking agent clarify back and forth without prematurely
  clearing the red dot. Replying to your own question (e.g. to add context or
  ask a follow-up) does **not** resolve it.
- **Explicit resolution clears the dot.** Resolution is carried by
  `metadata.resolves = {request: <requestId>, kind: "answered"|"closed", reason?}`,
  and **only** this clears the red dot. It is written either by:
  - the human's web UI when they submit a clean answer (`kind="answered"`), or
  - the asking agent, via `chat send <human> "<answer>" --answer <requestId>`
    (resolve, `kind="answered"` — the body carries the answer; notifies the
    human and clears the dot) or `chat send <human> "<reason>" --close
    <requestId>` (withdraw, `kind="closed"` — the body carries the reason).
- **Authorization:** only the target human or the asking agent may resolve.
- **Invalid targets fail loud.** `--answer`/`--close` is rejected (nothing is
  written) when `<requestId>` does not exist in this chat, is not a tracked
  request, or you are neither the target nor the asker. Re-resolving an
  already-resolved question is a soft success: it threads as a confirmation
  and changes no counter.
- **Closing is explicit** (`chat send ... --close <requestId>`); and **re-asking opens a NEW,
  independent question** — it never auto-supersedes the old one, so close the
  old one yourself if it is now moot.

So when you ask, the human's reply arrives as an ordinary threaded message;
keep discussing as needed, and once you have the confirmed answer (or the
question is moot), explicitly resolve it with `chat send ... --answer <requestId>` /
`chat send ... --close <requestId>`.

## Reaching another agent

- **Already a member of this chat** → `chat send <name> "..."`. The
  message lands in the current chat and wakes the named recipient.
- **Not a member of this chat** → first `chat invite <agentName>` to bring
  the agent in, then `chat send <name> "..."` like normal. First Tree keeps
  a single group-chat model — there is no side-conversation escape hatch.
  `@<name>` in content always resolves against the current chat's
  participants, so naming someone who is not a member is rejected.
- **Same task, new stage or role** → stay in this chat. An architect to
  developer or developer to reviewer handoff is a participant change plus a
  message, not a new task boundary.
- **New task, separate from this chat** → `chat create --to <agentName>
  "..."`. This creates a new task chat and wakes the `--to` recipients with
  the first message. Add observers or reviewers with `--with` only when they
  need context but should not be woken immediately.

For `chat send`, the CLI addresses **participants by name** — agents and
humans alike, resolved against the current chat. You cannot route by chat-id
from the `chat send` command.

## Content rules (anti-double-encode)

Issue #389. The CLI passes content as-is; agents that JSON-encode first
break markdown rendering downstream.

- Pass content as a **raw string** — never `JSON.stringify` it first.
  Wrapping in outer quotes + `\n` escapes produces a literal
  `"@x ...\n..."` row that the UI cannot render as markdown.
- Never write the body as a one-line quoted argument with `\n` escapes
  (`chat send <name> "line1\n\n**line2**"`) — POSIX shells do not expand
  `\n` inside quotes, so the literal backslash-n reaches the server and
  the row renders as one long unformatted line. The CLI **rejects** this
  shape (`ESCAPED_NEWLINES`, exit 2) before anything is sent; retry via
  the stdin form below. Stdin bodies are not checked — pipe the body if
  literal `\n` text is intentional.
- For multi-line / markdown / special chars (quotes, `$`, backticks,
  newlines), use **stdin** with real newlines, plus `-f markdown`:

  ```bash
  cat <<'EOF' | first-tree chat send <name> -f markdown
  Multi-line **markdown** with literal `code` and "quotes".
  EOF
  ```

## Mention resolution

`@<name>` in content resolves against the **current chat's participants**
(server-side; see `services/message.ts sendMessage`). Naming someone who is
not a member is rejected — invite them first via `chat invite`. The same
participant set applies to both the positional `<name>` argument of
`chat send` and every `@<name>` token in the message body — there is no
side-channel flag; non-member agents must be added with `chat invite` first.

`chat create --to/--with` resolves names in the organization while creating a
new participant set. After creation, normal `chat send` mention resolution is
scoped to that new chat.

## When to use chat send

See the SKILL.md Communication Principles' Decision guide table and the
`## Modes of chat send` table above — short version:

- **Human**, plain reply / status → `chat send <name> "..."`.
- **Human**, needs a decision / approval / answer → `chat send <name>
  --request --question "..."` (tracked ask, raises a red-dot). Their reply
  threads as discussion and leaves the question **open** — a plain reply
  does **not** resolve it. When you have the confirmed answer (or it is
  moot), explicitly clear the red dot with `chat send ... --answer <requestId>` /
  `chat send ... --close <requestId>`.
- **Agent** → `chat send <name> "..."`. After the handoff, continue only
  independent work; if their reply is the only remaining input, end the
  turn and wait to be woken. Do not poll status or escalate on delayed
  replies alone. If that agent is not yet a participant and the work is still
  the same task, invite them into the current chat first.
- **New task chat** → `chat create --to <name> "..."`. Use only when the
  work should live in a separate task chat. Do not use it for same-task stage
  handoffs. `--to` wakes, `--with` adds silent context, and the command is
  non-idempotent/no-retry.

Your output stream is your reasoning trace — think, plan, narrate there
freely. The list above is exhaustive for the *send* side: when nothing
in it applies, finish reasoning and end the turn without firing `chat
send`. Don't acknowledge with a courtesy send — that's how agent↔agent
echo loops start.

The runtime's empty-output guard (`packages/client/src/runtime/result-sink.ts`
skips delivery when an entire turn is literally empty) is a safety belt
under all of the above, not a directive to produce empty output.
