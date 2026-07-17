# CLI Reference

The full command surface for `first-tree`. Every command listed here is in
the shipped binary — `first-tree --help` (and `first-tree <namespace>
--help`) are the canonical source of truth, this document is a
human-friendly index over them.

> **Keeping this file current.** Any PR that changes the command surface
> (adds, renames, removes, or re-flags a verb / namespace) must update
> this file in the same PR. The grep checks that gate `Forbid legacy CLI
> / env names` only catch a handful of retired identifiers; the broader
> *"what commands exist and what do they do"* contract is enforced by
> humans against this document.

## Install

Production:

```bash
curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh
~/.local/bin/first-tree login <connect-code>
```

Staging:

```bash
curl -fsSL https://download.first-tree.ai/releases/staging/install.sh | sh
~/.local/bin/first-tree-staging login <connect-code>
```

The public shell installers support macOS and Linux and bundle Node.js. They
install channel-specific binaries under `~/.local/bin`: `first-tree` / `ft`
for production and `first-tree-staging` / `fts` for staging. The full path in
the login command works immediately, before the current shell reloads `PATH`.
The two lines are intentionally independent and do not provide shell-level
transaction protection: when pasted together, an install-line failure does not
automatically prevent the login line from running, and POSIX `sh` does not
guarantee that `curl | sh` preserves a `curl` failure status.

For self-hosted deployments, use the two-line command returned by the web
console. It includes the server and portable download-base overrides when
needed. Development builds continue to use `scripts/dev-install.sh` and
`first-tree-dev login <connect-code>`.

## Global flags

| Flag | Effect |
|---|---|
| `--json` | Emit only machine-readable JSON on stdout; silence human status lines on stderr. |
| `--verbose` | Raise the log level to debug (overrides `FIRST_TREE_LOG_LEVEL`). |
| `--version` | Print the CLI version and exit. |
| `--help` | Print help for the command or namespace. |

## Top-level command tree

```
first-tree
├── login <code>             Sign this computer in or switch local clients
├── logout                   Stop the daemon and clear credentials
├── computer ...             Computer-level local state recovery
├── status                   CLI + daemon + server + auth + agent overview
├── doctor                   Cross-subsystem readiness check
├── upgrade                  Self-update + restart the daemon
├── agent ...                Agent management (config, bindings, sessions, messaging)
├── chat ...                 Chats and messaging (create, send, list, history, open)
├── doc ...                  Org document library (publish, comments, reply, resolve, status)
├── github ...               GitHub entity attention and context review
├── gitlab ...               GitLab Issue/MR entity attention
├── org ...                  Organization-level operations
├── daemon ...               Background daemon (start, stop, status, doctor, probe)
├── config ...               View/modify this machine's client.yaml
└── tree ...                 Validate and browse Context Trees
```

---

## login

```
first-tree login <code> [--no-start] [--force-switch]
```

Sign this computer in using a short connect code from the web console. New
codes are exchanged against this CLI channel's default server URL
(`first-tree` → production, `first-tree-staging` → staging, `first-tree-dev` →
local dev), with `FIRST_TREE_SERVER_URL` as an explicit override for custom
deployments. Connect URLs are not accepted; only legacy JWT tokens with an
`iss` claim remain accepted during rollout.
If this machine already has credentials for another user, `login` asks for
explicit confirmation and switches the active local client after stopping and
draining the old runtime. In non-TTY automation, `--force-switch` is the only
confirmation flag; it does not skip supervisor, drain, filesystem, or journal
safety checks. If credentials are missing, `login` preserves `client.yaml` and
local agent state so the same user can reconnect after a normal `logout`.

| Flag | Effect |
|---|---|
| `--no-start` | Write credentials and exit without installing/starting the background daemon. |
| `--force-switch` | Confirm a different-user local client switch in non-interactive mode. Safety gates still run. |

## logout

```
first-tree logout [--purge]
```

Stop the daemon and clear credentials. `--purge` additionally removes active
root client state, parked clients under `$FIRST_TREE_HOME/parked-clients/`, and
switch lock/journal files. This is a destructive local reset path, not the
normal account-switch path. To switch this computer to another First Tree user,
run `first-tree login <code>` with the new user's connect code and confirm
the switch. Before deleting local state, `--purge` retires the current server
client so it disappears from default Computers views and cannot be reactivated
with the same client id. Retiring is destructive for runtime routing on that
client: non-deleted agents pinned to it are suspended and unpinned, while agent
identity, chats, history, and profile data remain; those cleared agents can be
moved back onto a connected computer/runtime from the Agent Runtime tab. Logout
stops both the background service and any live `daemon start --foreground`
runtime markers for the active client before clearing credentials/state. If the
daemon is active and cannot be stopped, a foreground runtime cannot be stopped,
or the server-side retire fails, `--purge` refuses to delete local client state.
The default keeps local client/agent state for the same user to reconnect later.

## computer

Computer-level local state recovery.

```
first-tree computer
└── reset
```

### computer reset

```
first-tree computer reset
```

Stop the daemon and remove active root client state, parked clients under
`$FIRST_TREE_HOME/parked-clients/`, switch lock/journal files, and active
credentials. Use this when local identity state is damaged or when you
intentionally want to discard every local First Tree client stored in this
installation. This is local-only and does not retire server client rows. Normal
different-user switching should use
`first-tree login <code>` instead, which parks inactive clients.

## status

```
first-tree status
```

Single-screen overview: CLI version, daemon state, server reachability,
auth health, and the agents this client manages.

## doctor

```
first-tree doctor
```

Cross-subsystem readiness check covering the daemon, server reachability,
WebSocket, and configured agents. Use this when `status` flags something
red and you want a guided drill-down.

## upgrade

```
first-tree upgrade [--check] [--no-restart]
```

Self-update for the CLI: query the configured server for its recommended
Command version when a server URL is configured, install that exact version
through the current install mode, refresh the supervisor definition on top of
the new bits, then restart the client service. If no server URL is configured
yet, `upgrade` falls back to the current channel's latest release data directly
so the update path still works before login/config. Portable installs download
the channel manifest and verified tarball, including the bundled Node.js
runtime. Existing npm-mode installs retain their package-manager update path
and continue using the system Node.js runtime.

| Flag | Effect |
|---|---|
| `--check` | Only check for an available version; print "update available" or "already on latest". Do not install. |
| `--no-restart` | Install the new version and refresh the supervisor definition, but leave the running service alone. Used for staged rollouts. |

Refusing to run from a source checkout (anywhere under a `.git`
ancestor) is intentional — it keeps a dev build from accidentally overwriting
a hosted-channel installation. For local development use
`scripts/dev-install.sh` (see [docs/development/local-dev-isolation.md](development/local-dev-isolation.md)).

For an existing npm-mode installation, `upgrade` checks the target package's
`engines.node` metadata before install when npm can provide it. If the target
requires a newer Node.js than the current process is running, the command fails
before install with a system-Node upgrade hint and a shell-installer migration
hint. npm-mode updates do not replace Node.js themselves.

---

## agent

Agent management — local config, bindings, sessions, messaging
debug helpers.

```
first-tree agent
├── list [--remote] [--org <id>]
├── add --agent-id <uuid>
├── create <name> --type <t> --client-id <id> [--runtime <r>] [--display-name <s>] [--org <id>]
├── remove <name>
├── prune [--yes] [--dry-run]
├── status [name]
├── reset <name>
├── config <subcommand>
├── bind <subcommand>
├── workspace <subcommand>
└── session <subcommand>
```

### agent list

```
first-tree agent list                    # locally-configured agents on this client
first-tree agent list --remote           # every agent the signed-in user manages on the server
first-tree agent list --remote --org <id>  # cross-org view (multi-org operators)
```

### agent create

```
first-tree agent create <name> --type <human|agent> --client-id <thisClient> [--runtime claude-code|codex|cursor]
```

