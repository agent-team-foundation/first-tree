# First Tree Hub Scenario Playbooks

Use this file when the user describes a goal in natural language and you need to translate it into a First Tree Hub CLI sequence.

## 0. "I do not have `first-tree-hub` installed yet"

Run this before any operational flow when the machine may not have the CLI.

### Flow

```bash
node --version                                        # must be >= 22.16
npm install -g @agent-team-foundation/first-tree-hub
first-tree-hub --version
```

For any task that creates agents via GitHub identity, also check:

```bash
gh auth status
```

### What to remember

- First Tree Hub requires Node.js `>= 22.16`.
- Do not jump to `server start`, `client start`, `client connect`, or `onboard` on a machine where installation state is unknown.
- If the user installed locally (`npm i`, not `npm i -g`), prefer `npx first-tree-hub ...` so they do not have to fight PATH.

## 1. "Get First Tree Hub running locally"

For a first-time local Hub.

### Flow

```bash
first-tree-hub server start                     # interactive; provisions Docker Postgres + admin + web UI
# or for CI / Docker:
first-tree-hub server start --no-interactive
# using an existing Postgres:
first-tree-hub server start --database-url postgresql://user:pass@host:5432/db
```

If startup fails:

```bash
first-tree-hub server doctor
first-tree-hub status
```

### What to remember

- `server start` is the happy-path bootstrap. It can run migrations, seed the first admin, and build/serve the web dist.
- Prefer `--database-url` over forcing Docker when the user already has a Postgres.
- First-run prints a generated admin password — capture it; it is shown only once.

## 2. "Connect this computer to an existing Hub server"

Use this when the Hub is already up and the user wants this machine to run agents against it.

### Flow

```bash
# Interactive login (prompts for username/password):
first-tree-hub client connect https://hub.example.com

# Or with a one-time connect token from the web "Connect a machine" dialog:
first-tree-hub client connect https://hub.example.com --token <connect-token>

# Skip the background service install (useful in containers):
first-tree-hub client connect https://hub.example.com --no-service
```

After `connect` succeeds, the machine is signed in and (by default on macOS/Linux) running as a background service.

To verify:

```bash
first-tree-hub client status          # local: configured agents
first-tree-hub client doctor          # readiness checks
first-tree-hub client service status  # service state (if installed)
first-tree-hub client hub-list        # server-side: this client appears in the Hub
```

If something breaks, `client doctor` usually points at the culprit (no credentials, wrong server URL, WebSocket blocked, etc.).

### What to remember

- `client connect` is the **only** supported way to sign in. There is no separate `login`, `token`, or manual credential setup.
- It writes `~/.first-tree-hub/credentials.json` and a generated `client.id` in `client.yaml`.
- Agents are not registered by this command. Admins pin agents to this machine's `client.id` from the Hub UI (or via `agent create --client-id ...`). A running client auto-picks them up.

## 3. "Keep this machine online across reboots"

Use this for a production desktop or a server that should run agents permanently.

### Flow

```bash
first-tree-hub client service install      # launchd (macOS) or systemd --user (Linux)
first-tree-hub client service status
first-tree-hub client service uninstall    # when decommissioning the machine
```

`client connect` installs the service by default. Only re-run `service install` when the user ran `connect --no-service` initially, or when re-installing after `uninstall`.

Logs: `~/.first-tree-hub/logs/`.

### What to remember

- Windows is unsupported. Tell the user to use `first-tree-hub client start` inside a user-managed supervisor instead.
- The service runs `client start --no-interactive`, so the machine must already have valid `credentials.json` — run `client connect` first.
- `service install` is safe to re-run. It rewrites the unit file and reloads the supervisor.

## 4. "Onboard a new human member"

Add a real person to the team through the supported identity flow.

### Flow

```bash
# 0. Prereq on this machine: CLI installed, logged in.
first-tree-hub client connect <server-url>             # if credentials.json does not exist

# 1. Dry-run to surface missing fields:
first-tree-hub onboard --check \
  --server <url> --id alice --type human \
  --role "Engineer" --domains "backend,infrastructure"

# 2. Create the member (and optionally a personal assistant):
first-tree-hub onboard \
  --server <url> --id alice --type human \
  --role "Engineer" --domains "backend,infrastructure" \
  --assistant alice-assistant
```

If the machine should also run this human's personal assistant, run `client start` (or rely on the already-installed background service).

### What to remember

- `onboard` creates the agent via Admin API and wires up the local alias + optional Feishu bot in one step.
- It **does not** log you in. If `credentials.json` is missing, it exits with a pointer to `client connect`.
- Pass the server URL explicitly (`--server`) whenever the user / automation supplied one — do not silently fall back to defaults.
- Humans with a Feishu bot configured still need to send `/bind <id>` in Feishu afterwards to attach the human user to the assistant.

## 5. "Onboard a standalone autonomous agent"

A bot with no human owner (code reviewer, monitor, pipeline agent).

### Flow

```bash
first-tree-hub onboard --check \
  --server <url> --id code-reviewer --type autonomous_agent \
  --role "Code Review" --domains "code-review"

first-tree-hub onboard \
  --server <url> --id code-reviewer --type autonomous_agent \
  --role "Code Review" --domains "code-review"
```

### What to remember

- Do **not** pass `--assistant` for `autonomous_agent`.
- Feishu bot binding is optional here (no `/bind` follow-up needed).
- Thread through `--server <url>` whenever supplied.

## 6. "Change an agent's model / prompt / MCP / env / repos"

Use this whenever the user wants the live agent to behave differently — *not* when they want to edit their local alias file.

### Flow

