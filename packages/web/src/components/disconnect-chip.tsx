import { useNavigate } from "react-router";
import { useDisconnectedComputers } from "../hooks/use-disconnected-computers.js";

const HOSTNAME_MAX_PX = 160;

/**
 * Topbar warning chip — surfaces in `Layout` whenever any of the caller's
 * own computers is disconnected and still has agents bound. Click jumps to
 * the Computers settings page. Renders nothing in the healthy case so the
 * topbar stays clean.
 */
export function DisconnectChip() {
  const navigate = useNavigate();
  const { rows, firstHostname } = useDisconnectedComputers();
  if (rows.length === 0) return null;

  const isMulti = rows.length > 1;
  const tooltip = isMulti
    ? `${rows.length} computers disconnected. Click to manage.`
    : `${firstHostname ?? "Your computer"} is disconnected. Click to manage.`;

  return (
    <button
      type="button"
      onClick={() => navigate("/settings/computers")}
      title={tooltip}
      aria-label={tooltip}
      className="inline-flex items-center cursor-pointer text-body font-medium"
      style={{
        gap: 8,
        height: 26,
        padding: "0 var(--sp-2_5) 0 var(--sp-2_25)",
        borderRadius: 999,
        border: 0,
        outline: "var(--hairline) solid color-mix(in oklch, var(--state-error) 38%, transparent)",
        outlineOffset: -1,
        background: "var(--state-error-soft)",
        color: "color-mix(in oklch, var(--state-error) 80%, var(--fg))",
        minWidth: 0,
      }}
    >
      <PulseDot />
      {isMulti ? (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          <span className="font-semibold">{rows.length}</span> computers disconnected
        </span>
      ) : (
        <span className="inline-flex items-center" style={{ gap: 5, minWidth: 0 }}>
          <span
            className="mono text-label font-medium"
            style={{
              maxWidth: HOSTNAME_MAX_PX,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "color-mix(in oklch, var(--state-error) 60%, var(--fg))",
            }}
          >
            {firstHostname ?? "computer"}
          </span>
          <span style={{ flexShrink: 0 }}>disconnected</span>
        </span>
      )}
    </button>
  );
}

/**
 * Mirrors `StateDot.working`'s DOM (solid dot + absolutely-positioned
 * expanding ring sharing the `ring-pulse` keyframe in index.css). Only the
 * colour token differs — we want the same visual vocabulary, not a new one.
 */
function PulseDot() {
  return (
    <span
      aria-hidden="true"
      style={{ position: "relative", width: 8, height: 8, flexShrink: 0, display: "inline-block" }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: "var(--state-error)",
        }}
      />
      <span
        style={{
          position: "absolute",
          inset: -3,
          borderRadius: "50%",
          border: "var(--hairline) solid var(--state-error)",
          animation: "ring-pulse 1.8s infinite",
          opacity: 0.6,
        }}
      />
    </span>
  );
}
