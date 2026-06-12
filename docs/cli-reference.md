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

```bash
npm install -g first-tree
first-tree --version
```

The binary lives at `first-tree`; the short alias `ft` is also installed.
Requirements: Node.js ≥ 22.13 (24 recommended).

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
├── login <token>            Sign this computer in
├── logout                   Stop the daemon and clear credentials
├── status                   CLI + daemon + server + auth + agent overview
├── doctor                   Cross-subsystem readiness check
├── upgrade                  Self-update + restart the daemon
├── agent ...                Agent management (config, bindings, sessions, messaging)
├── chat ...                 Chats and messaging (create, send, list, history, open)
├── org ...                  Organization-level operations
├── daemon ...               Background daemon (start, stop, status, doctor)
├── config ...               View/modify this machine's client.yaml
└── tree ...                 Validate and browse Context Trees
```

---

## login

```
first-tree login <token> [--no-start] [--override]
```

Sign this computer in using a connect token from the web console. The
token's `iss` claim carries the server URL — no `--server` flag needed,
and switching to a different deployment only requires a fresh token.

| Flag | Effect |
|---|---|
| `--no-start` | Write credentials and exit without installing/starting the background daemon. |
| `--override` | Take over this machine from a different account: rotates the local client identity (backs up `client.yaml`) and registers a fresh clientId. No server-side ownership transfer happens; the previous account's client entry stays until that account removes it. |

## logout

```
first-tree logout [--purge]
```

Stop the daemon and clear credentials. `--purge` additionally removes
`client.yaml` (server URL, generated `client.id`); the default keeps it
so the next `login` reuses the same `client.id`.

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
first-tree upgrade [--check] [--latest] [--no-restart]
```

Self-update for the CLI: query the configured server for its recommended
Command version, install that exact version globally, refresh the systemd
unit / launchd plist on top of the new bits, then restart the client
service. Use `--latest` only when you intentionally want to bypass the
server target and install npm latest directly.

| Flag | Effect |
|---|---|
| `--check` | Only check for an available version; print "update available" or "already on latest". Do not install. |
| `--latest` | Bypass the server target and query npm for the package's latest published version. |
| `--no-restart` | Install the new version and refresh the unit file, but leave the running service alone. Used for staged rollouts. |

Refusing to run from a source checkout (anywhere under a `.git`
ancestor) is intentional — keeps a dev build from accidentally
`npm i -g`-overwriting a prod global. For local development use
`scripts/dev-install.sh` (see [docs/development/local-dev-isolation.md](development/local-dev-isolation.md)).

---

## agent

Agent management — local config, bindings, sessions, messaging
debug helpers.

```
first-tree agent
├── list [--remote] [--org <id>]
├── add --agent-id <uuid>
├── create <name> --type <t> --client-id <id> [--runtime <r>] [--display-name <s>] [--org <id>]
├── claim <agentName>
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
first-tree agent create <name> --type <human|agent> --client-id <thisClient> [--runtime claude-code|codex]
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

### agent claim

```
first-tree agent claim <agentName>
```

Become the manager of an agent. Admins can reassign any agent in their
org; non-admins can self-claim an unmanaged agent.

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

### agent bind

```
first-tree agent bind
└── client <agentName> --client-id <id>             # first-time bind only; id is immutable once set
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
│     --request / --subject / --question / --option #  first message is a tracked ask; exactly one --to human
├── send <name> [message]                            # recipient is any participant (agent or human)
│     --request / --subject / --question / --option  #   structured ask directed at a human
│     --answer <requestId>                           #   resolve a question you asked: body = the answer, clears their red-dot
│     --close <requestId>                            #   withdraw a question you asked: body = the reason (re-asking opens a NEW question)
│     --reply-to <messageId>                         #   thread a reply under a message (pure threading; does not resolve a question)
├── invite <agentName>                               # add to FIRST_TREE_CHAT_ID before same-task send
├── list
├── history <chatId>
├── set-topic [topic]                                # set/clear topic + description (chat self-description)
│     --clear                                        #   clear the topic (falls back to auto-derived title)
│     --description <text> / --clear-description     #   set/clear the running work-state summary
│     --chat <chatId> / --agent <name>               #   target another chat / the named agent
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
# exactly one human. The message body is the background/context; --subject is
# the dock/card headline (≤80 chars), and --question is only the ask (≤200 chars).
first-tree chat create --to alice --request \
  "Migration 0021 drops the legacy column — irreversible." \
  --subject "Migration gate" \
  --question "Ship the destructive migration?" \
  --option "Ship" --option "Hold"

