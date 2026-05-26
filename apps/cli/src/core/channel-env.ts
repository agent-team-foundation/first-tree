// Side-effect module: sets `FIRST_TREE_HOME` from the channel default if
// it isn't already in the environment. The CLI entry imports this as its
// first statement so the env is in place before any command handler runs
// `defaultHome()` / `defaultConfigDir()` / `defaultDataDir()` from
// `@first-tree/shared/config`.
//
// History note: an earlier version of `resolver.ts` exported the home
// path as a top-level `const` evaluated at module load. After tsdown
// bundling, ESM hoists every chunk's top-level evaluation to BEFORE the
// importing module's body — so the const locked to the prod fallback
// (`~/.first-tree`) before this side-effect ran, silently making
// staging / dev daemons write into the prod home. Resolver is now
// function-based (lazy env read at call time), which removes the
// ordering constraint — this module just needs to run sometime before
// the first config call, which the CLI entry guarantees by importing it
// first.
//
// Falsy check (not `=== undefined`): an externally-set `FIRST_TREE_HOME=""`
// (empty string) is treated as "not set" — matches the resolver's `??`
// fallback behaviour and avoids silent reads of an empty path.
import { channelConfig } from "./channel.js";

if (!process.env.FIRST_TREE_HOME) {
  process.env.FIRST_TREE_HOME = channelConfig.defaultHome;
}
