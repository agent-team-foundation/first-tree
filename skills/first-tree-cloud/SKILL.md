---
name: first-tree-cloud
version: 0.5.0
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: Install, operate, and use the `first-tree` CLI against First Tree Cloud — the unified `login` / `daemon` / `agent` / `chat` / `config` workflows, the JWT credential model, background-service operation, and day-to-day messaging. Use whenever the user mentions connecting a machine to First Tree, installing or running the daemon as a background service (launchd/systemd), managing agent runtime configuration (model, prompt, MCP, env, git repos), onboarding a member, or sending / debugging chat messages.
---

# First Tree CLI — Cloud Layer

## Overview

Use this skill to map a user's First Tree Cloud / collaboration intent onto the right `first-tree` command or code path without re-discovering the repo each time. (For Context Tree concepts / onboarding / validation, the right skill is `first-tree-context`; for the GitHub notification daemon, it's `first-tree-github-scan`. For the high-level "what is First Tree" map, see `first-tree`.) Note: the dedicated NHA / `first-tree attention` CLI was removed in PR #747 ahead of the `group-chat-unified-send` message-archetype rebuild; for now, agent-to-human asks go through plain `chat send`.

Keep the mental model straight: First Tree Cloud is the communication and identity backbone for agent teams. It is **not** the agent framework, not the orchestration engine, and not the Context Tree. First Tree Cloud has three principals:

- **Server** — operated centrally as a SaaS by the First Tree team. Owns identity, persistence, admin surface, and the inbox. End users do not run their own server; the CLI has no `server` command group.
- **Client** — one per computer. A machine signs in with a First Tree member's credentials once, then runs every agent pinned to it.
- **Agent** — many per First Tree organization. Lives in the server's database; is bound to exactly one client machine.

This shape drives almost every command: `daemon` and `config` target this machine, `agent` targets a row in the server's database (usually acting as the member via their own JWT).

## Start Here

1. **Classify the task before acting.** Most requests fall into one of these buckets. Pick the bucket, then go to the reference it names.
   - Install or sanity-check the CLI on a fresh machine → `references/command-surface.md`
   - Connect a computer to First Tree SaaS (first time) → the **`login <token>`** section below, then `references/scenario-playbooks.md`
   - Make a computer stay online permanently → the **Background daemon** section below
   - Map a natural-language request to an end-to-end CLI flow → `references/scenario-playbooks.md`
   - Walk an external agent prompt through onboarding → `references/onboarding-operator.md`
   - Need product / architecture context (decisions, ownership, design) → read the Context Tree's `first-tree-cloud/` domain (start at `NODE.md`).
