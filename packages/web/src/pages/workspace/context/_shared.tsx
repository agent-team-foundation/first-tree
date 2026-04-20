import type { ReactNode } from "react";

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="mono uppercase"
      style={{
        fontSize: 9,
        letterSpacing: 0.1,
        color: "var(--fg-4)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

export function KV({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "auto 1fr",
        columnGap: 10,
        rowGap: 4,
        fontSize: 11.5,
      }}
    >
      {children}
    </div>
  );
}

export function KVRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div style={{ color: "var(--fg-3)" }}>{label}</div>
      <div className="text-right truncate" style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis" }}>
        {children}
      </div>
    </>
  );
}

export function formatRelative(iso: string | null): string {
  if (!iso) return "\u2014";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
