import type { PulseBucket } from "../../../hooks/pulse-context.js";
import { cn } from "../../../lib/utils.js";

const BAR_COUNT = 32;

export function PulseBar({
  aggregated,
  stale,
  className,
}: {
  aggregated: PulseBucket[];
  stale: boolean;
  className?: string;
}) {
  const max = Math.max(1, ...aggregated.map((b) => b.workingCount));

  return (
    <div
      className={cn("flex items-end gap-[2px]", stale && "opacity-40", className)}
      style={{ height: 22 }}
      aria-hidden
    >
      {Array.from({ length: BAR_COUNT }).map((_, i) => {
        const bucket = aggregated[i] ?? { workingCount: 0, errorMask: false };
        const normalized = bucket.workingCount === 0 ? 0.08 : bucket.workingCount / max;
        const opacity = 0.25 + normalized * 0.7;
        const background = bucket.errorMask ? "var(--state-error)" : "var(--accent)";
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length deterministic bucket index
            key={i}
            className="flex-1"
            style={{
              height: `${Math.max(12, normalized * 100)}%`,
              background,
              opacity,
              borderRadius: 0.5,
            }}
          />
        );
      })}
    </div>
  );
}