# Inline
first-tree chat send code-agent "ship the PR"

# Stdin (multiline, markdown, special chars)
echo "long body" | first-tree chat send code-agent -f markdown

# Ask a human a tracked question (red-dot until answered). --request must
# target a single human; the body carries context, --subject is the headline
# (≤80 chars), and --question carries only the ask (≤200 chars).
first-tree chat send alice --request \
  "Migration 0021 drops the legacy column — irreversible." \
  --subject "Migration gate" \
  --question "Ship the destructive migration?" \
  --option "Ship" --option "Hold"

# If --question exceeds 200 chars, the CLI exits with QUESTION_TOO_LONG.
# If --subject exceeds 80 chars, the CLI exits with SUBJECT_TOO_LONG.

# Thread a reply under a message (pure threading; does NOT resolve a question)
first-tree chat send alice --reply-to <messageId> "Holding — will split the migration."

# Resolve an open question you asked the human (marks answered, clears their red-dot; body = the answer)
first-tree chat send alice "Ship it — go ahead with migration 0021." --answer <requestId>

# Withdraw an open question you asked (body = the reason; re-asking opens a NEW question, never auto-supersedes)
first-tree chat send alice "Superseded — splitting the migration first." --close <requestId>

# Pull a non-member into the current chat first, then send normally. Use this
# for same-task stage / role handoffs.
first-tree chat invite code-agent
first-tree chat send code-agent "now we can talk"

# Browse
first-tree chat list
first-tree chat history <chatId>

# Self-description: a short topic label + a longer running work summary,
# both set through set-topic. Agents read descriptions via `chat list` to
# self-locate across threads (see the agent briefing's "Chat Topic & Description").
# Owner-gated: the chat's creator may set topic/description, and when no agent
# owner is present (human-created chats — Web / GitHub-sourced — or the creator
# left) every worker agent counts as the owner; a non-owner agent in a chat
# whose agent creator is still present is refused with 403.
first-tree chat set-topic "review PR #916"
first-tree chat set-topic --description "reviewing PR #916; addressing review findings, re-verifying"
first-tree chat set-topic "ship plan" --description "drafting; waiting on QA"
first-tree chat set-topic --clear-description

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

## github

GitHub entity attention for the current chat. `follow` wires an entity's
webhook event stream into the chat (one routing line, chat-scoped);
`unfollow` declares the task's attention over and severs every line wired
into the chat for that entity, however it was created. Creating a PR or
issue never follows it automatically — declare the dependency explicitly,
immediately after creation. Decision guidance (when to follow / not
follow / unfollow, 409 handling) lives in the `first-tree-github` skill.

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

## org

```
first-tree org
└── bind-tree <url>                                  # record this org's Context Tree repo URL
```

`bind-tree` records the team's Context Tree URL in
`organization_settings(context_tree)`. Used by the onboarding flow's
"create new tree" path, where the agent calls back into the server
after scaffolding the tree.

---

## daemon

The background service that holds the client WebSocket and runs every
configured agent on this machine. Installed automatically by `first-tree
login` on macOS / Linux.

```
first-tree daemon
├── start [--no-interactive] [--foreground]
├── stop
├── restart
├── status
└── doctor
```

| Subcommand | Purpose |
|---|---|
| `start` | Start the daemon and connect every configured agent to the server. **Fail-closed**: exits 1 with `NO_CREDENTIALS` if no `credentials.json` exists; run `login` first. `--foreground` runs in the current shell (for debugging); the default installs/starts the service. |
| `stop` | Stop the service (preserves auto-start; bring it back with `start`). |
| `restart` | Restart the service. |
| `status` | Local service state + server binding + auth health. Runs in well under a second. |
| `doctor` | Walk Node version, config, server reachability, WS, agent registrations, and the installed service file; report each step. |

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

