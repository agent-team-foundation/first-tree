# First Tree Scenario Playbooks

Use this file when the user describes a goal in natural language and you need to translate it into a First Tree CLI sequence.

## 0. "I do not have `first-tree` installed yet"

Run this before any operational flow when the machine may not have the CLI.

### Flow

```bash
node --version                                        # must be >= 22.16
npm install -g first-tree
first-tree --version
```

For any task that creates agents via GitHub identity, also check:

```bash
gh auth status
```

### What to remember

- First Tree requires Node.js `>= 22.16`.
- Do not jump to `daemon start`, `login <token>`, or `agent create` on a machine where installation state is unknown.
- If the user installed locally (`npm i`, not `npm i -g`), prefer `npx first-tree ...` so they do not have to fight PATH.

## 1. "Connect this computer to an existing Hub server"

Use this when the Hub is already up and the user wants this machine to run agents against it.

### Flow

```bash
# Paste a connect token from the Hub web console's "Connect a machine" dialog:
first-tree login <connect-token>

# Skip the background service install (useful in containers):
first-tree login <connect-token> --no-start
```

After `connect` succeeds, the machine is signed in and (by default on macOS/Linux) running as a background service.

To verify:

```bash
first-tree daemon status          # local: service state + hub + auth health
first-tree daemon doctor          # readiness checks (includes background-service state)
# Server-side: open the Hub web admin → Computers tab to verify this
# machine appears. (The legacy `client list` CLI verb was retired in Phase 1A.)
```

If something breaks, `daemon doctor` usually points at the culprit (no credentials, wrong server URL, WebSocket blocked, etc.).

### What to remember

- `login <token>` is the **only** supported way to sign in. There is no separate web login flow, username/password, or manual credential setup from the CLI side.
- It writes `~/.first-tree/hub/credentials.json` and a generated `client.id` in `client.yaml`.
- The hub URL is derived from the token's `iss` claim, so the operator never types a URL.
- Agents are not registered by this command. Admins pin agents to this machine's `client.id` from the Hub UI (or via `agent create --client-id ...`). A running client auto-picks them up.

## 2. "Keep this machine online across reboots"

Use this for a production desktop or a server that should run agents permanently.

### Flow

`login <token>` installs the background service automatically on macOS (launchd) and Linux (`systemd --user`) — there is no `client service ...` subcommand. Just sign in and the machine stays online:

```bash
first-tree login <token>                 # auto-installs the service
first-tree daemon doctor                   # verify: shows running/inactive/not-installed
tail -f ~/.first-tree/hub/logs/client.log      # tail logs (NDJSON)
```

To repair a broken unit (binary moved, Node upgraded), re-run `login <token>` — it rewrites the unit file. Re-authentication is required (paste a fresh connect token).

To decommission a machine, remove the unit at the OS level and clear local state:

```bash
# macOS
launchctl bootout gui/$UID/dev.first-tree.client
rm -f ~/Library/LaunchAgents/dev.first-tree.client.plist

# Linux
systemctl --user disable --now first-treeent.service
rm -f ~/.config/systemd/user/first-treeent.service

# Both
rm -rf ~/.first-tree/hub
```

To force-disconnect from the server side: use the Hub web admin (Computers → Disconnect). The CLI no longer ships an admin verb for this.

### What to remember

- Windows is unsupported. `login <token>` falls back to inline mode there — tell the user to use `first-tree daemon start` inside a user-managed supervisor.
- The service runs `daemon start --no-interactive`, so the machine must already have valid `credentials.json` — `login <token>` writes that for you in the same step.
- Re-running `login <token>` is safe and idempotent for the unit file, but always re-authenticates.

## 3. "Onboard a new human member"

Add a real person to the team through the supported identity flow.

### Flow

```bash
# 0. Prereq on this machine: CLI installed, logged in.
first-tree login <token>                                # if credentials.json does not exist

# 1. Create the human agent record on the Hub + bind it to this client:
first-tree agent create alice \
  --server <url> --type human --display-name "Alice" \
  --client-id "$(first-tree config get client.id | awk '{print $2}')"

# 2. (Optional) Pair Alice with a personal assistant agent:
first-tree agent create alice-assistant \
  --server <url> --type agent \
  --client-id "$(first-tree config get client.id | awk '{print $2}')"
```

If the machine should also run the assistant, run `first-tree daemon start` (or rely on the already-installed background service started by `login`).

### What to remember

- The single-shot `onboard` command was retired in Phase 1A. Onboarding is now a sequence of explicit verbs that can each fail and recover independently.
- Each verb depends on a valid credential file. If `credentials.json` is missing, the command exits pointing at `login <token>`.
- Pass the server URL explicitly (`--server`) whenever the user / automation supplied one — do not silently fall back to defaults.

## 4. "Onboard a standalone autonomous agent"

A bot with no human owner (code reviewer, monitor, pipeline agent).

### Flow

```bash
first-tree login <token>                                # if credentials.json does not exist

first-tree agent create code-reviewer \
  --server <url> --type agent \
  --display-name "Code Review" \
  --client-id "$(first-tree config get client.id | awk '{print $2}')"

first-tree daemon start                                 # bring it online (no-op if already running)
```

### What to remember

- A standalone autonomous `agent` does not pair with a personal-assistant `agent` — skip step 2 of the human flow.
- Thread through `--server <url>` whenever supplied.

