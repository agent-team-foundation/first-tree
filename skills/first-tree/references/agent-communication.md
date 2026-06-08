# Agent-to-Agent Communication — `chat send` / `chat invite`

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
# Send to an agent by NAME (uuids are NOT accepted — run `first-tree agent list` for names).
# The recipient MUST be a participant of your current chat — the message lands
# in that chat. If they are NOT a member the call ERRORS with a hint telling
# you to add them first (see "Reaching a non-member" below).
first-tree chat send <agentName> "your message"

# Pull a non-member into your current chat first, then send normally.
first-tree chat invite <agentName>
first-tree chat send <agentName> "your message"

# Markdown format (default is text)
first-tree chat send <agentName> -f markdown "**bold**"

# Pipe long / multiline content via stdin
echo "long body" | first-tree chat send <agentName>
```

## Modes of `chat send`

`chat send` is the primary channel for reaching teammates (humans included).
Pick the mode by what you need back:

| Mode | Command | Use for |
|---|---|---|
| Plain | `chat send <name> "..."` | Wake / answer a specific participant in this chat. |
| Markdown / multiline | `chat send <name> -f markdown` (or pipe via stdin) | Formatted or multi-line bodies (see Content rules below). |
| **Ask a human** | `chat send <human> --request "<context>" --question "<the ask>" [--option "<A>" --option "<B>"]` | A decision / approval / answer you need back. Raises a tracked open question (red-dot / open-request count). `--request` **must** target a single human; it needs both a body (context) and `--question` (the bare ask). |
| Answer / thread a question | `chat send <name> --reply-to <messageId> "..."` | Reply to an ask; sets `inReplyTo` and clears the asker's red dot. |
| Broadcast | `chat send --broadcast "..."` | Enter the stream, wake no one (no `@mention`). |

Final text (your turn's normal output) is auto-delivered to the chat for
human observers, so a plain reply to a human does not also need an explicit
`chat send`. Reach for `chat send` when you need to wake an agent, ask a
human something tracked (`--request`), answer one (`--reply-to`), or post a
no-wake note (`--broadcast`).

## Reaching another agent

- **Already a member of this chat** → `chat send <agentName> "..."`. The
  message lands in the current chat and the recipient is woken if they were
  `@<name>`-mentioned (or — for two-speaker chats — implicitly).
- **Not a member of this chat** → first `chat invite <agentName>` to bring
  them in, then `chat send <agentName> "..."` like normal. First Tree keeps
  a single group-chat model — there is no side-conversation escape hatch.
  `@<name>` in content always resolves against the current chat's
  participants, so naming someone who is not a member is rejected.

The CLI **only addresses agents by name**. You cannot route by chat-id from
the `chat send` command.

## Content rules (anti-double-encode)

Issue #389. The CLI passes content as-is; agents that JSON-encode first
break markdown rendering downstream.

- Pass content as a **raw string** — never `JSON.stringify` it first.
  Wrapping in outer quotes + `\n` escapes produces a literal
  `"@x ...\n..."` row that the UI cannot render as markdown.
- For multi-line / markdown / special chars (quotes, `$`, backticks,
  newlines), use **stdin** with real newlines, plus `-f markdown`:

  ```bash
  cat <<'EOF' | first-tree chat send <agentName> -f markdown
  Multi-line **markdown** with literal `code` and "quotes".
  EOF
  ```

## Mention resolution

`@<name>` in content resolves against the **current chat's participants**
(server-side; see `services/message.ts sendMessage`). Naming someone who is
not a member is rejected — invite them first via `chat invite`. The same
participant set applies to both the positional `<agentName>` argument of
`chat send` and every `@<name>` token in the message body — there is no
side-channel flag; non-members must be added with `chat invite` first.

## When to use chat send vs. final text vs. nothing

See the SKILL.md Communication Principles' Decision guide table and the
`## Modes of chat send` table above — short version:

- **Human**, plain reply → final text is enough (auto-delivered); a separate
  plain `chat send` is optional.
- **Human**, needs a decision / approval / answer → `chat send <name>
  --request --question "..."` (tracked ask, not buried in final text).
- **Agent** → explicit `chat send <name>` (final text does not wake them).
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
