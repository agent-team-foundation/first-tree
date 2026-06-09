import { Avatar } from "../../components/avatar.js";
import { PresenceChip, runtimeStateToPresence } from "../../components/ui/presence-chip.js";

/**
 * Sticky identity bar for the agent detail page. Once the operator scrolls past
 * the top header (which carries the switcher + title), this bar takes over to
 * keep "which agent am I looking at" visible: avatar + name + presence.
 *
 * It used to repeat "Runs on <runtime> @ <computer>", which duplicated the
 * Environment tab's Execution section. Identity is the thing that actually needs
 * to stay pinned while scrolling a long tab.
 *
 * The top switcher and this bar never show at once — the bar is gated by an
 * IntersectionObserver on a sentinel under the header (see `AgentDetailPage`),
 * so it only appears after the switcher has scrolled away.
 */
export type ContextBarProps = {
  displayName: string;
  avatarImageUrl?: string | null;
  avatarColorToken?: string | null;
  /** Stable seed for the fallback avatar color (the agent uuid). */
  seed: string;
  runtimeState: string | null | undefined;
  /** When false, the bar is not rendered at all. */
  visible?: boolean;
};

export function ContextBar({
  displayName,
  avatarImageUrl,
  avatarColorToken,
  seed,
  runtimeState,
  visible = true,
}: ContextBarProps) {
  if (!visible) return null;
  return (
    <div
      className="sticky z-20 flex items-center gap-2 backdrop-blur"
      style={{
        top: 0,
        padding: "var(--sp-1_75) var(--sp-5)",
        background: "color-mix(in oklch, var(--bg-raised) 94%, transparent)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <Avatar src={avatarImageUrl} name={displayName} size={20} colorToken={avatarColorToken} seed={seed} />
      <span className="text-body font-medium min-w-0 flex-1 truncate" style={{ color: "var(--fg)" }}>
        {displayName}
      </span>
      <PresenceChip status={runtimeStateToPresence(runtimeState)} className="shrink-0" />
    </div>
  );
}
