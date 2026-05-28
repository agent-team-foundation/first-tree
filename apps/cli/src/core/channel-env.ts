// Side-effect module: channel-derived process setup that must run before
// any code touches `@first-tree/shared/config` (for FIRST_TREE_HOME) or
// `@first-tree/client` runtime helpers (for the CLI binding). The CLI
// entry imports this as its first statement.
//
// Two wires here, same lifecycle reason — both are "translate the
// build-time channel constant into runtime state the rest of the process
// will read lazily":
//
// 1. `FIRST_TREE_HOME` env from the channel default. Resolver
//    (`defaultHome()` / `defaultConfigDir()` / `defaultDataDir()`) reads
//    this env at call time, so we just have to set it before the first
//    config call — which the CLI entry guarantees by importing this
//    first.
// 2. CLI binding (binName + packageName) into `@first-tree/client` so
//    runtime helpers — bootstrap.ts's `generateToolsDoc`,
//    `installFirstTreeIntegration`, claude-code's NHA deny redirect —
//    emit the correct binary name (`first-tree` / `first-tree-staging`
//    / `first-tree-dev`) and the right npm package for `npx
//    <pkg>@latest` fallbacks. Pre-multi-env these all baked "first-tree"
//    into the agent-facing tools.md, so staging / dev agents called a
//    binary that wasn't installed.
//
// History note (FIRST_TREE_HOME): an earlier version of `resolver.ts`
// exported the home path as a top-level `const` evaluated at module
// load. After tsdown bundling, ESM hoists every chunk's top-level
// evaluation to BEFORE the importing module's body — so the const
// locked to the prod fallback (`~/.first-tree`) before this side-effect
// ran, silently making staging / dev daemons write into the prod home.
// Resolver is now function-based (lazy env read at call time), which
// removes the ordering constraint.
//
// Falsy check on FIRST_TREE_HOME (not `=== undefined`): an
// externally-set `FIRST_TREE_HOME=""` (empty string) is treated as "not
// set" — matches the resolver's `??` fallback behaviour and avoids
// silent reads of an empty path.
//
// Imported by every entrypoint that boots `ClientRuntime`:
//   - `apps/cli/src/cli/index.ts` (production CLI entry — daemon,
//     login, …)
//   - `apps/cli/scripts/e2e-auto-agent-add.ts` (dev smoke that starts a
//     real ClientRuntime without going through Commander)
import { setCliBinding } from "@first-tree/client";
import { channelConfig } from "./channel.js";

if (!process.env.FIRST_TREE_HOME) {
  process.env.FIRST_TREE_HOME = channelConfig.defaultHome;
}

setCliBinding({ binName: channelConfig.binName, packageName: channelConfig.packageName });
