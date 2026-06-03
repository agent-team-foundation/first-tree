import type { ReactNode } from "react";

export function ResourceEmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      className="text-body"
      style={{
        padding: "var(--sp-3) 0",
        borderBottom: "var(--hairline) solid var(--border-faint)",
        color: "var(--fg-4)",
      }}
    >
      {children}
    </div>
  );
}
