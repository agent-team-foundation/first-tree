import type { ReactNode } from "react";

type TileProps = {
  label: ReactNode;
  value: ReactNode;
  accent?: string;
};

export function Tile({ label, value, accent }: TileProps) {
  return (
    <div
      style={{
        padding: "var(--sp-2) var(--sp-2_5)",
        background: "var(--bg-sunken)",
        borderRadius: 4,
      }}
    >
      <div className="mono uppercase text-eyebrow" style={{ color: "var(--fg-4)" }}>
        {label}
      </div>
      <div
        className="mono text-subtitle font-semibold"
        style={{
          color: accent ?? "var(--fg)",
          marginTop: 1,
        }}
      >
        {value}
      </div>
    </div>
  );
}