Creates the agent row on the server and binds it to the given client
machine. The local `agents/<name>/agent.yaml` is written by the running
daemon via the server-pushed `agent:pinned` frame; no second command
needed if the daemon is already up.

### agent add

```
first-tree agent add --agent-id <uuid>
```

Register an existing server-side agent on this client. Use this when the
daemon was not running at the moment the agent was pinned, or when
moving an agent to a second computer that's already signed into the
same user.

### agent remove / agent prune

```
first-tree agent remove <name>     # delete local config dir, workspace, session state
first-tree agent prune [--yes] [--dry-run]  # remove every local alias the server no longer pins to you
```

`prune` is the counterpart to `daemon doctor`'s "stale aliases" warning.

### agent status / agent reset

```
first-tree agent status               # all agents this client manages
first-tree agent status <name>        # one agent's runtime view from the server
first-tree agent reset <name>         # reset agent error state to idle
```

### agent config

Mutate the agent's server-side runtime configuration (model, prompt,
MCP servers, env, repos). Edits the `agent_configs.payload` JSONB row
through the Admin API.

```
first-tree agent config
├── show <agent>
├── set-model <agent> <model>                       # alias: opus | sonnet | haiku, or full id (e.g. claude-opus-4-7)
├── set-reasoning-effort <agent> <level>
├── prompt show <agent> [--raw]                     # per-agent prompt fragment; --raw is verbatim (round-trippable)
├── prompt set <agent> [-f <file>] [--force]        # replace the fragment ONLY; reads stdin if no file.
│                                                   #   Rejects copies of the assembled AGENTS.md (generated marker /
│                                                   #   briefing headings); --force overrides the heading heuristic.
│                                                   #   Does NOT cover inline replacements of team prompts — those are
│                                                   #   resource bindings, managed in Cloud → Org Settings → Resources.
├── append-prompt <agent> [-f <file>]               # deprecated alias of `prompt set`
├── add-mcp <agent> --name <id> --transport <t> [--command <c> --args <a>... | --url <u>]
├── set-env <agent> KEY=VALUE [--sensitive]
├── add-repo <agent> <url> [--ref <branch>] [--path <local>]
└── dry-run <agent> -f <patch.json>                 # validate + diff, no persist
```

