---
name: first-tree-hub-cli
description: Install, operate, deploy, and modify First Tree Hub with emphasis on the unified `first-tree-hub` CLI, its `server`, `client`, `agent`, `config`, `status`, and `onboard` workflows, and the repo's collaboration model around agent management, inbox delivery, and workspace bootstrap. Use when Codex needs to install or verify the CLI on a fresh machine, run or debug Hub commands, choose the right CLI flow for a user request, explain how First Tree Hub works, or change code in `packages/command`, `packages/client`, `packages/server`, or `packages/shared` that affects CLI behavior.
---

# First Tree Hub CLI

## Overview

Use this skill to map user intent onto the correct First Tree Hub command or code path without re-discovering the whole monorepo each time.
Keep the central mental model straight: First Tree Hub is the communication backbone for agent teams. It is not the agent framework, not the orchestration engine, and not the Context Tree itself.

## Start Here

1. Read `references/portable-quickstart.md`.
2. Classify the task before acting.
   - Install or sanity-check the CLI on a fresh machine: read `references/command-surface.md` first, then `README.md` or `docs/claim-agent-guide.md`
   - Operate or diagnose a Hub deployment: read `references/command-surface.md`
   - Map a natural-language request to an end-to-end CLI flow: read `references/scenario-playbooks.md`
   - Execute or automate member onboarding from an external agent prompt: read `references/onboarding-operator.md`
   - Explain product or architecture concepts: read `references/core-concepts.md`
   - Modify CLI or related behavior in code: read `references/developer-map.md`
3. Prefer existing CLI workflows over manual edits when the repo already has a supported path.
   - Use `onboard` for member onboarding
   - Use `config` for config inspection and updates
   - Use `server start` or `client start` instead of stitching together ad hoc boot flows
4. Read the canonical repo docs directly when the task becomes specialized.
   - `docs/cli-reference.md` for exact flags and environment variables
   - `docs/onboarding-guide.md` for the full onboarding flow
   - `docs/claim-agent-guide.md` when claim or binding flows matter
   - `docs/deployment-guide.md` for Docker, cloud deploy, HTTPS, and production setup
5. On a fresh machine, verify prerequisites before proposing a flow.
   - Node.js `>= 22.16`
   - Install with `npm install -g @agent-team-foundation/first-tree-hub`
   - Verify with `first-tree-hub --version`
   - If using `onboard` or `agent token bootstrap`, make sure `gh` is installed and authenticated
6. If you are maintaining the skill inside the live repo, `.agents/skills/` and `.claude/skills/` are symlinks to `skills/` — no sync step is needed.

## Operating Rules

- Keep subsystem boundaries clear.
  - `server` manages Hub server lifecycle, database setup, migrations, and admin users.
  - `client` runs configured agents and hydrates their local workspaces and context.
  - `agent` manages local agent configs, tokens, bindings, workspace cleanup, and debug messaging.
  - `config` edits YAML-backed config by scope.
  - `status` is read-only overview.
  - `onboard` is the high-level member onboarding flow.
- Remember the identity model.
  - Agent identities are managed by Hub via Admin API.
  - Context Tree integration is optional — when configured, Client injects organizational context into agent workspaces.
- Respect auth isolation.
  - Admin JWT and agent Bearer token are separate paths.
  - Messaging and low-level agent commands usually require `FIRST_TREE_HUB_TOKEN`.
- Keep the server URL knobs straight.
  - `FIRST_TREE_HUB_SERVER_URL` is the client-config environment variable and is what `client doctor` expects.
  - `FIRST_TREE_HUB_SERVER` is the direct override for `onboard` and low-level agent debugging commands.
- Respect config layering.
  - CLI args override env vars, env vars override YAML config, YAML overrides auto-generated values, auto-generated values override defaults.
