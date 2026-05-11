import { cn } from "../../lib/utils.js";

export type AgentState = "idle" | "working" | "blocked" | "error" | "offline";

type StateDotProps = {
  state: AgentState;
  size?: number;
  className?: string;
};

export function StateDot({ state, size = 8, className }: StateDotProps) {
  const base: React.CSSProperties = {
    width: size,
    height: size,
    display: "inline-block",
    position: "relative",
    flexShrink: 0,
  };

  if (state === "working") {
    return (
      <span className={cn("shrink-0", className)} style={base} role="img" aria-label="working">
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background: "var(--state-working)",
          }}
        />
        <span
          style={{
            position: "absolute",
            inset: -3,
            borderRadius: "50%",
            border: "var(--hairline) solid var(--state-working)",
            animation: "ring-pulse 1.8s infinite",
            opacity: 0.6,
          }}
        />
      </span>
    );
  }

  if (state === "blocked") {
    return (
      <span
        className={cn("shrink-0", className)}
        style={{
          ...base,
          border: "var(--hairline-bold) dashed var(--state-blocked)",
          borderRadius: "50%",
          animation: "dash-spin 4s linear infinite",
        }}
        role="img"
        aria-label="blocked"
      >
        <span
          style={{
            position: "absolute",
            inset: 2,
            borderRadius: "50%",
            background: "var(--state-blocked)",
          }}
        />
      </span>
    );
  }

  if (state === "error") {
    return (
      <span
        className={cn("shrink-0", className)}
        style={{
          ...base,
          background: "var(--state-error)",
          clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)",
          borderRadius: 1,
        }}
        role="img"
        aria-label="error"
      />
    );
  }

  if (state === "idle") {
    return (
      <span
        className={cn("shrink-0", className)}
        style={{ ...base, borderRadius: "50%", background: "var(--state-idle)" }}
        role="img"
        aria-label="idle"
      />
    );
  }

  return (
    <span
      className={cn("shrink-0", className)}
      style={{
        ...base,
        borderRadius: "50%",
        border: "var(--hairline) solid var(--state-offline)",
        background: "transparent",
      }}
      role="img"
      aria-label="offline"
    />
  );
}
