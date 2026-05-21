---
name: first-tree-hub-cli
description: Install, operate, and modify First Tree Hub with emphasis on the unified `first-tree-hub` CLI, its `connect`/`client`/`agent`/`chat`/`onboard` workflows, the JWT credential model, and the repo's collaboration surface for agent identity, inbox delivery, workspace bootstrap, and background-service operation. Use whenever the user mentions First Tree Hub, connecting a machine to the SaaS Hub, installing or running the client as a background service (launchd/systemd), managing agent runtime configuration (model, prompt, MCP, env, git repos), onboarding a member, or changing code in `apps/cli`, `packages/client`, `packages/server`, or `packages/shared` — even if they don't say "CLI".
---

# First Tree Hub CLI

## Overview

Use this skill to map user intent onto the right First Tree Hub command or code path without re-discovering the repo each time.

Keep the mental model straight: First Tree Hub is the communication and identity backbone for agent teams. It is **not** the agent framework, not the orchestration engine, and not the Context Tree. The Hub has three principals:

- **Server** — operated centrally as a SaaS by the First Tree team. Owns identity, persistence, admin surface, and the inbox. End users do not run their own server; the CLI has no `server` command group.
- **Client** — one per computer. A machine signs in with a Hub member's credentials once, then runs every agent pinned to it.
- **Agent** — many per Hub. Lives in the server's database; is bound to exactly one client machine.

This shape drives almost every command: `client` targets a machine, `agent` targets a row in the server's database (usually acting as the member via their own JWT).

## Start Here

1. **Classify the task before acting.** Most requests fall into one of these buckets. Pick the bucket, then go to the reference it names.
   - Install or sanity-check the CLI on a fresh machine → `references/command-surface.md`
   - Connect a computer to the SaaS Hub (first time) → the **`connect <token>`** section below, then `references/scenario-playbooks.md`
   - Make a computer stay online permanently → the **Background service** section below
   - Map a natural-language request to an end-to-end CLI flow → `references/scenario-playbooks.md`
   - Operate `onboard` from an external agent prompt → `references/onboarding-operator.md`
   - Explain product or architecture concepts → `references/core-concepts.md`
   - Modify CLI or adjacent package behavior → `references/developer-map.md`
2. **Prefer the supported CLI path over hand-rolled API calls or YAML edits.** The CLI already wires up auth, refresh, config layering, and retries for you.
   - `connect <token>` for first-time auth on a new machine (auto-installs the background service on macOS/Linux)
   - `agent config ...` to change a running agent's model / prompt / MCP / env / repos
   - `onboard` to add a member end-to-end
   - `client config show/set/get` to read or write `client.yaml`, instead of hand-editing it
3. **Read the canonical repo docs when the task becomes specialized.**
   - `docs/cli-reference.md` — every flag and env var in one place
   - `docs/onboarding-guide.md` — full onboarding walkthrough
   - `docs/claim-agent-guide.md` — agent claim + Feishu binding
4. **On a fresh machine, verify prerequisites before proposing a flow.**
   - Node.js `>= 22.16`
   - Install: `npm install -g @agent-team-foundation/first-tree-hub`
   - Verify: `first-tree-hub --version`
   - For agent creation via GitHub identity, also: `gh auth status`
5. **The skill lives inside the repo.** `.agents/skills/` and `.claude/skills/` are symlinks to `skills/` — when you edit `skills/first-tree-hub-cli/`, every runtime sees the change immediately. No sync step.

## The Credential Model (read this once)

The CLI stores a single **member access JWT + refresh token** at `~/.first-tree/hub/credentials.json` (mode `0600`). Every command that talks to the Hub runs through `ensureFreshAccessToken()`, which refreshes 30s before expiry via `/api/v1/auth/refresh` and re-persists the token silently.

Implications:

- There is **one** way to sign in: `first-tree-hub login <token>`. Paste the connect token from the Hub web console's "Connect a machine" dialog; the CLI decodes the token's `iss` claim to derive the hub URL, so the operator never supplies a URL separately. Username/password login has been removed.
- There is **no** standalone admin login, service-user token, or per-agent bearer token in the current CLI. Admin actions, agent-owner actions, and low-level SDK calls all use the signed-in member's JWT. The legacy `FIRST_TREE_AGENT_TOKEN` / `FIRST_TREE_AGENT` env vars and the old `agent token bootstrap` command have been removed.
- `FIRST_TREE_SERVER_URL` still works for overriding the server URL per command, but auth itself is file-based.
- Agents are database rows, owned by members. They do not hold their own tokens anymore — the client that runs them authenticates as the owning member.

If a flow looks like "get an agent token, set an env var, then run the agent" — that flow is outdated. Point the user at `connect <token>` instead.

## First-Time Setup on a New Machine

The happy path is two commands, in this order:

```bash
npm install -g @agent-team-foundation/first-tree-hub            # install
first-tree-hub login <connect-token>                          # sign in + register the machine
# (service auto-installs on macOS/Linux — you can close the terminal)
```

Pass `--no-start` when the user wants to run inline (useful in containers or for quick tests).

After `connect <token>` succeeds:

- `~/.first-tree/hub/credentials.json` exists
- `~/.first-tree/hub/config/client.yaml` has `server.url` and a generated `client.id`
- On macOS/Linux, the background service is installed and already running
- Any agent pinned to this client (via the Hub UI or `agent create --client-id ...`) is automatically picked up by the running service

## Background Service (keep the machine online)

`connect <token>` installs a user-level background service automatically (launchd on macOS, `systemd --user` on Linux) so the runtime survives logout/reboot — pass `--no-start` to opt out and run inline. Windows is unsupported; on Windows the command falls back to inline mode (`first-tree-hub daemon start` plus a user-managed supervisor).

There are **no `client service ...` subcommands** — the service lifecycle is folded into `connect <token>` (install or repair) and `client doctor` (status). Tail logs directly:

```bash
tail -f ~/.first-tree/hub/logs/client.log
```

To decommission a machine: stop and remove the unit at the OS level (`launchctl bootout` + `rm` of the plist on macOS; `systemctl --user disable --now` + `rm` of the unit file on Linux), then `rm -rf ~/.first-tree/hub`. See `docs/cli-reference.md` for the exact commands. To force-drop a client from the server side, use `client disconnect <clientId>`.

## Operating Rules

- **Keep subsystem boundaries clear.**
  - `connect <token>` — first-time setup for this computer; folds in auth, `client.yaml` write, and background-service install.
  - `client ...` — everything that happens on a specific computer once it is connected: the foreground runtime (`start`), the background service, Hub-side client inventory (`list`, `disconnect`), and local YAML edits via `client config`.
  - `agent ...` — everything that is "about an agent record": local alias config (`add`/`remove`/`list`), creation and claiming, workspace cleanup, bindings, **runtime configuration via `agent config`**, status / reset / sessions.
  - `chat ...` — day-to-day messaging: `send`, `list`, `history`, and the interactive `open` REPL.
  - `onboard` — the guided "add a new member" flow; composes multiple low-level operations behind one command.
- **Distinguish `agent config` (server-side runtime) from `client config` (local YAML).** `agent config set-model` or `append-prompt` mutates the Hub database via the admin API and affects the running agent everywhere. `client config set` edits the local `client.yaml`, which controls the computer's own runtime behavior.
- **Respect config layering.** CLI args override env vars → env vars override YAML → YAML overrides auto-generated → auto-generated overrides defaults.
- **Distinguish config scopes and paths.**
  - Home defaults to `~/.first-tree/hub`; `FIRST_TREE_HOME` relocates it.
  - Client config: `$FIRST_TREE_HOME/config/client.yaml`
  - Per-agent local alias: `$FIRST_TREE_HOME/config/agents/<name>/agent.yaml`
  - Credentials: `$FIRST_TREE_HOME/credentials.json`
  - Onboard resume state: `$FIRST_TREE_HOME/.onboard-state.json`
  - Service logs: `$FIRST_TREE_HOME/logs/`
- **Do not describe Hub as "the agents" or "the Context Tree".** It sits between them.

## Common Workflows

### Choose a Command

