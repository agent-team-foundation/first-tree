import os from "node:os";

// File-level parallelism cap for vitest. Lives in src/ so global-setup.ts can
// import it under tsc's rootDir constraint; vitest.config.ts also imports it.
//
// Each fork loads fastify+drizzle+otel+pino — at 4 forks on a 16 GB WSL box
// we triggered OOM. 2 forks halves wall-clock without the memory pressure.
// Override via `VITEST_MAX_FORKS` if a beefier CI box can afford more.
const envCap = Number.parseInt(process.env.VITEST_MAX_FORKS ?? "", 10);
export const MAX_FORKS =
  Number.isFinite(envCap) && envCap > 0 ? envCap : Math.min(2, Math.max(1, (os.cpus().length || 2) - 1));

export const WORKER_DB_PREFIX = "vitest_w";
export const TEMPLATE_DB = "vitest_template";
