// Disables zod v4's JIT-compiled object parsers before any shared schema
// module evaluates.
//
// Why this exists: zod v4 probes eval support with `new Function(...)` the
// first time an object schema is constructed (zod's util.allowsEval). Under
// the enforced Content-Security-Policy (no script-src 'unsafe-eval') the
// browser blocks that probe; zod catches it and falls back to jitless, but
// the CSP violation is still reported to the console — failing the "zero CSP
// violations" bar for issue 1541. Configuring `jitless: true` up front skips
// the probe entirely.
//
// Load order is the contract: ESM evaluates imports depth-first in
// declaration order, and main.tsx imports this module first, so the config
// lands before any @first-tree/shared schema module is evaluated. Do not move
// it below other imports in main.tsx.
import { config } from "zod";

config({ jitless: true });
