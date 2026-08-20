import {
  clientWireCapabilitiesSchema,
  type RuntimeInstallProgressStatus,
  type RuntimeInstallProvider,
  type RuntimeInstallResultFrame,
} from "@first-tree/shared";

/** Installer hard timeout is eight minutes; leave thirty seconds for the result frame. */
export const RUNTIME_INSTALL_REPLY_TIMEOUT_MS = 8 * 60 * 1000 + 30_000;

type RuntimeInstallProgress = {
  clientId: string;
  provider: RuntimeInstallProvider;
  statuses: RuntimeInstallProgressStatus[];
};

const progressByRef = new Map<string, RuntimeInstallProgress>();

/** Start tracking only the in-memory progress needed by one live HTTP request. */
export function beginRuntimeInstallProgress(clientId: string, provider: RuntimeInstallProvider, ref: string): void {
  progressByRef.set(ref, { clientId, provider, statuses: [] });
}

/** Record valid ordered progress; duplicates and out-of-order frames are ignored. */
export function recordRuntimeInstallProgress(clientId: string, result: RuntimeInstallResultFrame): void {
  const progress = progressByRef.get(result.ref);
  if (!progress || progress.clientId !== clientId || progress.provider !== result.provider) return;
  if (result.status === "accepted" && progress.statuses.length === 0) {
    progress.statuses.push("accepted");
    return;
  }
  if (result.status === "in-progress" && progress.statuses.length === 1 && progress.statuses[0] === "accepted") {
    progress.statuses.push("in-progress");
  }
}

/** Return and delete the observed progress for a completed/failed HTTP request. */
export function takeRuntimeInstallProgress(clientId: string, ref: string): RuntimeInstallProgressStatus[] {
  const progress = progressByRef.get(ref);
  if (!progress || progress.clientId !== clientId) return [];
  progressByRef.delete(ref);
  return [...progress.statuses];
}

export function metadataSupportsRuntimeInstallV1(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const wire = (metadata as Record<string, unknown>).wireCapabilities;
  const parsed = clientWireCapabilitiesSchema.safeParse(wire);
  return parsed.success && parsed.data.runtimeInstallV1 === true;
}

export function runtimeInstallClientLiveness(
  client: { status: string; instanceId: string | null; lastSeenAt: Date },
  now: Date,
  staleSeconds: number,
): "live" | "disconnected" | "stale" {
  if (client.status !== "connected" || !client.instanceId) return "disconnected";
  if (now.getTime() - client.lastSeenAt.getTime() > staleSeconds * 1000) return "stale";
  return "live";
}