- Distinguish config scopes and paths.
  - Home defaults to `~/.first-tree-hub`, but `FIRST_TREE_HUB_HOME` can relocate it.
  - Server: `$FIRST_TREE_HUB_HOME/config/server.yaml`
  - Client: `$FIRST_TREE_HUB_HOME/config/client.yaml`
  - Agent: `$FIRST_TREE_HUB_HOME/config/agents/<name>/agent.yaml`
  - Onboard resume state: `$FIRST_TREE_HUB_HOME/.onboard-state.json`
- Do not describe Hub as "the agents" or "the Context Tree". It sits between them.

## Common Workflows

### Choose a Command

- First local boot or quick demo: `first-tree-hub server start`
- Fresh machine install or verification: `npm install -g @agent-team-foundation/first-tree-hub`, then `first-tree-hub --version`
- Environment readiness: `first-tree-hub server doctor`, `first-tree-hub client doctor`, or top-level `first-tree-hub status`
- Add a local runtime agent config: `first-tree-hub agent add`, then `first-tree-hub client start`
- Bootstrap or recover agent access: `first-tree-hub agent token bootstrap`
- Debug agent messaging manually: `first-tree-hub agent send`, `agent chats`, `agent history`, `agent pull`
- Clean stale chat workspaces: `first-tree-hub agent workspace clean`
- Onboard a new human or autonomous agent end to end: `first-tree-hub onboard`

### Run Onboarding From an Agent Prompt

- Treat onboarding as a supported CLI workflow, not as a manual repo-edit task.
- If the environment does not already have the repo checked out or the CLI installed:
  - Ensure `gh` is available and authenticated.
  - Install the published package.
    - Prefer `npm install -g @agent-team-foundation/first-tree-hub` when you need the `first-tree-hub` binary on `PATH`.
    - If the caller explicitly used `npm i @agent-team-foundation/first-tree-hub`, run the CLI with `npx first-tree-hub ...`.
  - Read the canonical onboarding guide with `gh` before acting, for example:

```bash
gh api repos/agent-team-foundation/first-tree-hub/contents/docs/onboarding-guide.md?ref=main --jq .content | base64 --decode
```

- Use any server URL supplied by the user or automation in every onboarding step via `--server <url>` when available.
- Default operator flow:

```bash
first-tree-hub onboard --check ...
first-tree-hub onboard --server <url> ...
first-tree-hub client start
```

- Prefer `onboard --check` before asking follow-up questions or creating the agent.
- Ensure admin credentials are available (`FIRST_TREE_HUB_ADMIN_TOKEN` or `FIRST_TREE_HUB_ADMIN_USERNAME` + `FIRST_TREE_HUB_ADMIN_PASSWORD`).

### Modify Code Safely

- For new or changed CLI behavior, inspect:
  - `packages/command/src/commands/*.ts` for command registration and args
  - `packages/command/src/core/*.ts` for reusable logic
  - `packages/shared/src/config/*` if flags, env vars, or config schema change
  - `docs/cli-reference.md` and `docs/onboarding-guide.md` if user-facing behavior changes
- Keep command modules thin. Reusable business logic belongs in `packages/command/src/core/`.
- Re-export new reusable core functions from `packages/command/src/core/index.ts` and `packages/command/src/index.ts` when external callers should be able to import them.

## Validation

- For skill-only documentation work, run `pnpm validate:skill` from the repo root and inspect `agents/openai.yaml`.
- For CLI or behavior changes, prefer:

```bash
pnpm check
pnpm typecheck
pnpm --filter @agent-team-foundation/first-tree-hub test
```

- Add more targeted package tests when you change runtime behavior.

## References

- `references/portable-quickstart.md` for installation and usage guidance when the skill is copied elsewhere
- `references/command-surface.md` for command selection, command semantics, env vars, and common workflows
- `references/scenario-playbooks.md` for request-to-command playbooks and end-to-end operator flows
- `references/onboarding-operator.md` for automation-friendly onboarding instructions that start from a prompt instead of a local repo checkout
- `references/core-concepts.md` for product boundaries, architecture invariants, and runtime mental models
- `references/developer-map.md` for package ownership, source-file entry points, and change workflows
