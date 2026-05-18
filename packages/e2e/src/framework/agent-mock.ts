import { resolve } from "node:path";
import { PACKAGE_E2E_ROOT } from "./env.js";

/**
 * Path to the bundled fake `claude-code` binary the e2e framework hands to
 * any consumer that needs the agent runtime intercepted. Set
 * `CLAUDE_CODE_EXECUTABLE` (or the SDK's `pathToClaudeCodeExecutable`
 * option) to this path and the Claude Agent SDK will spawn it instead of
 * the real upstream binary. The fake speaks the stream-json contract
 * documented inline in `src/mocks/fake-claude-code.mjs`.
 *
 * Why a file path, not a `spawn()` factory: the SDK only exposes a path
 * option (or a private `spawnClaudeCodeProcess` callback used at SDK call
 * site). The path knob is the only thing reachable from outside the client
 * runtime without modifying source — and we can't modify source per the
 * reverse-import constraint.
 */
export const FAKE_CLAUDE_CODE_EXECUTABLE = resolve(PACKAGE_E2E_ROOT, "src/mocks/fake-claude-code.mjs");
