// Vitest global setup. Installs a default CLI binding so every test file
// that reaches `bootstrap.ts` (directly via `bootstrapWorkspace` /
// `installFirstTreeIntegration` or indirectly through a handler's
// `start()`) sees a populated binding. The CLI entrypoint
// (`apps/cli/src/core/channel-env.ts`) installs this in production
// from `channelConfig`; tests don't go through that entry, so we pin a
// prod-shaped default here.
//
// Individual tests can override with `setCliBinding({...})` and reset in
// their own `afterEach` — see `__tests__/bootstrap.test.ts` for the
// staging/dev channel cases.
import { setCliBinding } from "./src/runtime/cli-binding.js";

setCliBinding({ binName: "first-tree", packageName: "first-tree" });
