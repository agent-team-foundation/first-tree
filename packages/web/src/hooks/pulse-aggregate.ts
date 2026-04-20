import type { PulseBucket } from "@agent-team-foundation/first-tree-hub-shared";

export const EMPTY_BUCKETS: PulseBucket[] = Array.from({ length: 32 }, () => ({ workingCount: 0, errorMask: false }));

export function aggregate(agents: Record<string, PulseBucket[]>): PulseBucket[] {
  const out: PulseBucket[] = Array.from({ length: 32 }, () => ({ workingCount: 0, errorMask: false }));
  for (const perAgent of Object.values(agents)) {
    for (let i = 0; i < 32 && i < perAgent.length; i++) {
      const src = perAgent[i];
      const dst = out[i];
      if (!src || !dst) continue;
      dst.workingCount += src.workingCount;
      dst.errorMask = dst.errorMask || src.errorMask;
    }
  }
  return out;
}
