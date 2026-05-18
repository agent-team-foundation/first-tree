/**
 * In-memory boot progress mirror used by /readyz and structured stage logs.
 * Process-scoped — there is exactly one bootstrap per process. See
 * docs/server-bootstrap-resilience-design.md §3 (T5/T6).
 */

export type StageStatus = "pending" | "in_progress" | "done" | "failed";

export type StageInfo = {
  status: StageStatus;
  durationMs?: number;
  error?: string;
};

export type BootstrapState = {
  startedAt: Date;
  stages: Record<string, StageInfo>;
  readyAt: Date | null;
};

export const bootstrapState: BootstrapState = {
  startedAt: new Date(),
  stages: {},
  readyAt: null,
};

export function markStage(name: string, patch: Partial<StageInfo>): void {
  const existing = bootstrapState.stages[name] ?? { status: "pending" as StageStatus };
  bootstrapState.stages[name] = { ...existing, ...patch };
}

export function markReady(): void {
  bootstrapState.readyAt = new Date();
}
