# First Tree Hub Developer Map

## Repo Entry Points

- `AGENTS.md`
  - Architecture rules, conventions, package map, and development workflow
- `README.md`
  - Product framing, quick start, and top-level documentation links
- `docs/cli-reference.md`
  - Public command and environment variable reference
- `docs/onboarding-guide.md`
  - End-to-end onboarding flow
- `docs/claim-agent-guide.md`
  - Claim and Feishu binding details

## CLI Source Map

- `packages/command/src/cli/index.ts`
  - Top-level Commander program and command registration
- `packages/command/src/commands/server.ts`
  - `server` subcommands
- `packages/command/src/commands/client.ts`
  - `client` subcommands
- `packages/command/src/commands/agent.ts`
  - local agent management, bindings, workspace cleanup, messaging utilities
- `packages/command/src/commands/config.ts`
  - scope-aware config set/get/list/setup flows
- `packages/command/src/commands/status.ts`
  - top-level overview command
- `packages/command/src/commands/onboard.ts`
  - high-level interactive entry for onboarding

## Reusable Core Logic

- `packages/command/src/core/server.ts`
  - orchestration for `server start`, including config prompts, Docker PostgreSQL, migrations, admin creation, and web dist resolution
- `packages/command/src/core/onboard.ts`
  - Context Tree checkout, member file generation, verification, PR creation, and post-merge continuation flow
- `packages/command/src/core/bootstrap.ts`
  - token bootstrap helpers and server URL resolution
- `packages/command/src/core/doctor.ts`
  - readiness checks used by `server doctor` and `client doctor`
- `packages/command/src/core/feishu.ts`
  - Feishu binding helpers
- `packages/command/src/core/prompt.ts`
  - schema-driven prompting behavior

If you change command behavior, there is a good chance the real logic belongs in one of these core modules rather than in the command handler itself.

## Shared Config and Schema Files

- `packages/shared/src/config/server-config.ts`
  - server config schema, defaults, prompts, env names
- `packages/shared/src/config/client-config.ts`
  - client config schema
- `packages/shared/src/config/agent-config.ts`
  - agent config schema
- `packages/shared/src/config/resolver.ts`
  - config priority resolution, YAML reading/writing, auto-generation

If a flag, env var, or config key changes, inspect these files and update docs accordingly.

## Client and Server Runtime Files

- `packages/client/src/sdk.ts`
  - agent SDK surface used by debugging flows and runtime internals
- `packages/client/src/runtime/runtime.ts`
  - runtime orchestration for configured agents
- `packages/client/src/runtime/bootstrap.ts`
  - Context Tree clone sync and `.agent/` workspace bootstrap
- `packages/client/src/runtime/session-manager.ts`
  - session lifecycle and dedup-sensitive message dispatch
- `packages/server/src/app.ts`
  - server wiring, route registration, background jobs, Context Tree sync start
- `packages/server/src/services/inbox.ts`
  - inbox poll/ack/renew behavior
- `packages/server/src/services/context-tree-graphql.ts`
  - Context Tree member fetch and sync behavior

## Change Patterns

### Add or change a CLI command

1. Update or add the command handler in `packages/command/src/commands/`.
2. Move reusable logic into `packages/command/src/core/`.
3. Register the command from `packages/command/src/cli/index.ts` if it is new.
4. Update barrel exports if the functionality should be imported by external consumers.
5. Update `docs/cli-reference.md`.

### Change onboarding behavior

1. Update `packages/command/src/commands/onboard.ts` only for argument shape or interaction flow.
2. Put the real behavior in `packages/command/src/core/onboard.ts`.
3. Update `docs/onboarding-guide.md`.
4. Update `docs/claim-agent-guide.md` too if claim or binding behavior changes.

### Change config behavior

1. Update the relevant schema under `packages/shared/src/config/`.
2. Check whether prompt text, defaults, env names, or secret masking rules also need changes.
3. Update `docs/cli-reference.md`.
4. Re-test the matching `config`, `server`, or `client` flows.

### Change messaging or agent runtime behavior

1. Start with `packages/command/src/commands/agent.ts` if the CLI surface changes.
2. Inspect `packages/client/src/sdk.ts` and `packages/client/src/runtime/` if client runtime semantics change.
3. Inspect `packages/server/src/api/agent/` and `packages/server/src/services/` if server contracts change.
4. Update shared schemas in `packages/shared/src/schemas/` when payload shapes change.

## Validation Commands

Run the smallest relevant set first, then expand if the change touches cross-package behavior.

```bash
pnpm check
pnpm typecheck
pnpm --filter @agent-team-foundation/first-tree-hub test
pnpm --filter @first-tree-hub/client test
pnpm --filter @first-tree-hub/server test
```

Use the package-specific commands when only one area changed, but keep in mind that the command package depends on shared behavior in `client`, `server`, and `shared`.

## External Consumption

The published CLI package is `@agent-team-foundation/first-tree-hub`.

Its public CLI binary is:

```bash
first-tree-hub
```

Its reusable code surface is also intended to be importable by other tools. When you add reusable CLI-adjacent behavior, preserve that separation:

- thin command handler for argument parsing
- reusable `core/*` function for behavior
- re-export through `packages/command/src/index.ts` when appropriate
