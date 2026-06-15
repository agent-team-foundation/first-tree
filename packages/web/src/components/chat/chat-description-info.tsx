import { Check, Copy, Info } from "lucide-react";
import { useCopyFeedback } from "../../lib/use-copy-feedback.js";
import { Button } from "../ui/button.js";
import { HoverCard } from "../ui/hover-card.js";

/**
 * The ⓘ affordance that replaces the chat header's inline description.
 *
 * The header no longer renders the description text directly (it made the
 * header height jitter with the running summary and drowned out the topic).
 * Instead a single small Info icon sits after the topic; hovering it previews
 * the full description, clicking pins the card so the text can be selected /
 * copied. One card, two triggers — the shared `HoverCard` primitive already
 * gives us hover-intent open, click-to-pin, and Esc / outside-click / scroll
 * close (plus a focusable trigger + dialog a11y), so this component is just
 * the trigger glyph + the card body.
 *
 * The caller only mounts this when a description exists and the topic is not
 * being renamed, so there is no empty / dead entry point.
 */

export function ChatDescriptionInfo({ description }: { description: string }) {
  return (
    <HoverCard
      placement="bottom"
      ariaLabel="View chat description"
      // Ghost icon button: muted at rest, lifts to a hover/focus tint with a
      // rounded backplate. Mirrors the header's other ghost icons (the
      // hamburger / GitHub link) for a consistent control language.
      triggerClassName="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-input)] p-[var(--sp-1)] text-[var(--fg-3)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg-2)] focus-visible:bg-[var(--bg-hover)] focus-visible:text-[var(--fg-2)] focus-visible:outline-none"
      // Card chrome (background / border / shadow / padding) comes from the
      // HoverCard primitive; only the readable-measure width is set here.
      contentStyle={{
        width: "var(--sp-95)",
        maxWidth: "calc(100vw - var(--sp-8))",
      }}
      content={() => <DescriptionCard description={description} />}
    >
      <Info size={14} strokeWidth={2} />
    </HoverCard>
  );
}

function DescriptionCard({ description }: { description: string }) {
  // Shared copy → transient-feedback machine. The text is selectable above,
  // so a clipboard failure surfaces as a transient "Copy failed" rather than
  // failing silently.
  const { status, copy } = useCopyFeedback();

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
      <span className="text-label" style={{ color: "var(--fg-3)" }}>
        Description
      </span>
      <div
        className="text-body"
        style={{
          color: "var(--fg)",
          // Pinned card → the full text is read + copied here, so cap the height
          // and let a long description scroll inside its own card.
          maxHeight: "50vh",
          overflowY: "auto",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          userSelect: "text",
        }}
      >
        {description}
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => void copy(description)}>
          {status === "copied" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
