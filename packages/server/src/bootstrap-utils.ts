import { performance } from "node:perf_hooks";
import { markStage } from "./bootstrap-state.js";
import { createLogger } from "./observability/index.js";

const log = createLogger("Bootstrap");

/**
 * Race a promise against a timeout. Rejects with a stage-tagged Error so the
 * stderr message identifies which boot phase stalled. See
 * docs/server-bootstrap-resilience-design.md §3 (T4).
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`bootstrap stage "${stage}" timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run a bootstrap stage with structured `bootstrap.stage.{start,done,failed}`
 * logs, a stage-tagged timeout, and side-effect updates to the shared
 * `bootstrapState` (consumed by /readyz).
 */
export async function runStage<T>(name: string, fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  log.info({ stage: name }, "bootstrap.stage.start");
  markStage(name, { status: "in_progress" });
  const t0 = performance.now();
  try {
    const result = await withTimeout(fn(), timeoutMs, name);
    const stageMs = Math.round(performance.now() - t0);
    markStage(name, { status: "done", durationMs: stageMs });
    log.info({ stage: name, stageMs }, "bootstrap.stage.done");
    return result;
  } catch (err) {
    const stageMs = Math.round(performance.now() - t0);
    const message = err instanceof Error ? err.message : String(err);
    markStage(name, { status: "failed", durationMs: stageMs, error: message });
    log.error({ stage: name, stageMs, err }, "bootstrap.stage.failed");
    throw err;
  }
}