2. **Prefer the supported CLI path over hand-rolled API calls or YAML edits.** The CLI already wires up auth, refresh, config layering, and retries for you.
   - `login <token>` for first-time auth on a new machine (auto-installs the background daemon on macOS/Linux)
   - `agent config ...` to change a running agent's model / prompt / MCP / env / repos
   - `login` + `agent create` + `daemon start` to add a member end-to-end (the retired `onboard` verb's sequence)
   - `config show/set/get` to read or write `client.yaml`, instead of hand-editing it
3. **Read the canonical repo docs when the task becomes specialized.**
   - `docs/cli-reference.md` — every flag and env var in one place
   - `docs/onboarding-guide.md` — full onboarding walkthrough, including agent claim
4. **On a fresh machine, verify prerequisites before proposing a flow.**
   - Node.js `>= 22.16`
   - Install: `npm install -g first-tree`
   - Verify: `first-tree --version`
   - For agent creation via GitHub identity, also: `gh auth status`

## The Credential Model (read this once)

The CLI stores a single **member access JWT + refresh token** at `~/.first-tree/config/credentials.json` (mode `0600`). Every command that talks to the First Tree server runs through `ensureFreshAccessToken()`, which refreshes 30s before expiry via `/api/v1/auth/refresh` and re-persists the token silently.

Implications:

- There is **one** way to sign in: `first-tree login <token>`. Paste the connect token from the First Tree web console's "Connect a machine" dialog; the CLI decodes the token's `iss` claim to derive the server URL, so the operator never supplies a URL separately. Username/password login has been removed.
- There is **no** standalone admin login, service-user token, or per-agent bearer token in the current CLI. Admin actions, agent-owner actions, and low-level SDK calls all use the signed-in member's JWT. The legacy `FIRST_TREE_AGENT_TOKEN` / `FIRST_TREE_AGENT` env vars and the old `agent token bootstrap` command have been removed.
- `FIRST_TREE_SERVER_URL` still works for overriding the server URL per command, but auth itself is file-based.
- Agents are database rows, owned by members. They do not hold their own tokens anymore — the client that runs them authenticates as the owning member.

If a flow looks like "get an agent token, set an env var, then run the agent" — that flow is outdated. Point the user at `login <token>` instead.

## First-Time Setup on a New Machine

The happy path is two commands, in this order:

```bash
npm install -g first-tree            # install
first-tree login <connect-token>                          # sign in + register the machine
# (service auto-installs on macOS/Linux — you can close the terminal)
```

Pass `--no-start` when the user wants to run inline (useful in containers or for quick tests).

After `login <token>` succeeds:

- `~/.first-tree/config/credentials.json` exists
- `~/.first-tree/config/client.yaml` has `server.url` and a generated `client.id`
- On macOS/Linux, the background daemon is installed and already running
- Any agent pinned to this client (via the First Tree web console or `agent create --client-id ...`) is automatically picked up by the running daemon

## Background Daemon (keep the machine online)

`login <token>` installs a user-level background daemon automatically (launchd on macOS, `systemd --user` on Linux) so the runtime survives logout/reboot — pass `--no-start` to opt out and run inline. Windows is unsupported; on Windows the command falls back to inline mode (`first-tree daemon start` plus a user-managed supervisor).

The `daemon` namespace owns the daemon lifecycle (`start` / `stop` / `restart` / `status` / `doctor`); install/repair is folded into `login <token>`. Tail logs directly:

```bash
tail -f ~/.first-tree/logs/client.log
```

To decommission a machine: stop and remove the unit at the OS level (`launchctl bootout` + `rm` of the plist on macOS; `systemctl --user disable --now` + `rm` of the unit file on Linux), then `rm -rf ~/.first-tree`. See `docs/cli-reference.md` for the exact commands. To force-drop a client from the server side, use the First Tree web console (Computers → Disconnect) — the legacy `client disconnect` CLI verb was retired in Phase 1A.

## Operating Rules

- **Keep subsystem boundaries clear.**
  - `login <token>` — first-time setup for this computer; folds in auth, `client.yaml` write, and background-daemon install.
  - `daemon ...` — daemon lifecycle on a specific computer once it is connected (`start` / `stop` / `restart` / `status` / `doctor`). Server-side client inventory moved to the web console (Computers tab); local YAML editing moved to top-level `config`.
  - `agent ...` — everything that is "about an agent record": local alias config (`add`/`remove`/`list`), creation and claiming, workspace cleanup, bindings, **runtime configuration via `agent config`**, status / reset / sessions.
  - `chat ...` — day-to-day messaging: `send`, `list`, `history`, and the interactive `open` REPL.
  - `onboard` — the guided "add a new member" flow; composes multiple low-level operations behind one command.
- **Distinguish `agent config` (server-side runtime) from top-level `config` (local YAML).** `agent config set-model` or `append-prompt` mutates the First Tree database via the admin API and affects the running agent everywhere. `config set` edits the local `client.yaml`, which controls the computer's own runtime behavior.
- **Respect config layering.** CLI args override env vars → env vars override YAML → YAML overrides auto-generated → auto-generated overrides defaults.
- **Distinguish config scopes and paths.**
  - Home defaults to `~/.first-tree`; `FIRST_TREE_HOME` relocates it.
  - Client config: `$FIRST_TREE_HOME/config/client.yaml`
  - Per-agent local alias: `$FIRST_TREE_HOME/config/agents/<name>/agent.yaml`
  - Credentials: `$FIRST_TREE_HOME/config/credentials.json`
  - Onboard resume state: `$FIRST_TREE_HOME/.onboard-state.json`
  - Service logs: `$FIRST_TREE_HOME/logs/`
- **Do not describe First Tree Cloud as "the agents" or "the Context Tree".** It sits between them.

## Common Workflows

### Choose a Command

- Install + verify: `npm install -g first-tree`, then `first-tree --version`.
- Environment readiness: `first-tree daemon doctor` for a compact summary.
- Connect a computer to First Tree SaaS: `first-tree login <token>` — paste the token from the First Tree web console's *Connect a machine* dialog.
- Keep the computer online across reboots: handled automatically by `first-tree login <token>` (omit `--no-start`).
- Run the runtime inline (no service): `first-tree daemon start`.
- See which machines are connected: open the First Tree web console's *Computers* tab. The legacy `client list` / `client disconnect` CLI verbs were retired in Phase 1A.
- Create an agent from the CLI: `first-tree agent create <name> --type <t> --client-id <id>`.
- Change a running agent's configuration (model, prompt, MCP, env, repos): `first-tree agent config ...`.
- Onboard a new human or autonomous agent end-to-end: `first-tree login <token>` + `agent create <name> --type ... --client-id ...` + `daemon start`. The single-shot `onboard` command was retired in Phase 1A.
- Day-to-day messaging: `first-tree chat send`, `chat list`, `chat history`, or `chat open <agent>` for an interactive REPL.
- Inspect or fix session state: `first-tree agent status`, `agent reset`, `agent session list <name>`, `agent session suspend|terminate`.
- Clean stale chat workspaces: `first-tree agent workspace clean`.

### Run Onboarding From an Agent Prompt

- Treat onboarding as a sequence of explicit CLI verbs (`login` → `agent create` → optional `agent bind bot` → `daemon start`). The retired single-shot `onboard` command no longer exists.
- If the machine does not yet have the CLI or credentials:
  - Ensure `gh` is authenticated (`gh auth login`) — required for GitHub-identity agent creation.
  - Install `first-tree` globally (or use `npx` when the caller installed it locally).
  - Run `first-tree login <token>` first. Every subsequent step requires a valid credential file — without it the command exits with a clear error pointing back at `login`.
  - When you need to read the canonical guide from the repo without a local checkout:

    ```bash
    gh api repos/agent-team-foundation/first-tree/contents/docs/onboarding-guide.md?ref=main --jq .content | base64 --decode
    ```

- Thread any server URL the user supplies through `--server <url>` in every onboarding step.
- Default operator flow:

  ```bash
  first-tree login <token>                                   # one-time, if not done already
  first-tree agent create <name> --type <t> --client-id <id> # creates the agent in First Tree + binds it
  first-tree daemon start                                    # only if no service is running
  ```

- Always run `first-tree status` after each verb to verify state before proceeding.

## Gotchas

Common misreads that cost time:

- `agent add` does **not** create an agent on the server. It only writes a local alias (`agents/<name>/agent.yaml`) mapping a friendly name to an existing `agentId`. Use `agent create` to create a server-side row.
- `daemon start` does **not** start the server. It only runs configured agent clients against a server that must already be running.
- Context Tree does **not** own agent identity. First Tree Cloud does. Context Tree is an optional organizational knowledge source.
- The inbox contract is **at-least-once with client-side deduplication**, not exactly-once delivery.
- `FIRST_TREE_AGENT_TOKEN` and `FIRST_TREE_AGENT` are gone. Neither env var is read by the CLI anymore; all auth flows through `credentials.json` (written by `login <token>`).
- Do not conflate `agent config ...` (server-side runtime configuration, mutates the database via the admin API) with `config ...` (local YAML editing of `client.yaml`). Both are legitimate; they operate on different state.

## References

- `references/command-surface.md` — exhaustive command catalog, including the credential model, scopes, env vars, and admin API endpoints the CLI calls.
- `references/scenario-playbooks.md` — request-to-command playbooks (install, connect, onboard, debug, deploy).
- `references/onboarding-operator.md` — automation-friendly onboarding instructions that start from a prompt, not a local checkout.

For product / architecture concepts (what First Tree Cloud is, who owns what, why decisions were made), read the Context Tree's `first-tree-cloud/` domain — `NODE.md` for the map, then `cli.md` / `claim-agent.md` / `client-runtime.md` / `messaging.md` for the specific subsystem.
