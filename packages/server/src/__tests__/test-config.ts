// File-level parallelism cap for vitest. Lives in src/ so global-setup.ts can
// import it under tsc's rootDir constraint; vitest.config.ts also imports it.
//
// Default is a hard 2 — not a cpu-count formula — because:
//  * 4+ forks tripped OOM locally on a 16 GB box (`isolate: false` keeps
//    fastify+otel+pino module state alive in each fork).
//  * GitHub-hosted `ubuntu-latest` runners are 2-core; a `cpus - 1` formula
//    would silently degrade to 1 fork there and erase the speedup. Hardcoded
//    2 keeps file parallelism on in CI without overcommitting (workers are
//    PG-IO-bound, so 2-on-2-cores doesn't thrash CPU).
//
// Override via `VITEST_MAX_FORKS` for beefier CI runners or to bisect.
const envCap = Number.parseInt(process.env.VITEST_MAX_FORKS ?? "", 10);
export const MAX_FORKS = Number.isFinite(envCap) && envCap > 0 ? envCap : 2;

export const WORKER_DB_PREFIX = "vitest_w";
export const TEMPLATE_DB = "vitest_template";