Context Tree structural validation and hierarchy browsing. **`verify`
and `tree` are the only surviving `tree` subcommands** — the rest of the
namespace (`init` / `migrate` / `upgrade` / `status` / `codeowners` /
`claude-hook` / `inject` / `review` / `automation` / `skill` groups) was
retired in the 2026-06 cleanup because the cloud now owns workspace +
tree provisioning and the client runtime inlines its own skill payload
install (see PR following #844).

```
first-tree tree
├── verify [--tree-path PATH]                # validate a Context Tree repo
└── tree [path] [-L depth] [-P pattern]      # browse Context Tree nodes as a hierarchy
```

Run `first-tree tree verify --help` for options.

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

Human output is written as a tree whose node labels use:

```text
relative/path/ [Title] -> Description
relative/path.md [Title]
```

Directory labels end with `/`. The repository root line uses the repo
directory name, for example `first-tree-context/ [Context Tree] -> Root
index for the First Tree context tree.`. When `description` is missing,
the `-> Description` suffix is omitted.

Options:

- `-L, --level <depth>` — maximum descendant depth below the target directory. Ancestors from the git repo root to the target are always kept. For path-tolerant CLI use, `tree tree -L docs/development` is treated as `tree tree docs/development`; `tree tree -L 2 docs/development` applies depth `2` to that path.
- `-P, --pattern <pattern>` — case-sensitive shell-style glob filter matched against relative path, filename, `title`, and `description`; matching descendants keep their ancestors visible.

With global `--json` or `FIRST_TREE_JSON=1`, `first-tree tree tree`
emits a single `{ ok: true, data }` envelope on stdout. `data.root` is the
git repo root, `data.target` is the resolved target directory relative to
that root, and `data.options` records the parsed `level`, `pattern`, and
effective `path`. `data.tree` contains the same filtered hierarchy as
structured nodes with `kind`, `name`, `relativePath`, `depth`, `metadata`,
`hasNode`, and `children` fields; `metadata` includes `title`, optional
`description`, and `owners`. Human tree text is written to stderr so stdout
stays reserved for machine-readable JSON.

## Environment variables

Most environment variables use the `FIRST_TREE_` prefix.

### CLI — operator-facing

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_HOME` | Override the CLI home directory for config, data, and agent workspaces. | Channel-dependent: `~/.first-tree` (prod), `~/.first-tree-staging` (staging), `~/.first-tree-dev` (dev). |
| `FIRST_TREE_SERVER_URL` | Server URL (alternative to the connect token's `iss` claim). | — |
| `FIRST_TREE_LOG_LEVEL` | Log level (`trace` / `debug` / `info` / `warn` / `error` / `fatal`). | `info` |
| `FIRST_TREE_JSON` | JSON output mode (equivalent to `--json`). | — |

### CLI — internal (set by the CLI for its own subprocesses)

These are mentioned for completeness; operators don't set them in shell rc.

| Variable | Purpose |
|---|---|
| `FIRST_TREE_SERVICE_MODE` | Supervisor → child flag baked into the launchd plist and systemd unit templates. |

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
| `FIRST_TREE_PUBLIC_URL` | Public-facing server URL. Stamped as the `iss` claim on connect tokens and used to build invite-link URLs + the GitHub OAuth callback. **Required in production.** | — |
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
| `FIRST_TREE_ARCHIVE_UNMAPPED_IDLE_SECONDS` | `43200` |

`FIRST_TREE_ARCHIVE_UNMAPPED_IDLE_SECONDS` applies only to chats with no
GitHub mapping and no human owner.

**Observability:**

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_LOG_LEVEL` | Server log level. | `info` |
| `FIRST_TREE_OTEL_ENDPOINT` | OTLP/HTTP traces endpoint. Non-empty enables tracing. | `""` |
| `FIRST_TREE_OTEL_HEADERS` | OTLP headers as `key1=val1,key2=val2`. Typically holds the write token. | `""` |
| `FIRST_TREE_OTEL_ENVIRONMENT` | Deployment label emitted as `deployment.environment.name`. | `development` |
| `FIRST_TREE_OTEL_CAPTURE_CLIENT_IP` | Capture client IP attribute on traces. | `false` |

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

After `first-tree upgrade` or after running `logout` + `login <token>` on a deployment-bump cycle:

```bash
first-tree status          # CLI version + service + server + auth + agents
first-tree daemon doctor   # service + agent configs + WS reachability
first-tree --help          # top-level verbs + namespaces
```
