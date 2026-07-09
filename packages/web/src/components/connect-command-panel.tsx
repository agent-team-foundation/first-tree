import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useCopyFeedback } from "../lib/use-copy-feedback.js";
import { Button } from "./ui/button.js";

export type ConnectPhase = "loading" | "waiting" | "success" | "error";

type ConnectCommandPanelProps = {
  /** Full command to display + copy. `null` shows the "Generating token…" placeholder. */
  command: string | null;
  /** Token TTL in seconds; drives the live `expires in Xm:XXs` countdown next to the Copy button. */
  expiresInSeconds?: number;
  /** Drives the inline status row below the command. */
  phase: ConnectPhase;
  /** Override the copy button labels. Default: `Copy` / `Copied`. */
  copyLabel?: { idle: string; done: string };
  /** Override the waiting copy. Default: `Waiting for your computer to connect…`. */
  waitingText?: ReactNode;
  /** Content of the green success row. Omit to skip the green row entirely (e.g. when the host transitions to a different step on success). */
  successContent?: ReactNode;
  /** Content of the red error row. Omit to skip. */
  errorContent?: ReactNode;
  /**
   * Where to place the Copy button relative to the command block.
   * `"right"` (default) is compact and matches the `/clients` Connect computer
   * surface. `"bottom"` puts the button on its own row below the command —
   * better when the host modal is narrow and the inline button squeezes
   * the command text.
   */
  copyButtonPlacement?: "right" | "bottom";
};

/**
 * Panel for "run this CLI command to pair a computer" surfaces — today the
 * `Connect computer` / re-auth dialog on /clients. Renders the code block,
 * the Copy button with a live expiry countdown beside it, and the
 * yellow→green→red status rows.
 *
 * Polling and end-state semantics are intentionally NOT in this component:
 * the host owns the phase machine (mint, arrival polling, token expiry);
 * this panel just renders it.
 */
export function ConnectCommandPanel({
  command,
  expiresInSeconds,
  phase,
  copyLabel = { idle: "Copy", done: "Copied" },
  waitingText = "Waiting for your computer to connect…",
  successContent,
  errorContent,
  copyButtonPlacement = "right",
}: ConnectCommandPanelProps) {
  // Shared copy → transient-feedback machine. This panel only surfaces the
  // success label (`copyLabel.done`); a clipboard failure quietly stays on
  // the idle label — the command text is selectable above.
  const { status, copy } = useCopyFeedback();

  const handleCopy = (): void => {
    if (!command) return;
    void copy(command);
  };

  const commandBlock = (
    <pre
      className="mono text-label"
      style={{
        margin: 0,
        padding: "var(--sp-2_5) var(--sp-3)",
        background: "var(--bg-sunken)",
        border: "var(--hairline) solid var(--border-faint)",
        borderRadius: "var(--radius-input)",
        color: "var(--fg-2)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        overflowWrap: "anywhere",
        minWidth: 0,
        flex: copyButtonPlacement === "right" ? 1 : undefined,
      }}
      title={command ?? ""}
    >
      {command ?? "Generating token…"}
    </pre>
  );

  const copyButton = (
    <Button type="button" variant="outline" size="sm" onClick={handleCopy} disabled={!command}>
      {status === "copied" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {status === "copied" ? copyLabel.done : copyLabel.idle}
    </Button>
  );

  // The countdown keys on the command so a regenerated token restarts the
  // count from its own TTL (expiresIn alone is usually the same number).
  const copyRow = (
    <div className="flex items-center" style={{ gap: "var(--sp-2_5)", alignSelf: "flex-start" }}>
      {copyButton}
      {command && phase === "waiting" && expiresInSeconds !== undefined && (
        <ExpiryTicker key={command} expiresInSeconds={expiresInSeconds} />
      )}
    </div>
  );

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
      {copyButtonPlacement === "right" ? (
        <div className="flex" style={{ gap: "var(--sp-2)", alignItems: "stretch" }}>
          {commandBlock}
          {copyRow}
        </div>
      ) : (
        <>
          {commandBlock}
          {copyRow}
        </>
      )}

      <ConnectStatusRow
        phase={phase}
        waitingText={waitingText}
        successContent={successContent}
        errorContent={errorContent}
      />
    </div>
  );
}

