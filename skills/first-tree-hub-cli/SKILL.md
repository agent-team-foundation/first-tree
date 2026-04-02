---
name: first-tree-hub-cli
description: Operate and modify First Tree Hub with emphasis on the unified `first-tree-hub` CLI, its `server`, `client`, `agent`, `config`, `status`, and `onboard` workflows, and the repo's collaboration model around Context Tree sync, inbox delivery, and workspace bootstrap. Use when Codex needs to run or debug Hub commands, choose the right CLI flow for a user request, explain how First Tree Hub works, or change code in `packages/command`, `packages/client`, `packages/server`, or `packages/shared` that affects CLI behavior.
---

# First Tree Hub CLI

## Overview

Use this skill to map user intent onto the correct First Tree Hub command or code path without re-discovering the whole monorepo each time.
Keep the central mental model straight: First Tree Hub is the communication backbone for agent teams. It is not the agent framework, not the orchestration engine, and not the Context Tree itself.

## Start Here

1. Classify the task before acting.
   - Operate or diagnose a Hub deployment: read `references/command-surface.md`
   - Explain product or architecture concepts: read `references/core-concepts.md`
   - Modify CLI or related behavior in code: read `references/developer-map.md`
2. Prefer existing CLI workflows over manual edits when the repo already has a supported path.
   - Use `onboard` for member onboarding
   - Use `config` for config inspection and updates
   - Use `server start` or `client start` instead of stitching together ad hoc boot flows
3. Read the canonical repo docs directly when the task becomes specialized.
   - `docs/cli-reference.md` for exact flags and environment variables
   - `docs/onboarding-guide.md` for the full onboarding flow
   - `docs/claim-agent-guide.md` when claim or binding flows matter
   - `docs/deployment-guide.md` for Docker, cloud deploy, HTTPS, and production setup

## Operating Rules

- Keep subsystem boundaries clear.
  - `server` manages Hub server lifecycle, database setup, migrations, and admin users.
  - `client` runs configured agents and hydrates their local workspaces and context.
  - `agent` manages local agent configs, tokens, bindings, workspace cleanup, and debug messaging.
  - `config` edits YAML-backed config by scope.
  - `status` is read-only overview.
  - `onboard` is the high-level member onboarding flow.
- Remember the identity model.
  - Agent identities come from the Context Tree repo and sync into Hub.
  - Hub does not author identities directly; it reads them and turns them into runtime infrastructure.
- Respect auth isolation.
  - Admin JWT and agent Bearer token are separate paths.
  - Messaging and low-level agent commands usually require `FIRST_TREE_HUB_TOKEN`.
- Respect config layering.
  - CLI args override env vars, env vars override YAML config, YAML overrides auto-generated values, auto-generated values override defaults.
- Distinguish config scopes and paths.
  - Server: `~/.first-tree-hub/config/server.yaml`
  - Client: `~/.first-tree-hub/config/client.yaml`
  - Agent: `~/.first-tree-hub/config/agents/<name>/agent.yaml`
- Do not describe Hub as "the agents" or "the Context Tree". It sits between them.

## Common Workflows

### Choose a Command

- First local boot or quick demo: `first-tree-hub server start`
- Environment readiness: `first-tree-hub server doctor`, `first-tree-hub client doctor`, or top-level `first-tree-hub status`
- Add a local runtime agent config: `first-tree-hub agent add`, then `first-tree-hub client start`
- Bootstrap or recover agent access: `first-tree-hub agent token bootstrap`
- Debug agent messaging manually: `first-tree-hub agent send`, `agent chats`, `agent history`, `agent pull`
- Clean stale chat workspaces: `first-tree-hub agent workspace clean`
- Onboard a new human or autonomous agent end to end: `first-tree-hub onboard`

### Modify Code Safely

- For new or changed CLI behavior, inspect:
  - `packages/command/src/commands/*.ts` for command registration and args
  - `packages/command/src/core/*.ts` for reusable logic
  - `packages/shared/src/config/*` if flags, env vars, or config schema change
  - `docs/cli-reference.md` and `docs/onboarding-guide.md` if user-facing behavior changes
- Keep command modules thin. Reusable business logic belongs in `packages/command/src/core/`.
- Re-export new reusable core functions from `packages/command/src/core/index.ts` and `packages/command/src/index.ts` when external callers should be able to import them.

## Validation

- For skill-only documentation work, run the skill validator and inspect `agents/openai.yaml`.
- For CLI or behavior changes, prefer:

```bash
pnpm check
pnpm typecheck
pnpm --filter @agent-team-foundation/first-tree-hub test
```

- Add more targeted package tests when you change runtime behavior.

## References

- `references/command-surface.md` for command selection, command semantics, env vars, and common workflows
- `references/core-concepts.md` for product boundaries, architecture invariants, and runtime mental models
- `references/developer-map.md` for package ownership, source-file entry points, and change workflows
