// Vitest global setup. Installs a default CLI binding so every test file
// that reaches `bootstrap.ts` (directly via `bootstrapWorkspace` or
// indirectly through a handler's `start()`) sees a populated binding. The
// CLI entrypoint (`apps/cli/src/core/channel-env.ts`) installs this in
// production from `channelConfig`; tests don't go through that entry, so we
// pin a prod-shaped default here.
//
// Individual tests can override with `setCliBinding({...})` and reset in
// their own `afterEach` — see `__tests__/bootstrap.test.ts` for the
// staging/dev channel cases.
//
// Pre-2026-06: this file also called `__setTestInstallExec(() => {})` to
// neuter the shell-out to `first-tree tree skill install`. That shell-out
// is gone — Client now installs skill payloads in-process from the bundled
// `packages/client/skills/` directory (see `runtime/first-tree-skills/
// installer.ts`). The skills/ directory is materialised by the `pretest`
// hook in `package.json`, so every test file has bundled skills on disk
// without any per-suite setup.
import { setCliBinding } from "./src/runtime/cli-binding.js";

setCliBinding({ binName: "first-tree", packageName: "first-tree" });
