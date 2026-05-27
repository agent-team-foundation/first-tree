import { Check, Copy } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../../../../components/ui/button.js";

const COPY_FEEDBACK_MS = 1_500;

type InlineCommandProps = {
  command: string;
  /** Optional caption shown below the command block. */
  caption?: string;
  /**
   * Accessible label for the figure. Defaults to "Command". Pass a
   * more specific label (e.g. "Install Claude Code") when several
   * InlineCommand blocks live side-by-side and the visible runtime
   * label is the only thing distinguishing them — screen-reader users
   * navigating by landmarks need that distinction in the name.
   */
  ariaLabel?: string;
};

/**
 * Mini command-with-copy block for use inside computer cards. Distinct
 * from `ConnectCommandPanel` (which owns the dialog's full phase
 * machine: waiting / success / error / stuck panel). This is the
 * stripped-down variant for inline use — no phase, no expiry chip, no
 * stuck panel. Visual vocabulary stays aligned with the panel so a user
 * scanning from card to dialog sees the same code block style.
 *
 * Used by:
 *   - Setup-incomplete card → install + login command per runtime
 *   - Offline card → wake guide command (`first-tree daemon start`)
 *
 * A11y: wrapped in `<figure>` with a `<figcaption>` (visually hidden) so
 * the command block has an accessible name. The Copy button references
 * the `<pre>` via `aria-describedby` so the announced action includes
 * the command text for screen readers.
 */
export function InlineCommand({ command, caption, ariaLabel = "Command" }: InlineCommandProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const reactId = useId();
  const preId = `${reactId}-cmd`;
  const captionId = `${reactId}-cap`;

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopyError(false);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // `navigator.clipboard.writeText` rejects in non-secure contexts
      // and when the user denies the clipboard permission. Silent failure
      // would leave the operator wondering why nothing landed, so flip
      // the button to a transient "Copy failed" state. The command text
      // is still visible above for manual select-copy.
      setCopied(false);
      setCopyError(true);
      setTimeout(() => setCopyError(false), COPY_FEEDBACK_MS);
    }
  };

  return (
    <figure className="flex flex-col" style={{ margin: 0, gap: "var(--sp-2)" }} aria-labelledby={captionId}>
      <figcaption id={captionId} className="sr-only">
        {ariaLabel}
      </figcaption>
      <pre
        id={preId}
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
        }}
      >
        {command}
      </pre>
      <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCopy}
          aria-describedby={preId}
          style={{ alignSelf: "flex-start" }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copyError ? "Copy failed" : copied ? "Copied" : "Copy"}
        </Button>
        {caption && (
          <span className="text-label" style={{ color: "var(--fg-4)" }}>
            {caption}
          </span>
        )}
      </div>
    </figure>
  );
}
