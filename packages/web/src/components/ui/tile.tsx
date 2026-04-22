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
        padding: "8px 10px",
        background: "var(--bg-sunken)",
        borderRadius: 4,
      }}
    >
      <div
        className="mono uppercase"
        style={{
          fontSize: 9,
          letterSpacing: "0.08em",
          color: "var(--fg-4)",
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: accent ?? "var(--fg)",
          marginTop: 1,
        }}
      >
        {value}
      </div>
    </div>
  );
}
