// File-level parallelism cap for vitest. Lives in src/ so global-setup.ts can
// import it under tsc's rootDir constraint; vitest.config.ts also imports it.
//
// Defaults:
//  * Local: hard 2 — not a cpu-count formula — because 4+ forks tripped OOM
//    on a 16 GB box (`isolate: false` keeps fastify+otel+pino module state
//    alive in each fork). Workers are PG-IO-bound, so 2 forks is enough.
//  * CI / GITHUB_ACTIONS: 1 — GH `ubuntu-latest` is ~7GB and turbo runs
//    several packages at once; stacked forks OOM'd sibling CLI workers.
//
// Override via `VITEST_MAX_FORKS` for beefier CI runners or to bisect.
const envCap = Number.parseInt(process.env.VITEST_MAX_FORKS ?? "", 10);
const isCi = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
export const MAX_FORKS = Number.isFinite(envCap) && envCap > 0 ? envCap : isCi ? 1 : 2;

export const WORKER_DB_PREFIX = "vitest_w";
export const TEMPLATE_DB = "vitest_template";
/** Per-worker attachment bucket names: `attachments-w1..wN` (see setup.ts). */
export const WORKER_BUCKET_PREFIX = "attachments-w";
