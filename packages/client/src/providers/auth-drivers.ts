import type { RuntimeAuthProvider } from "@first-tree/shared";
import { createClaudeAuthDriver } from "../runtime/claude-login.js";
import { createCodexAuthDriver } from "../runtime/codex-login.js";
import { createCursorAuthDriver } from "../runtime/cursor-login.js";
import type { RuntimeAuthDriver } from "./auth-driver.js";
import { createGrokAuthDriver } from "./grok/login.js";

/**
 * Exhaustive over {@link RuntimeAuthProvider} - the narrow, server-accepted
 * auth target set, not the full runtime-provider enum. Kimi, OpenCode and Pi
 * keep provider-owned host login, and `claude-code-tui` shares Claude Code's
 * credential rather than being its own target, so none of them is a key here.
 */
export type RuntimeAuthDriverTable = Readonly<Record<RuntimeAuthProvider, RuntimeAuthDriver>>;

/**
 * The one composition root allowed to name concrete runtime-auth providers.
 *
 * `satisfies Record<RuntimeAuthProvider, RuntimeAuthDriver>` makes the key set
 * an exhaustive projection of `runtimeAuthProviderSchema`: extending that Zod
 * enum fails this file to compile until a driver exists, and there is no second
 * handwritten list of known auth providers to drift from it. Everything
 * downstream dispatches by typed key, so no other module needs a provider
 * branch.
 */
export const RUNTIME_AUTH_DRIVERS: RuntimeAuthDriverTable = Object.freeze({
  "claude-code": createClaudeAuthDriver(),
  codex: createCodexAuthDriver(),
  cursor: createCursorAuthDriver(),
  grok: createGrokAuthDriver(),
} satisfies Record<RuntimeAuthProvider, RuntimeAuthDriver>);