## 5. "Change an agent's model / prompt / MCP / env / repos"

Use this whenever the user wants the live agent to behave differently — *not* when they want to edit their local alias file.

### Flow

```bash
first-tree agent config show alice                                     # read current config
first-tree agent config set-model alice claude-opus-4-7                # swap model
cat ./house-prompt.md | first-tree agent config append-prompt alice    # replace prompt append
first-tree agent config add-mcp alice --name gh --transport stdio --command gh --args mcp
first-tree agent config set-env alice OPENAI_API_KEY=sk-... --sensitive
first-tree agent config add-repo alice https://github.com/acme/monorepo --ref main
first-tree agent config dry-run alice -f ./patch.json                  # preview + validate
```

### What to remember

- This surface mutates server-side runtime config via `/api/v1/admin/agents/:id/config` and affects the running agent everywhere.
- Requests carry an `expectedVersion` — concurrent edits get a conflict, not silent overwrite. On conflict, re-fetch with `agent config show` and retry.
- `--sensitive` env values are encrypted at rest and always masked in subsequent `get`/`list`.
- `dry-run` is the safe way to preview a big patch before committing it.
- Do not confuse this with the local `agent.yaml` (alias → UUID mapping at `~/.first-tree/hub/config/agents/<name>/agent.yaml`), which is local-only state and unrelated to server-side runtime config.

## 6. "Why can't the client get online?" / "Why does startup fail?"

Diagnose before editing code or YAML.

### Flow

```bash
first-tree daemon status          # local state: service, hub URL, agents
first-tree daemon doctor          # readiness checks (background-service state included)
first-tree config show     # effective client YAML
```

### What to remember

- If `daemon doctor` flags "no credentials", the fix is `first-tree login <token>`, not a YAML edit.
- If `daemon status` / web admin Computers tab shows the client but `daemon status` shows 0 agents, no agent is pinned to this machine — create one with `agent create --client-id <this-client-id>` or bind an existing agent with `agent bind client <name> --client-id <id>`.
- The Hub server is operated by the First Tree team as a SaaS — when a client cannot reach it, the issue is local connectivity / credentials, not server config.

## 7. "Debug messaging between agents"

Verify delivery, inspect chats, send test messages manually.

### Flow

```bash
# Prereq: this machine must have credentials.json (connect <token>).

first-tree chat send <agentName> "hello"                   # send to an agent in the current chat
first-tree chat invite <agentName>                # pull a non-member into the current chat first
first-tree chat send <agentName> "now we can talk"         # then send normally
echo "piped" | first-tree chat send <agentName>            # stdin
first-tree chat send <agentName> "hi" -m '{"priority":"high"}'

first-tree chat list
first-tree chat history <chatId>
first-tree chat open <agent-name>                          # interactive REPL
```

### What to remember

- These are debugging / operator commands. For production, agents run under `daemon start` (or the service) and receive messages via WebSocket.
- Use `--agent <name>` when multiple agent aliases are configured; with a single alias the flag is optional.

## 8. "Inspect or recover session state"

Use these when a user reports a stuck or misbehaving session.

### Flow

```bash
first-tree agent status                     # fleet-wide snapshot (runtime states, session counts)
first-tree agent status <name>              # single-agent detail
first-tree agent session list <name>            # list sessions for one agent
first-tree agent session list <name> --state suspended

first-tree agent session suspend <name> <chat-id>
first-tree agent session terminate <name> <chat-id>

first-tree agent reset <name>               # move an error-state agent back to idle
first-tree agent workspace clean            # remove stale chat workspaces safely
```

### What to remember

- `workspace clean` consults the session registry — it will not remove a chat that still has an active (non-evicted) session. Safe to run on a live machine.
- `reset` only clears the error flag; it does not restart the agent.

## 9. "Roll out clients across many machines"

The Hub server itself is operated by the First Tree team as a SaaS — there
is no self-host path. Use this section when scaling out the *client* side.

### Flow

1. Generate a connect token per machine from the Hub web console.
2. On each machine, run `first-tree login <token>` once — it signs the
   machine in and installs the background service in a single step so the
   runtime survives reboots.
3. Verify with `first-tree daemon doctor` and the Hub web admin (Computers tab).

### What to remember

- Connect tokens carry the hub URL in their `iss` claim — operators never
  type a URL.
- Windows is unsupported. `login <token>` falls back to inline mode there;
  use a user-managed supervisor for permanent deployment.

## 10. "Change how the CLI behaves" (code change)

Use this when the task is a code change, not an operation.

### Flow

1. Find the matching command handler under `apps/cli/src/commands/`.
2. Move reusable logic into `apps/cli/src/core/`.
3. If flags / env vars / schema change, update `packages/shared/src/config/*.ts`.
4. Register new top-level commands from `apps/cli/src/cli/index.ts`.
5. Update `docs/cli-reference.md` (and `docs/onboarding-guide.md` if onboarding flow changes).
6. Run the smallest relevant validation first: `pnpm check`, `pnpm typecheck`, `pnpm --filter first-tree test`.

### What to remember

- Command handlers stay thin; core modules carry the logic.
- Onboarding changes usually touch both `commands/onboard.ts` (argument shape) and `core/onboard.ts` (actual behavior).
- See `references/developer-map.md` for the full source layout.