- Install + verify: `npm install -g @agent-team-foundation/first-tree-hub`, then `first-tree-hub --version`.
- Environment readiness: `first-tree-hub daemon doctor` for a compact summary.
- Connect a computer to the SaaS Hub: `first-tree-hub login <token>` — paste the token from the Hub web console's *Connect a machine* dialog.
- Keep the computer online across reboots: handled automatically by `first-tree-hub login <token>` (omit `--no-start`).
- Run the runtime inline (no service): `first-tree-hub daemon start`.
- See which machines the Hub currently sees: open the Hub web admin's *Computers* tab. The legacy `client list` / `client disconnect` CLI verbs were retired in Phase 1A.
- Create an agent from the CLI: `first-tree-hub agent create <name> --type <t> --client-id <id>`.
- Change a running agent's configuration (model, prompt, MCP, env, repos): `first-tree-hub agent config ...`.
- Onboard a new human or autonomous agent end-to-end: `first-tree-hub login <token>` + `agent create <name> --type ... --client-id ...` + `daemon start`. The single-shot `onboard` command was retired in Phase 1A.
- Day-to-day messaging: `first-tree-hub chat send`, `chat list`, `chat history`, or `chat open <agent>` for an interactive REPL.
- Inspect or fix session state: `first-tree-hub agent status`, `agent reset`, `agent session list <name>`, `agent session suspend|terminate`.
- Clean stale chat workspaces: `first-tree-hub agent workspace clean`.

### Run Onboarding From an Agent Prompt

- Treat onboarding as a sequence of explicit CLI verbs (`login` → `agent create` → optional `agent bind bot` → `daemon start`). The retired single-shot `onboard` command no longer exists.
- If the machine does not yet have the CLI or credentials:
  - Ensure `gh` is authenticated (`gh auth login`) — required for GitHub-identity agent creation.
  - Install `@agent-team-foundation/first-tree-hub` globally (or use `npx` when the caller installed it locally).
  - Run `first-tree-hub login <token>` first. Every subsequent step requires a valid credential file — without it the command exits with a clear error pointing back at `login`.
  - When you need to read the canonical guide from the repo without a local checkout:

    ```bash
    gh api repos/agent-team-foundation/first-tree-hub/contents/docs/onboarding-guide.md?ref=main --jq .content | base64 --decode
    ```

- Thread any server URL the user supplies through `--server <url>` in every onboarding step.
- Default operator flow:

  ```bash
  first-tree-hub login <token>                                   # one-time, if not done already
  first-tree-hub agent create <name> --type <t> --client-id <id> # creates the agent on the Hub + binds it
  first-tree-hub daemon start                                    # only if no service is running
  ```

- Always run `first-tree-hub status` after each verb to verify state before proceeding.

### Modify Code Safely

- For new or changed CLI behavior, inspect:
  - `apps/cli/src/commands/*.ts` — command registration and argument shape.
  - `apps/cli/src/core/*.ts` — reusable logic (auth, service install, doctor, onboard, Feishu, etc.).
  - `packages/shared/src/config/*.ts` — if flags, env vars, or schema change.
  - `docs/cli-reference.md` and `docs/onboarding-guide.md` — whenever user-facing behavior changes.
- Keep command modules thin. Reusable business logic belongs in `apps/cli/src/core/`. Re-export new reusable functions from `apps/cli/src/core/index.ts` and `apps/cli/src/index.ts` when external callers should be able to import them.
- See `references/developer-map.md` for the full source layout.

## Validation

- Skill-only edits: `pnpm validate:skill` from the repo root, and inspect `agents/openai.yaml`.
- CLI or behavior changes:

  ```bash
  pnpm check
  pnpm typecheck
  pnpm --filter @agent-team-foundation/first-tree-hub test
  ```

- Add targeted package tests when you change runtime behavior.

## References

- `references/command-surface.md` — exhaustive command catalog, including the credential model, scopes, env vars, and admin API endpoints the CLI calls.
- `references/scenario-playbooks.md` — request-to-command playbooks (install, connect, onboard, debug, deploy).
- `references/onboarding-operator.md` — automation-friendly onboarding instructions that start from a prompt, not a local checkout.
- `references/core-concepts.md` — product boundaries, architecture invariants, runtime mental models.
- `references/developer-map.md` — package ownership, source-file entry points, change workflows.
