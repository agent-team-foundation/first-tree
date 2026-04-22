import { createRequire } from "node:module";

/**
 * Version of the consumer-facing `@agent-team-foundation/first-tree-hub`
 * package. Read once at module load from the bundled `package.json` so the
 * CLI, client runtime, and server bootstrap all quote the same string.
 */
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version?: string };

export const COMMAND_VERSION: string =
  typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