Reasoning effort values are provider-specific. Claude Code and Claude Code
TUI accept `""` (inherit the operator's local setting), `low`, `medium`,
`high`, or `max`. Codex accepts `low`, `medium`, `high`, `xhigh`, `max`, or
`ultra`; availability of the higher levels is model-dependent and rejected
combinations are reported by the provider.

### agent bind

```
first-tree agent bind
└── client <agentName> --client-id <id>             # first-time bind only; later moves use managed runtime switch
```

### agent workspace

```
first-tree agent workspace clean [agent-name] [--ttl <days>]
```

Remove stale workspace directories (older than the TTL with no active
session). Without an agent name, sweeps every local agent.

### agent session

```
first-tree agent session
├── list <agent-name> [--state <active|suspended|evicted|errored>]
├── suspend <agent-name> <chat-id>
└── terminate <agent-name> <chat-id>
```

---

## chat

Day-to-day messaging.

```
first-tree chat
├── create [message]                               # create a separate task chat and write its first message
│     --to <name>                                  #   initial recipient to mention + wake; repeatable, required
│     --with <name>                                #   context participant; added silently, not woken by the first message
│     --topic <text> / --description <text>        #   initial chat self-description
│     --request                                    #   first message is a tracked ask; the body IS the ask, decision-self-sufficient (why + recap + question + recommendation); exactly one --to human
│     --options <json> / --multi-select            #   (with --request) 2–4 options {label,description,preview?}; allow multi-pick
├── send <name> [message]                            # wake a participant — agent or human (a send to a human is informational only; a question the next step depends on goes through `chat ask`)
│     # body: [message] arg, or stdin (omit [message]), or -F <path>; prefer stdin/-F for rich bodies (shell-safe)
│     -F, --message-file <path>                      #   read the body from <path> (`-` = stdin); content never hits the shell
│     --reply-to <messageId>                         #   thread a reply under a message (pure threading)
├── ask <name> [message]                             # ask a HUMAN a tracked question; the body IS the ask, decision-self-sufficient (why it exists + recent-context recap + question + recommendation)
│     # body: [message] arg, or stdin (omit [message]), or -F <path>; prefer stdin/-F for rich bodies (shell-safe)
│     -F, --message-file <path>                      #   read the body from <path> (`-` = stdin); content never hits the shell
│     --options <json>                               #   2–4 answer options {label (1–5 words), description, preview?}; omit for free-text
│     --multi-select                                 #   allow picking more than one option (requires --options)
│     # always a fresh top-level question — no threading, and no resolve flag
│     # (the human answers in the web UI; an agent can only ASK)
├── invite <agentName>                               # add to FIRST_TREE_CHAT_ID before same-task send
├── list
├── history <chatId>
├── update                                           # update topic and/or description (each independently)
│     --topic <text> / --clear-topic                 #   set/clear the short display label
│     --description <text> / --clear-description      #   set/clear the work summary + status report (Markdown; `-` = read from stdin/heredoc)
│     --chat <chatId> / --agent <name>               #   target another chat / the named agent
├── set-topic [topic]                                # [DEPRECATED — use `update`] hidden alias
└── open <agent-name>                                # interactive REPL
```

```bash
# Split off separate work into a new task chat and write the first message.
# --to recipients are mentioned and woken; --with participants are added for
# context but receive only silent initial history. This is not an empty-chat or
# same-task handoff tool.
first-tree chat create "Please review the rollout plan." --to code-agent --with reviewer-agent \
  --topic "rollout review" \
  --description "reviewing rollout plan; waiting on code-agent"

# Start a new task chat with a tracked question. The first request must target
# exactly one human. The message body IS the ask and must be
# decision-self-sufficient (why the question exists + recent-context recap +
# the single question and your recommendation); pass 2–4 --options (JSON) for
# a clean pick, or omit them for a free-text answer.
cat <<'EOF' | first-tree chat create --to alice --request \
  --options '[{"label":"Ship","description":"Roll the migration now"},{"label":"Hold","description":"Wait 24h"}]'
## Why this question exists
Migration 0021 drops the legacy column — irreversible, so shipping is your call.
## Recent context
The 0021 cleanup you asked for last week is done; the PR is approved and CI is
green.
## The question
Ship the destructive migration now? I would ship — the column has had no reads
for 30 days.
EOF

# Inline — `chat send` wakes a participant (agent or human). A plain send to a
# human is informational only — readable, then safely ignorable; any question
# the next step depends on goes through `chat ask` (a send never carries a
# blocking question). The recipient must be a participant of FIRST_TREE_CHAT_ID.
first-tree chat send code-agent "ship the PR"

# Stdin (multiline, markdown, special chars)
echo "long body" | first-tree chat send code-agent -f markdown

# Rich / multi-line bodies: write to a file, then read it with --message-file
# (or `-F`). This is the most robust form — the body never passes through the
# shell, so backticks (`code`), quotes, apostrophes, and newlines are sent
# byte-for-byte. Inlining such a body lets the shell run backticks as command
# substitution and break on quotes, silently mangling the message.
first-tree chat send code-agent -f markdown --message-file reply.md
first-tree chat send code-agent -f markdown -F -   < reply.md   # `-` = stdin

# Inline bodies must carry REAL newlines. A one-line quoted body written with
# `\n` escapes — chat send code-agent "line1\n\n**title**" — is rejected
# BEFORE anything is sent (ESCAPED_NEWLINES, exit 2): shells do not expand
# `\n` inside quotes, so the literal backslash-n would be stored and the
# message would render as one long unformatted line. The error prints a
# copyable heredoc retry form on stderr; resend via stdin:
cat <<'EOF' | first-tree chat send code-agent -f markdown
first line

**second** line
EOF
# Stdin bodies are never checked — piping is also the escape hatch for
# intentionally sending literal `\n` text.

# Embed a workspace image — a markdown image `![alt](path)` in a `chat send`
# body whose target is an image (png/jpeg/gif/webp) inside the agent's own
# workspace is uploaded at send time and delivered as a real inline chat image
# (the same shape a human composer upload uses), so recipients see the picture
# instead of a broken local path. Only explicit `![...](...)` embeds are
# captured (a bare filename is left as text), only the sender's own workspace,
# and an image shown inside a block code sample the renderer recognizes (a
# fenced block at any container depth, or an indented code block) is left as a
# literal sample (an image written inside inline `code` is treated as a live
# embed). Capture is best-effort and never blocks the send, and is skipped
# entirely for a body longer than ~1 million characters (then sent verbatim). An image
# that is too large (>10 MB), unreadable, or beyond the 20-per-message cap is
# skipped: if no image in the message captured, the body is sent unchanged (the
# skipped embed stays as text); if at least one sibling image did capture — so
# the message becomes an image send — every workspace-image embed is removed
# from the caption, so a skipped one is dropped rather than left as a path that
# would render broken.
echo 'Latest run: ![chart](reports/latency.png)' | first-tree chat send code-agent -f markdown

# Ask a human a tracked question (red-dot + blocks the chat for them until they
# answer). `chat ask` targets a single human; the message body IS the ask and
# must be decision-self-sufficient for a reader who remembers nothing of the
# chat: why the question exists + a recap of the recent interactions + the
# single question and your recommendation, written for a reader holding none
# of the context (unpack every shorthand; name options by their concrete
# consequence). Omit --options for a free-text answer, or pass 2–4 --options
# (JSON) for a clean pick; add --multi-select to allow more than one.
cat <<'EOF' | first-tree chat ask alice \
  --options '[{"label":"Ship","description":"Roll it now"},{"label":"Hold","description":"Wait 24h"}]'
## Why this question exists
Migration 0021 drops the legacy column — irreversible, so shipping is your call.
## Recent context
You asked for the 0021 cleanup yesterday; the PR is approved and CI is green.
## The question
Ship the destructive migration now? I would ship — the column has had no reads
for 30 days.
EOF

# Free-text ask (no options) — the same three-section body, answered in free
# text. `-F` reads the body from a file (shell-safe — same rationale as
# `chat send -F`)
first-tree chat ask alice --message-file ask-body.md

# `chat ask` always opens a fresh top-level question — there is no threading
# (no --reply-to) and no resolve command. An agent can only ASK — it cannot mark a question
# answered or close it. The human resolves it by answering in the web UI; a moot
# question is simply left open (the human works open questions oldest-first), and
# re-asking opens a NEW, independent question.

# Pull a non-member into the current chat first, then send normally. Use this
# for same-task stage / role handoffs.
first-tree chat invite code-agent
first-tree chat send code-agent "now we can talk"

# Browse
first-tree chat list
first-tree chat history <chatId>

# Self-description: a short topic label + a work summary + status report,
# updated independently through `chat update` (topic and description each on
# their own). The description carries task background + plan + progress, renders
# as Markdown, and shows at the top of the chat's right sidebar; agents also read
# it via `chat list` to self-locate (see the agent briefing's "Chat Topic &
# Description"). Keep blockers / decisions OUT of it — raise `chat ask <human>`
# for those. Owner-gated: the chat's creator may update it, and when
# no agent owner is present (human-created chats — Web / GitHub-sourced — or the
# creator left) every worker agent counts as the owner; a non-owner agent in a
# chat whose agent creator is still present is refused with 403.
first-tree chat update --topic "review PR #916"
first-tree chat update --description "Reviewing PR #916. **Plan:** address review findings, re-verify. **Progress:** 2/3 findings fixed."
first-tree chat update --topic "ship plan" --description "Drafting; next: hand to QA."
first-tree chat update --clear-description
# A one-line --description whose newlines are written as literal `\n` is rejected
# before the write: shell quotes do not expand `\n`, so it would persist and
# render as one long line with visible `\n` tokens. For a multi-line description
# pass real newlines — either an ANSI-C $'...' string, or `--description -` to
# read it from stdin/heredoc:
cat <<'EOF' | first-tree chat update --description -
Reviewing PR #916.

**Plan:** address review findings, re-verify.
**Progress:** 2/3 findings fixed.
EOF
# `chat set-topic` still works as a deprecated alias.

# Interactive
first-tree chat open code-agent
```

`chat send` / `chat invite` operate on the chat identified by
`FIRST_TREE_CHAT_ID`, which the runtime injects into the agent's session
environment. The recipient must be a participant of that chat; if not,
`invite` first.

`chat create` is different: it creates a new task chat and writes the first
message in one command. Use it to split genuinely new work into a fresh chat.
Use `chat send` for replies/status in the current chat, and `chat invite` when
you want to add a non-member to the current chat before sending there. A
same-task handoff, such as architect to developer or developer to reviewer,
stays in the current chat; invite the next agent and send the handoff there.

Task creation is intentionally not idempotent. There is no operation id, and
the CLI does not automatically retry a create request. If the command reports
an unknown result after a network/server failure, check `chat list` or the Web
UI before running it again; the chat may already exist.

If a non-human agent includes itself in `chat create --to`, the server records
the originating agent in metadata and uses that agent's manager human as the
effective sender so the first message can wake the agent normally.

---

## doc

Org document library (docloop) — publish markdown design docs for team
review, pull the structured comments reviewers leave, reply, resolve, and
track document status. Feature-flagged server-side
(`FIRST_TREE_DOCS_ENABLED`); commands report HTTP 404 while the flag is off.
Publishing is idempotent on `slug`: the first publish creates the document
(version 1), every later publish of the same slug appends the next version.
The caller's own identity signs every write — agents author under their own
agent name, humans under their member identity.

```
first-tree doc
├── publish <file> [--slug <slug>] [--title <t>] [--project <p>]
│                  [--note <n>] [--status <s>] [--if-changed]   # create or append a version
├── get <slug> [--version <n>]                                  # read metadata + markdown content
├── list [--project <p>] [--status <s>] [--limit <n>] [--cursor <c>]
├── comments <slug> [--status open|resolved] [--version <n>]
│                   [--watch [seconds]]                         # list; --watch streams new ones as JSON lines
├── comment <slug> <body> [--quote <exact> [--prefix <t>] [--suffix <t>]] [--version <n>]
├── reply <commentId> <body>                                    # reply in a thread
├── resolve <commentId> [--reopen]                              # close (or reopen) a thread
├── status <slug> [--set draft|in_review|approved|archived]     # show or move status
├── import <dir> [--project <p>] [--status <s>] [--dry-run]     # bulk-publish a directory of .md files
└── export <dir> [--project <p>] [--status <s>]                 # dump library to <slug>.md files + manifest.json
```

```bash
first-tree doc publish design.md --slug chat-rename --project first-tree --status in_review
first-tree doc comments chat-rename --status open --json
first-tree doc reply <commentId> "Addressed in v2 — see §3"
first-tree doc resolve <commentId>
first-tree doc publish design.md --slug chat-rename --note "responds to review round 1"
first-tree doc status chat-rename --set approved
```

Slug defaults to the slugified filename; title defaults to the file's first
markdown heading (required on the first publish). Comment anchors are
TextQuoteSelector-style (`exact` / `prefix` / `suffix`) against the markdown
source, so an agent can locate every comment in the file it holds without
line-number conventions. Comments whose quote no longer exists in the latest
version come back with `outdated: true` (computed on read). `import` skips
`NODE.md` / `README.md` index files and is idempotent (re-runs only add
versions for changed content); `export` is the guaranteed way out — plain
markdown files plus a `manifest.json` of metadata.

---

## github

GitHub entity attention for the current chat. `follow` wires an entity's
webhook event stream into the chat (one routing line, chat-scoped);
`unfollow` explicitly stops this chat from tracking the entity and severs
every line wired into the chat for that entity, however it was created.
Creating a PR or issue never follows it automatically — declare the
dependency explicitly, immediately after creation. Use
`first-tree github follow --help` / `first-tree github unfollow --help`
for the full flag surface and conflict handling.

```
first-tree github
├── follow <entity> [--chat <chatId>] [--rebind]    # route the entity's events into the chat
├── unfollow <entity> [--chat <chatId>]             # sever all of the chat's lines for the entity
└── following [--chat <chatId>] [--json]            # list entities wired into the chat
```

```bash
# Inside an agent session the chat is inferred from FIRST_TREE_CHAT_ID
first-tree github follow https://github.com/acme/api/pull/42
first-tree github follow acme/api#42        # issue vs PR resolved automatically
first-tree github follow acme/api@3f2a91c   # commit
first-tree github following
first-tree github unfollow acme/api#42
```

`<entity>` accepts a full GitHub URL, `owner/repo#N`, or `owner/repo@<sha>`.
A `409` means the same (human, delegate) line already lives in another chat
— `--rebind` MOVES it here (a line is never duplicated). `unfollow` is
idempotent: `removed: 0` is success, not an error. Requires the org's
GitHub App installation to cover the repo (`422` otherwise).

---

## gitlab

GitLab Issue and Merge Request attention for the current chat. The commands
operate entirely on First Tree's local webhook projection: they never call the
GitLab API, validate an entity live, or use the current `glab` account.

```
first-tree gitlab
├── follow <issue-or-mr-url> [--chat <chatId>] [--agent <name>]
├── following [--chat <chatId>] [--agent <name>]
└── unfollow <issue-or-mr-url> [--chat <chatId>] [--agent <name>]
```

```bash
# Inside an agent session the chat is inferred from FIRST_TREE_CHAT_ID
first-tree gitlab follow https://gitlab.example/acme/api/-/issues/42
first-tree gitlab follow https://gitlab.example/acme/api/-/merge_requests/42
first-tree gitlab following
first-tree gitlab unfollow https://gitlab.example/acme/api/-/issues/42
```

`follow` accepts only a full Issue or Merge Request URL from the Team's one
configured GitLab instance. It records a pending declaration without provider
egress; the next matching valid webhook supplies numeric project identity and
activates the declaration. Repeating a follow in the same chat is idempotent,
and the same entity may be followed independently by multiple chats. A pending
declaration reports `state: null` because First Tree has not verified provider
state. There is no GitHub-style `--rebind` or `context-review` command.

`following` returns every active binding in the chat as a stable public
projection, including automatic reviewer / assignee / mention routing and
explicit `agent_declared` / `human_declared` rows. Pending declarations and
active webhook-observed bindings report their corresponding status. Internal
connection, organization, mapping, actor, identity, and normalized-path
identifiers are not returned.

`unfollow` is URL-based and idempotent: `removed: 0` is terminal success. It
removes every automatic or manual binding for that entity in the current chat.
A later explicit reviewer, assignee, or mention event may create a new route.
After a project rename, use the current URL returned by `following`; the
inbound-only service cannot resolve an arbitrary old path back to a numeric
project identity.

These commands control First Tree chat attention. Native GitLab
subscribe/unsubscribe operations control only the authenticated GitLab
account's personal notifications and are not a replacement for chat follow.

---

## org

```
first-tree org
├── bind-tree <url> [--org <orgId>] [--branch <branch>] # legacy caller-org binding write
└── context-tree [--agent <name>]                    # read the current agent org's Context Tree binding
    ├── review-config [--agent <name>]                # read live binding + Reviewer assignment
    └── set <repo> [--branch <branch>] [--agent <name>] # set the selected agent org binding
```

`bind-tree` records the team's Context Tree URL in
`organization_settings(context_tree)`. Used by the onboarding flow's
"create new tree" path, where the agent calls back into the server
after scaffolding the tree. It is retained for compatibility with existing
scripts: without `--org`, it resolves the caller's default organization through
`GET /api/v1/me`; with `--org`, it targets the explicitly supplied organization
ID. `--branch` is optional and sends an explicit branch when a recovery path must
reproduce an exact repo/branch binding; when omitted, the server preserves the
existing branch or defaults to `main`. It is not agent-scoped and is separate
from `context-tree set` below.

The Class B settings read `GET /api/v1/orgs/:orgId/settings/context_tree`
returns the same runtime-safe binding representation for admins and members. If
a row has no repo and a valid retained branch, this safe read returns the
unbound branch-only representation. If a loose historical repo or branch is not
valid under the active binding contract, the safe read fails without returning
the raw value. Loose historical rows that are visible for repair are exposed
only through the admin-only raw read
`GET /api/v1/orgs/:orgId/settings/context_tree/raw`.

### org context-tree

```bash
first-tree org context-tree [--agent <name>]
```

`context-tree` is a read-only view of the Cloud `context_tree` setting for the
selected agent's organization. It does not accept `--org`: the CLI sends the
selected agent as `X-Agent-Id`, and the server derives that agent's
organization. The command reads only `GET /api/v1/agent/context-tree/info`.
It never falls back to the user's default organization from `/me`, the legacy
`/api/v1/context-tree/info` endpoint, the web app's current organization, or a
local workspace manifest or checkout.

The selected agent is resolved in this order:

1. `--agent <name>` selects that named local agent.
2. `FIRST_TREE_AGENT_ID` selects the local agent whose configured UUID matches
   the environment value.
3. When exactly one local agent is configured, that agent is selected.

Selection fails before any network request with exit code `2` when there is no
local agent (`MISSING_AGENT`), more than one candidate (`AMBIGUOUS_AGENT`), an
environment UUID that is not local (`ENV_AGENT_NOT_LOCAL`), or an unknown
explicit name (`UNKNOWN_AGENT`). An explicit `--agent` takes precedence over
`FIRST_TREE_AGENT_ID`.

Human output reports one of three states. `Bound` includes the repository and
branch. `Unbound` advises the user to ask an administrator for that agent's
organization to bind an existing tree or initialize a new one. `Unreadable`
means the agent-scoped request failed or its response could not be validated; a
failed read is never reported as `Unbound`. A loose invalid historical setting
is projected as inactive by the agent/runtime endpoint, while the safe settings
GET returns a non-secret conflict and the admin raw endpoint preserves the
value for repair.

With `--json` or `FIRST_TREE_JSON=1`, successful output is exactly one of:

```json
{"ok":true,"data":{"status":"bound","repo":"git@github.com:acme/context-tree.git","branch":"main"}}
{"ok":true,"data":{"status":"unbound","repo":null,"branch":null}}
```

`repo` alone determines binding state. An unbound response is normalized to
`branch: null` even if the server supplies its default branch. A bound response
with a null branch is normalized to `"main"`.

Authentication, connection, timeout, remote, response-validation, and
unexpected read failures use the following JSON error shape and a non-zero exit
code:

```json
{"ok":false,"error":{"code":"CONTEXT_TREE_UNREADABLE","message":"...","status":"unreadable"}}
```

Authentication failures exit `3`; connection and timeout failures exit `6`;
other remote or invalid-response failures exit `1`. Agent-selection failures
retain exit code `2` and their existing error envelopes.

### org context-tree review-config

```bash
first-tree org context-tree review-config [--agent <name>]
```

`review-config` reads the bound repository/branch and the Context Reviewer
assignment from the same agent-scoped server response. It reports `Off`,
`Assigned`, or `Not assigned` for the selected runtime Agent. Managed review
tasks rerun this command before every repair, GitHub projection, and merge
mutation; an unbound Tree, disabled feature, or different assigned Agent fails
closed. The command contains no review mode or merge-method setting: managed
Context Review always uses the assigned Reviewer Agent and exact-head squash.

### org context-tree set

```bash
first-tree org context-tree set <repo> [--branch <branch>] [--agent <name>]
```

`context-tree set` directly sets or replaces the Cloud `context_tree` binding
for the selected local agent's organization. It does not accept `--org` or
`--rebind`, and it provides no unset/clear operation. Agent selection uses the
same precedence and exit-code-`2` failures as the read command above:
explicit `--agent`, then `FIRST_TREE_AGENT_ID`, then the only configured local
agent. Selection failures retain their existing `MISSING_AGENT`,
`AMBIGUOUS_AGENT`, `ENV_AGENT_NOT_LOCAL`, or `UNKNOWN_AGENT` envelopes; they
are not wrapped as `CONTEXT_TREE_UPDATE_FAILED`. Selection is completed before
the SDK is created or any credentials or network are accessed.

The command performs a two-step, agent-scoped write. It first sends
`GET /api/v1/agent/me` with the selected agent to obtain a non-empty
`organizationId`, then sends the existing admin-only Class B request
`PUT /api/v1/orgs/:orgId/settings/context_tree`, URL-encoding `orgId`. The
selected agent identity, current user JWT, and current runtime-session token are
used for both requests. This write flow does not call either Class B settings
GET and never falls back to `/api/v1/me`, the legacy
`/api/v1/context-tree/*` endpoints, the web app's current organization, a local
workspace manifest, or a local checkout. The agent-profile GET may use the
client's normal read retry behavior. The PUT is never retried automatically, so
one invocation cannot repeat a settings-version increment after an ambiguous
transport failure.

`<repo>` accepts HTTPS, `ssh://`, and scp-like SSH repository coordinates. The
value must have a host and repository path, contain no embedded credentials,
have no surrounding whitespace, and contain no control characters. URL forms
must use literal `https://` or `ssh://` syntax; queries, fragments, backslashes,
and local drive paths are rejected. HTTP and `git://` URLs are rejected.
`--branch` must be a valid Git branch name. In addition to being non-empty,
single-line, and free of surrounding whitespace and control characters, it
must satisfy Git ref-format rules such as rejecting `..`, `@{`, components
that start with `.` or end with `.lock`, a branch name that starts with `-`,
and forbidden ref characters. Invalid repo and branch values fail locally with
`INVALID_CONTEXT_TREE_REPO` and
`INVALID_CONTEXT_TREE_BRANCH`, respectively, exit `2`, and make no SDK,
credential, or HTTP request.

For example, these repository forms are accepted:

```text
https://github.com/acme/context-tree.git
ssh://git@github.com/acme/context-tree.git
git@github.com:acme/context-tree.git
```

When `--branch` is omitted, the request body contains only `{ "repo": "..." }`
and an existing valid branch is preserved. On a first binding, the server's
default branch is `main`. Supplying `--branch` replaces the branch. If a loose
historical row contains an invalid branch, a repo-only update is rejected
without a partial write; repair it by supplying both the repository and a
valid `--branch`. A successful response must explicitly contain a valid repo
and branch, must echo the requested repository, and must echo a provided
branch; missing fields, unknown fields, mismatches, and otherwise invalid
responses are update failures.

Human output reports `Bound` and shows the repository and final branch. With
`--json` or `FIRST_TREE_JSON=1`, successful output is exactly:

```json
{"ok":true,"data":{"status":"bound","repo":"git@github.com:acme/context-tree.git","branch":"main"}}
```

After local agent selection and input validation, all authentication,
connection, timeout, HTTP, response-validation, and unexpected failures use
this exact error envelope:

```json
{"ok":false,"error":{"code":"CONTEXT_TREE_UPDATE_FAILED","message":"..."}}
```

Authentication failures exit `3`; connection and timeout failures exit `6`;
403, other HTTP failures, and invalid or inconsistent responses exit `1`.
When a network or server failure leaves the PUT result uncertain, the message
directs the operator to rerun `first-tree org context-tree` with the same agent
selection before retrying. Failure output never prints raw response bodies,
tokens, credentials, or a full private repository coordinate; successful
output includes the requested repository as documented above.

For this write command, debug logs may identify the selected agent, request
phase, derived organization, and final status. Warning logs contain only the
sanitized failure category, exit code, and HTTP status; they do not contain
secrets or raw response data.

---

## daemon

The background service that holds the client WebSocket and runs every
configured agent on this machine. Installed automatically by `first-tree
login` on supported desktop platforms: launchd on macOS, systemd on
Linux, and a per-user Task Scheduler logon task on Windows. Linux installs
use a `systemd --user` unit for normal users; when the CLI is run as root,
First Tree installs the same channel's unit in system scope instead
(`/etc/systemd/system/<channel>.service`) so daemon setup does not depend
on a root user D-Bus session.

On Windows, Task Scheduler only owns per-user logon/start triggering. A hidden
First Tree supervisor loop owns the daemon child process, exit-code restart
policy, stop intent, runtime marker PID, and logs. This is not a Windows
Service / WinSW install and does not run before the Windows user logs in.

```
first-tree daemon
├── start [--no-interactive] [--foreground]
├── stop
├── restart
├── status
├── doctor
├── probe [--no-upload] [--json]
├── install-codex [--spec <spec>] [--json]
└── install-claude [--spec <spec>] [--json]
```

| Subcommand | Purpose |
|---|---|
| `start` | Start the daemon and connect every configured agent to the server. **Fail-closed**: exits 1 with `NO_CREDENTIALS` if no `credentials.json` exists; run `login` first. `--foreground` runs in the current shell (for debugging); the default installs/starts the service. |
| `stop` | Stop the service (preserves auto-start; bring it back with `start`). |
| `restart` | Restart the service. |
| `status` | Local service state + server binding + auth health. Runs in well under a second. |
| `doctor` | Walk Node version, config, server reachability, WS, agent registrations, the installed service file, **and the runtime providers** — each step reported. The runtime-provider rows run the real launch-verified probe (a 1-turn model call for `claude-code`, a `codex doctor` handshake for `codex`), so `doctor` makes live provider calls; it is a deliberate diagnostic, not a hot path. |
| `probe` | Launch-probe the local runtime providers on demand and upload the result to the server (`PATCH /clients/:id/capabilities`). This is the manual refresh for a client's advertised capabilities after a provider is installed / logged in. Each probe really launches its provider. `--no-upload` runs a **credentials-free local-only** diagnostic (probe + print, no server auth needed). `--json` (or the global `--json`) emits the capability snapshot as the machine-readable `{ ok, data }` envelope on stdout. |
| `install-codex` | Install the native Codex runtime engine on this machine (`npm install -g @openai/codex`). First Tree does not bundle the ~225MB native `codex` binary by default — the runtime resolves an external `codex` from PATH, known install locations, or the macOS ChatGPT/Codex desktop app — so this is the on-demand remediation when the `codex` capability probes as `missing`. Runs the same tracked-subprocess install path as self-update, then re-probes so the freshly installed binary is reflected. Purely local (no credentials). `--spec <spec>` picks an npm dist-tag or exact version (default `latest`); `--json` emits the post-install capability snapshot as the `{ ok, data }` envelope. |
| `install-claude` | Install the native Claude Code runtime engine on this machine (`npm install -g @anthropic-ai/claude-code`). First Tree does not bundle the ~210MB native `claude` binary by default — the runtime resolves a system `claude` (env override / PATH / well-known install dirs) — so this is the on-demand remediation when the `claude-code` capability probes as `missing`. Runs the same tracked-subprocess install path as self-update, then re-probes so the freshly installed binary is reflected. Purely local (no credentials). `--spec <spec>` picks an npm dist-tag or exact version (default `latest`); `--json` emits the post-install capability snapshot as the `{ ok, data }` envelope. |

**Capability refresh timing.** The daemon launch-probes runtime providers at
startup and re-probes automatically on every WebSocket reconnect. A full real
re-probe of all providers runs only when there is no prior snapshot or one is
older than 24h; otherwise each provider is re-validated individually — a
still-launchable, still-logged-in provider keeps its prior `ok` for free
(resolve + auth re-checked, no session smoke re-run), a provider that lost its
binary or login downgrades, and a non-ok provider is fully re-probed so it can
recover. So a machine missing an optional provider (e.g. no tmux for
`claude-code-tui`) does not re-smoke its healthy providers on every reconnect.

**While the daemon stays connected**, it also runs a bounded background
re-probe whenever any provider is not yet `ok` — so installing or logging into
a provider is noticed within a bounded time without a restart or reconnect. The
poll starts ~15s after the degraded state is seen and backs off to a 5-minute
ceiling, re-probes only the non-`ok` providers (already-`ok` ones stay on the
free cached path), uploads only when the snapshot actually changes, and stops
once every provider is `ok`. `daemon probe` remains the manual, on-demand path
to force an immediate full re-probe + upload.

The top-level `first-tree status` is the cross-subsystem overview that
calls `daemon status` internally and adds server/auth/agent rows.

---

## config

Read and write this machine's `client.yaml`. The file lives at
`~/.first-tree/config/client.yaml` (or the staging/dev channel's
equivalent — see [docs/development/local-dev-isolation.md](development/local-dev-isolation.md)).

```bash
first-tree config show                    # every key/value
first-tree config show server.url         # dotted-key read
first-tree config show --show-secrets     # un-mask sensitive fields
first-tree config set update.policy auto
first-tree config get update.policy       # alias for `show <key>`
```

Agent-side runtime configuration (model / prompt / MCP / env / repos) is
not here — it lives in `first-tree agent config ...` and mutates the
server-side `agent_configs` row through the Admin API.

---

## tree

Context Tree creation, structural validation, and hierarchy browsing. The
`tree` namespace carries `verify`, `tree`, and `init`; the rest (`migrate` /
`upgrade` / `status` / `codeowners` / `claude-hook` / `inject` / `review` /
`automation` / `skill` groups) was retired in the 2026-06 cleanup because the
cloud now owns workspace + tree provisioning and the client runtime inlines its
own skill payload install (see PR following #844).

```
first-tree tree
├── init [options]                           # create a new team Context Tree repo with local gh
├── verify [--tree-path PATH]                # validate a Context Tree repo
└── tree [path] [-L depth] [-P pattern]      # browse Context Tree nodes as a hierarchy
```

`first-tree tree init` creates a brand-new team Context Tree repository with the
user's local `gh`: it creates the repo (one path for user- and org-owned repos),
scaffolds a minimal valid tree (root `NODE.md` + members index + a creator member
node), self-verifies before pushing, pushes, and — unless `--no-bind` — binds the
org's `context_tree` setting and surfaces guidance for adding the repo to the
team's GitHub App installation. It does not seed `.github/workflows/validate-tree.yml`
by default (that needs the interactive `workflow` gh scope); pass `--with-workflow`
to include it. In the bound path the repo is created under the team's GitHub App
installation account (so the installation can cover it), and any explicit `--owner`
is canonicalized before the remote create so case-variant input does not fail after
GitHub has already accepted the repository. If create succeeds but binding or
finalization fails, the CLI says the repo was created but not bound, includes the
repo URL, and tells you to delete it manually if it is empty; it does not auto-delete
created repositories by default. `tree init` refuses to replace an existing team
binding unless `--rebind` is passed. Non-rebind finalization is conflict-safe: if
another writer binds the org after preflight but before the local GitHub side
effects finish, the server preserves that competing binding and `tree init`
reports the conflict rather than overwriting it. A non-`--rebind` invocation
requires a Server with the raw repair/finalize surface during preflight; older
Servers fail before any GitHub repository is created. Key options: `--owner`,
`--name`, `--title`, `--public`, `--dir`, `--with-workflow`, `--no-bind`,
`--rebind`, `--org`. Run `first-tree tree init --help` for the full list.

Before any GitHub repository write, the bound path reads the admin-only raw
Context Tree setting. An HTTP 404 from that endpoint identifies an older Server
without conditional-finalization support, so the command uses the legacy safe
settings GET to classify the current state. A valid active binding still gets
the normal existing-binding refusal; if the fallback confirms an unbound state,
a non-`--rebind` invocation fails before looking up the GitHub App installation
or creating a repository and requires a Server upgrade. With `--rebind`, the
caller has explicitly authorized replacement and may continue through the
compatible legacy write. Invalid fallback data and every other raw-read failure
remain fail-stop.

A valid branch-only setting remains unbound. Its branch is retained exactly and
used for `git init`, the generated validation workflow filter, the final
repo-and-branch binding, and the success summary; an absent setting uses
`main`. Any invalid historical repo or branch fails closed before repository
creation so an administrator can repair it without leaving remote side
effects.

Without `--rebind`, final binding uses the dedicated admin-only endpoint:

```http
POST /api/v1/orgs/:orgId/settings/context_tree/initialize
Content-Type: application/json

{"repo":"https://github.com/acme/tree.git","branch":"trunk","expectedUnboundBranch":"trunk"}
```

The Server acquires the organization settings parent lock and commits only if
the setting is still unbound at exactly `expectedUnboundBranch`, the branch read
during preflight. A competing full binding or branch-only change returns 409
and is left unchanged. This dedicated endpoint also prevents an older Server
from interpreting conditional finalization as an ordinary unconditional
settings write. `--rebind` intentionally bypasses this compare-and-set path and
uses the generic `PUT /api/v1/orgs/:orgId/settings/context_tree` with only
`repo` and `branch` to replace the binding directly. The CLI strictly validates
the final response before reporting success.

Repository creation and push happen before final binding, so a finalization
failure can leave the new repository unbound. When that happens, the CLI says
the repository was created but not bound, includes the repo URL, and tells you
to delete an empty repo manually instead of relying on the command to clean it
up. A 409 from the non-rebind finalization POST has a known conflict outcome:
the competing setting was preserved, and the CLI requires reading the
organization's current Context Tree setting first without suggesting a retry or
overwrite command. A finalization 404 during a rolling Server change reports
that no binding was written and requires an upgrade plus read-back, also
without an overwrite command. Other HTTP failures require read-back before
retrying. A network failure, timeout, or invalid/unconfirmed response has an
unknown write outcome and likewise requires read-back first.
The error identifies the exact organization, repository, and retained branch.
For an unknown outcome it also shows the exact recovery form `first-tree org
bind-tree <repo> --org <orgId> --branch <branch>`, but explicitly makes running
it conditional on read-back first confirming that the setting is still
unbound.

`first-tree tree verify` applies the current strict structural policy. Normal
content requires parseable YAML frontmatter with non-empty `title` and `owners`;
`description` and `soft_links`, when present, must have valid shapes. The
separate member-node contract remains in force, while archive/supporting and
repo-infrastructure Markdown are not treated as normal nodes.

Broken `soft_links`, tree-local path escapes, and normal links into
`raw-context/` fail verification. Markdown links are parsed structurally, but
an otherwise tree-local Markdown target may be absent; external links, anchors,
and plain prose that explains the archive class remain allowed. JSON output
preserves the existing summary and adds stable findings plus per-class scan
counts. Context Tree domain directories must not be symlinks; Markdown file
symlinks are validated, must resolve to regular Markdown files, and must stay
inside the tree without crossing content classes, except for the managed
root-level `WHITEPAPER.md` pointer. That historical runtime-managed pointer
remains exempt for compatibility only; writers must not add it to new trees.
This is a breaking tightening for trees that relied on legacy metadata
or normal-to-archive links: mechanical syntax can be corrected directly, while
ownership assignments and promotion of durable archive content require human
or source-backed decisions. Run `first-tree tree verify --help` for options.

`first-tree tree tree [path]` resolves `path` relative to the current
working directory, then renders from the current git repository root down
to that target directory and its descendants. Without `path`, the target is
the current directory. The target must be an existing directory inside the
current git repo.

Directory nodes come from that directory's `NODE.md`. Leaf nodes come from
Markdown files other than `NODE.md`, `AGENTS.md`, and `CLAUDE.md`. A
Markdown file is renderable only when its YAML frontmatter has a non-empty
string `title` and a non-empty array `owners`; `description` is optional.
The `owners` field is used for filtering and included in JSON, but is not
shown in human output. Hidden paths and common generated directories
(`node_modules`, `__pycache__`, `dist`, `build`, `.next`, `.turbo`) are
skipped.

Human output starts with the Context Tree git checkout branch, then the
rendered tree. When the current branch is not exactly `main`, `master`, or
`origin/main`, the branch line is followed by a stale-tree warning:
Detached HEAD checkouts whose commit matches `refs/remotes/origin/main` are
reported as `origin/main`.

```text
Branch: feature/stale-tree
Warning: current branch "feature/stale-tree" is not main/master; it may be stale. Switch to main/master.
```

The rendered tree's node labels use:

```text
relative/path/ [Title] -> Description
relative/path.md [Title]
```

Directory labels end with `/`. The repository root line uses the repo
directory name, for example `context-tree/ [Context Tree] -> Root
index for the First Tree context tree.`. When `description` is missing,
the `-> Description` suffix is omitted.

Options:

- `-L, --level <depth>` — maximum descendant depth below the target directory. Ancestors from the git repo root to the target are always kept. For path-tolerant CLI use, `tree tree -L docs/development` is treated as `tree tree docs/development`; `tree tree -L 2 docs/development` applies depth `2` to that path.
- `-P, --pattern <pattern>` — case-sensitive shell-style glob filter matched against relative path, filename, `title`, and `description`; matching descendants keep their ancestors visible.

With global `--json` or `FIRST_TREE_JSON=1`, `first-tree tree tree`
emits a single `{ ok: true, data }` envelope on stdout. `data.root` is the
git repo root, `data.target` is the resolved target directory relative to
that root, and `data.options` records the parsed `level`, `pattern`, and
effective `path`. `data.branch` reports the current tree checkout as
`{ name, isMainline, warning }`; `warning` is `null` for `main`, `master`,
and `origin/main`, including detached HEAD checkouts that match
`refs/remotes/origin/main`; otherwise it contains the same stale-tree warning
string shown in human mode. `data.tree` contains the same filtered hierarchy as
structured nodes with `kind`, `name`, `relativePath`, `depth`, `metadata`,
`hasNode`, and `children` fields; `metadata` includes `title`, optional
`description`, and `owners`. Human tree text and branch warnings are not
written to stderr in JSON mode, so stdout stays reserved for machine-readable
JSON.

## Environment variables

Most environment variables use the `FIRST_TREE_` prefix.

### CLI — operator-facing

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_HOME` | Override the CLI home directory for config, data, and agent workspaces. | Channel-dependent: `~/.first-tree` (prod), `~/.first-tree-staging` (staging), `~/.first-tree-dev` (dev). |
| `FIRST_TREE_SERVER_URL` | Server URL override for `login <code>` and fallback for other commands; otherwise `login` uses the CLI channel default. | — |
| `FIRST_TREE_LOG_LEVEL` | Log level (`trace` / `debug` / `info` / `warn` / `error` / `fatal`). | `info` |
| `FIRST_TREE_JSON` | JSON output mode (equivalent to `--json`). | — |

### Daemon environment file (`daemon.env`) — user-owned

A launchd / systemd / Task Scheduler daemon does **not** inherit your
interactive login-shell environment, so anything your shell exports (commonly
an `HTTP_PROXY` / `HTTPS_PROXY` for users behind a network proxy, or
`FIRST_TREE_CLIENT_SENTRY_ENABLED=false` for Client Sentry opt-out) is invisible
to the background daemon and the agent runtimes it spawns. That is why an
interactive `claude` / `git` can work while the daemon's calls to
`api.anthropic.com` / `github.com` fail.

To supply that environment, create `daemon.env` under your channel's
`FIRST_TREE_HOME` with simple `KEY=VALUE` lines. **The path is channel-specific**
(`~/.first-tree/daemon.env` on prod, `~/.first-tree-staging/daemon.env` on
staging, `~/.first-tree-dev/daemon.env` on dev) — it must match the channel of
the daemon that reads it:

```sh
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
NO_PROXY=localhost,127.0.0.1
FIRST_TREE_CLIENT_SENTRY_ENABLED=false
```

The daemon loads this file on start and passes the values to every child it
spawns. First Tree is **compatible with** your proxy — it only ever *reads*
this file and never writes your proxy into it on your behalf. Values already
present in the daemon's environment are preserved (the file fills gaps, it does
not override). Edit or delete the file freely, then restart the daemon
(`<channel> daemon stop && <channel> daemon start`) to apply changes. See
[troubleshooting/proxy.md](troubleshooting/proxy.md).

### CLI — internal (set by the CLI for its own subprocesses)

These are mentioned for completeness; operators don't set them in shell rc.

| Variable | Purpose |
|---|---|
| `FIRST_TREE_SERVICE_MODE` | Supervisor → child flag baked into launchd/systemd templates and set by the Windows supervisor loop. |

### CLI / daemon — update behavior

These are client-side update behavior tunables. They do not select a release
channel; channel identity comes from the installed package / binary
(`first-tree`, `first-tree-staging`, or `first-tree-dev`).

| Variable | Purpose |
|---|---|
| `FIRST_TREE_UPDATE_RESTART_CHECK_INTERVAL_SECONDS` | Frequency of the upgrade-restart watchdog. |
| `FIRST_TREE_UPDATE_RESTART_QUIET_SECONDS` | Quiet window the upgrade flow waits for before restarting. |
| `FIRST_TREE_UPDATE_PROMPT_TIMEOUT_SECONDS` | Interactive upgrade prompt timeout. |
| `FIRST_TREE_UPDATE_POLICY` | `auto` / `prompt` / `off`. Persisted via `first-tree config set update.policy ...`. |

### Agent runtime (injected by the daemon into agent processes)

Per-agent bearer tokens are gone — every agent on a signed-in machine
authenticates as the signed-in member. The runtime injects these so an
agent process can talk to the server without extra setup:

| Variable | Purpose |
|---|---|
| `FIRST_TREE_ACCESS_TOKEN` | The signed-in member's access JWT (short-lived). |
| `FIRST_TREE_AGENT_ID` | The agent's own UUID — the CLI uses it to identify the sender. |
| `FIRST_TREE_CLIENT_ID` | The client (machine) the agent is bound to. |
| `FIRST_TREE_CHAT_ID` | The chat the current session is bound to. Used by `chat send` / `chat invite`. |
| `FIRST_TREE_SERVER_URL` | Server URL override; falls back to client config. |

### Server (SaaS internal)

These configure the SaaS server image (`packages/server/dist/index.mjs`)
and are not used by the CLI. They are listed here for ops reference.

**Identity / channel:**

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_CHANNEL` | Deployment channel (`prod` / `staging` / `dev`). | `dev` |
| `FIRST_TREE_DATABASE_URL` | PostgreSQL connection URL. | — (required) |
| `FIRST_TREE_PORT` | HTTP listen port. | `8000` |
| `FIRST_TREE_HOST` | Bind address. | `127.0.0.1` |
| `FIRST_TREE_PUBLIC_URL` | Public-facing server origin. Used to stamp the issuer on short connect codes and to build invite-link URLs plus Google and GitHub OAuth callbacks. **Required in production.** | — |
| `FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL` | Base URL for the prod/staging portable installer and artifact mirror. Do not include a channel suffix; the server appends the channel's `publicInstallerPath` (for example, `prod/install.sh`). | `https://download.first-tree.ai/releases` |
| `FIRST_TREE_CORS_ORIGIN` | Allowed origin for the web console. | — |
| `FIRST_TREE_TRUST_PROXY` | Trust the reverse-proxy `X-Forwarded-*` headers. | `false` |
| `FIRST_TREE_WORKSPACES_ROOT` | Where agent worktrees are materialised on the host. | derived from `FIRST_TREE_HOME` |

**Command update advertisement:**

There is no `FIRST_TREE_UPDATE_CHANNEL`. Published channels have separate npm
package identities, and the server polls the package selected by
`FIRST_TREE_CHANNEL`.

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_COMMAND_VERSION` | Bootstrap CLI version advertised before the npm-registry poller succeeds. The Docker image stamps this from the Command package version at build time. | image build arg |
| `FIRST_TREE_UPDATE_POLL_INTERVAL_MINUTES` | How often the server polls npm for the selected channel package's `latest` version. | `60` |
| `FIRST_TREE_UPDATE_REGISTRY_URL` | npm registry override for the server-side update-version poller. | `https://registry.npmjs.org` |

**Secrets:**

| Variable | Purpose | Production |
|---|---|---|
| `FIRST_TREE_JWT_SECRET` | JWT signing key. `channel=dev` local development auto-generates a value when omitted. | Required for staging/prod |
| `FIRST_TREE_ENCRYPTION_KEY` | AES-256-GCM key for encrypted server-side secrets (GitHub tokens, org-settings secrets). Must be 32 bytes encoded as 64-char hex or base64url. `channel=dev` local development auto-generates a value when omitted. | Required for staging/prod |

The server Docker image sets `NODE_ENV=production`, which disables generated
server secrets even if `FIRST_TREE_CHANNEL` is omitted or defaults to `dev`.

**Auth lifetimes:**

| Variable | Default |
|---|---|
| `FIRST_TREE_AUTH_ACCESS_TOKEN_EXPIRY` | `30m` |
| `FIRST_TREE_AUTH_REFRESH_TOKEN_EXPIRY` | `30d` |
| `FIRST_TREE_AUTH_CONNECT_TOKEN_EXPIRY` | `10m` |

**GitHub App / OAuth:**

| Variable | Purpose |
|---|---|
| `FIRST_TREE_GITHUB_APP_ID` | GitHub App numeric id. |
| `FIRST_TREE_GITHUB_APP_CLIENT_ID` | GitHub App OAuth client id. |
| `FIRST_TREE_GITHUB_APP_CLIENT_SECRET` | GitHub App OAuth client secret. |
| `FIRST_TREE_GITHUB_APP_PRIVATE_KEY` | GitHub App signing key (PEM body). |
| `FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET` | Webhook HMAC secret. |
| `FIRST_TREE_GITHUB_APP_SLUG` | Optional explicit slug override. |

**Google OAuth / OIDC:**

| Variable | Purpose |
|---|---|
| `FIRST_TREE_GOOGLE_CLIENT_ID` | Google OAuth 2.0 Web application client id. |
| `FIRST_TREE_GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 Web application client secret. |

Set both Google variables to enable Google sign-in; omit both to leave the
provider disabled. A partial configuration fails server startup. First Tree
requests only the fixed identity scopes `openid email profile` and does not
persist Google access or refresh tokens.

Register this exact authorized redirect URI in Google Cloud Console:

```text
${FIRST_TREE_PUBLIC_URL}/api/v1/auth/google/callback
```

The scheme, host, port, path, and trailing-slash form must exactly match the
deployed `FIRST_TREE_PUBLIC_URL`. See
[Google OAuth operator setup](development/google-oauth.md) for the full setup
and verification procedure.

**Rate limits:**

| Variable | Default |
|---|---|
| `FIRST_TREE_RATE_LIMIT_MAX` | `3000` |

The server applies this as one actor-aware global safety cap per minute. It
keys by agent id, then user id, then request IP for unauthenticated traffic.
Old per-route rate-limit env vars are no longer read.

**Inbox / WS / archive sweeper:**

| Variable | Default |
|---|---|
| `FIRST_TREE_INBOX_MAX_IN_FLIGHT_PER_AGENT` | server-tuned |
| `FIRST_TREE_WS_MAX_PAYLOAD` | `262144` (256 KiB) |
| `FIRST_TREE_ARCHIVE_SWEEP_INTERVAL_SECONDS` | `300` (set `0` to disable) |
| `FIRST_TREE_ARCHIVE_MAPPED_IDLE_SECONDS` | `3600` |

`FIRST_TREE_ARCHIVE_MAPPED_IDLE_SECONDS` is the GitHub-source archive idle
threshold. Mapped chats also require all bound entities to be closed/merged;
source=github chats with no mapping use the same idle threshold.

**Observability:**

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_LOG_LEVEL` | Server log level. | `info` |
| `FIRST_TREE_OTEL_ENDPOINT` | OTLP/HTTP traces endpoint. Non-empty enables tracing. | `""` |
| `FIRST_TREE_OTEL_HEADERS` | OTLP headers as `key1=val1,key2=val2`. Typically holds the write token. | `""` |
| `FIRST_TREE_OTEL_ENVIRONMENT` | Deployment label emitted as `deployment.environment.name`. | `development` |
| `FIRST_TREE_OTEL_CAPTURE_CLIENT_IP` | Capture client IP attribute on traces. | `false` |
| `VITE_SENTRY_DSN` | Public browser DSN for Web Console errors in the `first-tree-web` Sentry project. | unset |
| `VITE_SENTRY_ENABLED` | Explicit Web Sentry switch; `false` / `0` / `off` disables even when a DSN is present. | enabled when DSN exists |
| `VITE_SENTRY_ENVIRONMENT` | Web Sentry environment label. | host/mode-derived |
| `VITE_SENTRY_TRACES_SAMPLE_RATE` | Web Sentry trace sample rate (`0.0–1.0`). | `0.1` |
| `FIRST_TREE_CLIENT_SENTRY_DSN` | Client daemon/runtime DSN for the `first-tree-client` Sentry project. | unset |
| `FIRST_TREE_CLIENT_SENTRY_ENABLED` | Explicit Client Sentry operator switch; `false` / `0` / `off` disables even when a DSN is present. | enabled when DSN exists |
| `FIRST_TREE_CLIENT_SENTRY_ENVIRONMENT` | Client Sentry environment label. | `NODE_ENV` or `development` |
| `FIRST_TREE_CLIENT_SENTRY_TRACES_SAMPLE_RATE` | Client Sentry trace sample rate (`0.0–1.0`). | `0.05` |
| `FIRST_TREE_GIT_SHA` | Git SHA stamped onto Web/Client Sentry releases and tags when provided by CI. | `unknown` |

See [observability.md](observability.md) for the full config reference, backend cheat sheet, and troubleshooting recipes.

---

## Directory layout (CLI home)

```
~/.first-tree/                                     # FIRST_TREE_HOME default for the prod channel
├── config/
│   ├── client.yaml                                # this machine's client config (server.url, client.id)
│   ├── credentials.json                           # access + refresh JWT (mode 0600)
│   └── agents/
│       └── <name>/
│           └── agent.yaml                         # agentId + runtime
├── data/
│   ├── context-tree-repos/                        # legacy shared Context Tree pool (retained for old installs; new clones live per-agent)
│   ├── sessions/                                  # per-agent session registry
│   └── workspaces/
│       └── <agent-name>/                          # per-agent home (cwd is shared across chats)
│           ├── context-tree/                      # agent-managed Context Tree clone (agent clones/pulls it per its briefing)
│           └── worktrees/                         # per-task worktrees the agent creates and cleans up
└── logs/                                          # daemon stderr / stdout (macOS)
```

When `FIRST_TREE_HOME` is set, replace `~/.first-tree/` with that location. Staging and dev channels use `~/.first-tree-staging/` and `~/.first-tree-dev/` respectively as their channel-default home.

## Config resolution order

Priority from high to low:

1. CLI arguments
2. Environment variables (`FIRST_TREE_*`)
3. Config files (`~/.first-tree/config/client.yaml`, or the staging/dev channel's equivalent)
4. Built-in defaults

## Verification after upgrade

After `first-tree upgrade` or after running `logout` + `login <code>` on a deployment-bump cycle:

```bash
first-tree status          # CLI version + service + server + auth + agents
first-tree daemon doctor   # service + agent configs + WS reachability
first-tree --help          # top-level verbs + namespaces
```
