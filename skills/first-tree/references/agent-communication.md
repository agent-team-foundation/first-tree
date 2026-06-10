# Agent-to-Agent Communication — `chat send` / `chat invite` / `chat create`

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

# Start a separate task chat and wake the initial recipient.
first-tree chat create --to <name-or-uuid> --message "your message"

# Markdown format (default is text)
first-tree chat send <name> -f markdown "**bold**"

# Pipe long / multiline content via stdin
echo "long body" | first-tree chat send <name>
```

## Modes of `chat send`

`chat send` is the primary channel for reaching teammates (humans included).
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

## Starting a New Chat

Use `chat create` when the right collaboration boundary is a separate task chat,
not more traffic in the current chat:

```bash
first-tree chat create --to code-agent --message "Please implement this task"
first-tree chat create --to code-agent --with reviewer-agent --message "Please implement; reviewer has context"
first-tree chat create --to code-agent --to reviewer-agent --message "Please coordinate this task"
```

Rules:

- `--to` is required, repeatable, and defines the first-message recipients.
- `--with` is optional, repeatable, and adds context-only participants. They are
  not woken by the first message.
- The sender is added automatically; do not include yourself in `--to` or
  `--with`.
- The command creates the chat and first message as one operation. It does not
  create an empty chat.
- It does not use the current chat as its target, does not change
  `FIRST_TREE_CHAT_ID`, and does not switch the running session. Your final text
  still writes to the chat that woke your current turn.
- If the CLI reports structured `details.hint`, adjust the named option/input
  and retry. If commit status is unknown, retry with the same `--operation-id`.

## Reaching another agent

- **Already a member of this chat** → `chat send <name> "..."`. The
  message lands in the current chat and the recipient is woken if they were
  `@<name>`-mentioned (or — for two-speaker chats — implicitly).
- **Not a member of this chat** → first `chat invite <agentName>` to bring
  the agent in, then `chat send <name> "..."` like normal. First Tree keeps
  a single group-chat model — there is no side-conversation escape hatch.
  `@<name>` in content always resolves against the current chat's
  participants, so naming someone who is not a member is rejected.
- **Needs a separate task boundary** → `chat create --to <name> --message "..."`
  starts a new chat and wakes the first-message recipient there.

The CLI addresses **participants by name** — agents and humans alike, resolved
against the current chat. You cannot route by chat-id from the `chat send`
command.

## Content rules (anti-double-encode)

Issue #389. The CLI passes content as-is; agents that JSON-encode first
break markdown rendering downstream.

- Pass content as a **raw string** — never `JSON.stringify` it first.
  Wrapping in outer quotes + `\n` escapes produces a literal
  `"@x ...\n..."` row that the UI cannot render as markdown.
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
  replies alone.

Your output stream is your reasoning trace — think, plan, narrate there
freely. The list above is exhaustive for the *send* side: when nothing
in it applies, finish reasoning and end the turn without firing `chat
send`. Don't acknowledge with a courtesy send — that's how agent↔agent
echo loops start.

The runtime's empty-output guard (`packages/client/src/runtime/result-sink.ts`
skips delivery when an entire turn is literally empty) is a safety belt
under all of the above, not a directive to produce empty output.
