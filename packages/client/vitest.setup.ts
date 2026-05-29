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
import { __setTestInstallExec } from "./src/runtime/bootstrap.js";
import { setCliBinding } from "./src/runtime/cli-binding.js";

setCliBinding({ binName: "first-tree", packageName: "first-tree" });

// Globally neuter the install-exec backend so handler-level tests that go
// through `handler.start()` do not shell out for `installCoreSkills` or
// `installFirstTreeIntegration`. Individual tests that DO want to verify
// the shell-out (`bootstrap.test.ts` integration-style cases) pass their
// own `exec` callback to `installFirstTreeIntegration` / `installCoreSkills`
// directly, which bypasses `defaultInstallExec` (and therefore this
// override). Production runtime is unaffected — the override is only set
// during vitest runs.
__setTestInstallExec(() => {
  // no-op
});