```bash
first-tree-hub agent config get alice                                      # read current config
first-tree-hub agent config set-model alice claude-opus-4-7                # swap model
cat ./house-prompt.md | first-tree-hub agent config append-prompt alice    # replace prompt append
first-tree-hub agent config add-mcp alice --name gh --transport stdio --command gh --args mcp
first-tree-hub agent config set-env alice OPENAI_API_KEY=sk-... --sensitive
first-tree-hub agent config add-repo alice https://github.com/acme/monorepo --ref main
first-tree-hub agent config dry-run alice -f ./patch.json                  # preview + validate
```

### What to remember

- This surface mutates server-side runtime config via `/api/v1/admin/agents/:id/config` and affects the running agent everywhere.
- Requests carry an `expectedVersion` — concurrent edits get a conflict, not silent overwrite. On conflict, re-fetch with `agent config get` and retry.
- `--sensitive` env values are encrypted at rest and always masked in subsequent `get`/`list`.
- `dry-run` is the safe way to preview a big patch before committing it.
- Do not confuse this with `first-tree-hub config -a <name> set ...`, which edits the local `agent.yaml` (alias → UUID mapping), not server state.

## 7. "Why can't the client connect?" / "Why does startup fail?"

Diagnose before editing code or YAML.

### Flow

```bash
first-tree-hub status                 # overall state: server, db, client, agents
first-tree-hub client doctor          # or `server doctor` for the server side
first-tree-hub client service status  # if running as a service
first-tree-hub config list -c         # effective client YAML
first-tree-hub config list -s         # effective server YAML
first-tree-hub server status          # health-probe an already-running server
```

### What to remember

- If `client doctor` flags "no credentials", the fix is `client connect`, not a YAML edit.
- If `hub-list` shows the client but `client status` shows 0 agents, no agent is pinned to this machine — create one with `agent create --client-id <this-client-id>` or bind an existing agent with `agent bind client <name> --client-id <id>`.
- Server and client issues look similar from a distance. Make the user goal explicit before debugging.

## 8. "Debug messaging between agents"

Verify delivery, inspect chats, send test messages manually.

### Flow

```bash
# Prereq: this machine must have credentials.json (client connect).

first-tree-hub agent send <agentId> "hello"                    # send to an agent
first-tree-hub agent send <chatId> "hello" --chat              # send to an existing chat
echo "piped" | first-tree-hub agent send <agentId>             # stdin
first-tree-hub agent send <agentId> "hi" --metadata '{"priority":"high"}'
first-tree-hub agent send <agentId> "follow-up" --reply-to-inbox <inboxId> --reply-to-chat <chatId>

first-tree-hub agent chats
first-tree-hub agent history <chatId>
first-tree-hub agent pull --ack                                # low-level inbox polling
first-tree-hub agent chat <agent-name>                         # interactive REPL
```

### What to remember

- These are debugging / operator commands. For production, agents run under `client start` (or the service) and receive messages via WebSocket.
- Use `--agent <name>` when multiple agent aliases are configured; with a single alias the flag is optional.

## 9. "Inspect or recover session state"

Use these when a user reports a stuck or misbehaving session.

### Flow

```bash
first-tree-hub agent status                     # fleet-wide snapshot (runtime states, session counts)
first-tree-hub agent status <name>              # single-agent detail
first-tree-hub agent sessions <name>            # list sessions for one agent
first-tree-hub agent sessions <name> --state suspended

first-tree-hub agent session suspend <name> <chat-id>
first-tree-hub agent session resume <name> <chat-id>
first-tree-hub agent session terminate <name> <chat-id>

first-tree-hub agent reset <name>               # move an error-state agent back to idle
first-tree-hub agent workspace clean            # remove stale chat workspaces safely
```

### What to remember

- `workspace clean` consults the session registry — it will not remove a chat that still has an active (non-evicted) session. Safe to run on a live machine.
- `reset` only clears the error flag; it does not restart the agent.

## 10. "Deploy First Tree Hub somewhere real"

Use this when the task goes beyond a local demo.

### Flow

1. Read `docs/deployment-guide.md` before proposing anything — it covers Docker, Railway, Render, Supabase, HTTPS, and multi-machine topology.
2. Provision the backing Postgres externally and pass `--database-url` to `server start`; do not rely on the CLI's Docker-managed Postgres in production.
3. Set secrets via env vars (`FIRST_TREE_HUB_JWT_SECRET`, `FIRST_TREE_HUB_ENCRYPTION_KEY`, `FIRST_TREE_HUB_GITHUB_TOKEN`, etc.) so they are not auto-generated on restart.
4. On each client machine, run `client connect` once to sign in, then `client service install` so the runtime survives reboots.

### What to remember

- Production auto-generated secrets (JWT, encryption key) should be pinned in env so that restarts do not invalidate issued tokens or make encrypted adapter credentials unreadable.
- `server stop` only stops the CLI-managed Docker Postgres container — it is not a generic "stop the running server" command.

## 11. "Change how the CLI behaves" (code change)

Use this when the task is a code change, not an operation.

### Flow

1. Find the matching command handler under `packages/command/src/commands/`.
2. Move reusable logic into `packages/command/src/core/`.
3. If flags / env vars / schema change, update `packages/shared/src/config/*.ts`.
4. Register new top-level commands from `packages/command/src/cli/index.ts`.
5. Update `docs/cli-reference.md` (and `docs/onboarding-guide.md` if onboarding flow changes).
6. Run the smallest relevant validation first: `pnpm check`, `pnpm typecheck`, `pnpm --filter @agent-team-foundation/first-tree-hub test`.

### What to remember

- Command handlers stay thin; core modules carry the logic.
- Onboarding changes usually touch both `commands/onboard.ts` (argument shape) and `core/onboard.ts` (actual behavior).
- See `references/developer-map.md` for the full source layout.