/**
 * The yellow -> green -> red status row rendered beneath a connect command.
 * Hosts with more than one command block can render one shared status row.
 */
export function ConnectStatusRow({
  phase,
  waitingText = "Waiting for your computer to connect…",
  successContent,
  errorContent,
}: {
  phase: ConnectPhase;
  waitingText?: ReactNode;
  successContent?: ReactNode;
  errorContent?: ReactNode;
}) {
  return (
    <>
      {phase === "waiting" && (
        <div
          className="flex items-center text-body"
          style={{
            gap: "var(--sp-2_5)",
            padding: "var(--sp-2_5) var(--sp-3)",
            background: "var(--state-blocked-soft)",
            border: "var(--hairline) solid color-mix(in oklch, var(--state-blocked) 35%, transparent)",
            borderRadius: "var(--radius-input)",
            color: "color-mix(in oklch, var(--state-blocked) 35%, var(--fg))",
          }}
        >
          <WaitingSpinner />
          {waitingText}
        </div>
      )}

      {phase === "success" && successContent && (
        <div
          className="flex items-center text-body"
          style={{
            gap: "var(--sp-2_5)",
            padding: "var(--sp-2_5) var(--sp-3)",
            background: "color-mix(in oklch, var(--success) 14%, transparent)",
            border: "var(--hairline) solid color-mix(in oklch, var(--success) 35%, transparent)",
            borderRadius: "var(--radius-input)",
            color: "color-mix(in oklch, var(--success) 45%, var(--fg))",
          }}
        >
          <Check className="h-3.5 w-3.5" style={{ flexShrink: 0 }} />
          <span style={{ minWidth: 0 }}>{successContent}</span>
        </div>
      )}

      {phase === "error" && errorContent && (
        <div
          className="text-body"
          style={{
            padding: "var(--sp-2_5) var(--sp-3)",
            background: "var(--state-error-soft)",
            border: "var(--hairline) solid color-mix(in oklch, var(--state-error) 28%, transparent)",
            borderRadius: "var(--radius-input)",
            color: "var(--state-error)",
          }}
        >
          {errorContent}
        </div>
      )}
    </>
  );
}

/**
 * Live `expires in Xm:XXs` countdown shown beside the Copy button while the
 * host is waiting for the computer to connect. The deadline is stamped on
 * mount, so the host remounts it per token (`key={command}`) to restart the
 * count for a regenerated token. Purely informational — the host owns the
 * actual expiry transition (its own timer flips the phase to `error`).
 */
function ExpiryTicker({ expiresInSeconds }: { expiresInSeconds: number }) {
  const [remaining, setRemaining] = useState(expiresInSeconds);

  useEffect(() => {
    const deadline = Date.now() + expiresInSeconds * 1_000;
    const handle = window.setInterval(() => {
      setRemaining(Math.max(0, Math.round((deadline - Date.now()) / 1_000)));
    }, 1_000);
    return () => window.clearInterval(handle);
  }, [expiresInSeconds]);

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return (
    <span className="text-label" style={{ color: "var(--fg-4)", fontVariantNumeric: "tabular-nums" }}>
      expires in {minutes}m:{String(seconds).padStart(2, "0")}s
    </span>
  );
}

function WaitingSpinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 12,
        height: 12,
        flexShrink: 0,
        borderRadius: "50%",
        border: "var(--hairline-bold) solid color-mix(in oklch, var(--state-blocked) 30%, transparent)",
        borderTopColor: "var(--state-blocked)",
        animation: "spin 0.85s linear infinite",
      }}
    />
  );
}
