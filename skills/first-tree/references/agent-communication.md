# Agent-to-Agent Communication — `chat send` / `chat invite` / `chat create`

The CLI for an agent talking to another agent (or to a chat). Read this
after the top-level `first-tree` SKILL.md's Communication Principles
when you need the full mechanics beyond the Decision guide / Fallback
table.

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
| **Ask a human** | `chat send <human> --request "<context>" --question "<the ask>" [--option "<A>" --option "<B>"]` | A decision / approval / answer you need back. Raises a tracked open question (red-dot / open-request count). `--request` is **human-directed only** — the server rejects it unless the recipient is a human member, so you cannot open one against another agent. It needs both a body (context) and `--question` (the bare ask). |

Every `chat send` names a recipient — there is no no-mention send. A group chat
rejects a message addressed to no one, so pass `<name>` to reach a participant.

Final text (your turn's normal output) is auto-delivered to the chat for
human observers, so a plain reply to a human should be **just** that final
text — do not *also* fire a plain `chat send` to the same human, or it
double-posts. Reach for `chat send` when you need to wake an agent or ask a
human something tracked (`--request`).

You never answer an open question yourself: a request can only be directed at a
human, so when you ask one, the human's answer arrives back as an ordinary
message — there is no agent-side `--reply-to` step, and the runtime already
threads your final text under whatever woke the turn.

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

## When to use chat send vs. final text vs. nothing

See the SKILL.md Communication Principles' Decision guide table and the
`## Modes of chat send` table above — short version:

- **Human**, plain reply → final text is enough (auto-delivered); do *not* also
  fire a plain `chat send` to the same human — it double-posts.
- **Human**, needs a decision / approval / answer → `chat send <name>
  --request --question "..."` (tracked ask, not buried in final text).
- **Agent** → explicit `chat send <name>` (final text does not wake them).
  After the handoff, continue only independent work; if their reply is the
  only remaining input, end the turn and wait to be woken. Do not poll status
  or escalate on delayed replies alone.
- No specific target (narration / thinking aloud) → final text only; no
  send needed.
- Current Chat Context block missing from prompt → conservative mode, all
  cross-agent work goes through explicit `chat send`.

The runtime's silent-turn protocol (empty output → skip delivery, free the
turn) is enforced by `packages/client/src/runtime/result-sink.ts`; it
pairs with the "Stay silent when you have nothing to add" directive in
the `# Working in First Tree` intro of `AGENTS.md`. Both directions of
the contract — *say nothing when silent is right* and *always `chat send`
when you want to wake an agent* — are load-bearing for preventing
courteous agent↔agent echo loops.
