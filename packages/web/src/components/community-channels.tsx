import { ArrowUpRight, MessagesSquare } from "lucide-react";
import { DISCORD_INVITE_URL, WECHAT_QR_SRC } from "../lib/community.js";

/**
 * The two community channels as EQUAL side-by-side cards — WeChat and Discord
 * are parallel options (most Chinese users pick WeChat, others Discord), so
 * the two cards share one anatomy: channel name on top, a square media area
 * in the middle (WeChat → the group QR, Discord → a glyph), an action caption
 * at the bottom. Whole card is the action: WeChat opens the QR full-size for
 * an easier scan, Discord opens the invite.
 *
 * Shared by the onboarding finale (step-start-chat.tsx) and the top-bar
 * SupportMenu so the surfaces stay visually consistent. Design language per
 * DESIGN.md: hairline border, neutral ink, no brand colors.
 */
export function CommunityChannels() {
  return (
    <div className="grid grid-cols-2" style={{ gap: "var(--sp-3)" }}>
      <ChannelCard
        href={WECHAT_QR_SRC}
        name="WeChat group"
        caption="Scan with WeChat"
        media={
          <img src={WECHAT_QR_SRC} width={96} height={96} alt="WeChat group QR code" style={{ borderRadius: 6 }} />
        }
      />
      <ChannelCard
        href={DISCORD_INVITE_URL}
        name="Discord"
        caption={
          <span className="inline-flex items-center" style={{ gap: 3 }}>
            Open the invite
            <ArrowUpRight aria-hidden size={12} />
          </span>
        }
        media={
          <span
            aria-hidden
            className="grid place-items-center"
            style={{
              width: 96,
              height: 96,
              borderRadius: 6,
              background: "var(--bg-sunken)",
              color: "var(--fg-3)",
            }}
          >
            <MessagesSquare size={40} strokeWidth={1.5} />
          </span>
        }
      />
    </div>
  );
}

function ChannelCard({
  href,
  name,
  media,
  caption,
}: {
  href: string;
  name: string;
  media: React.ReactNode;
  caption: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col items-center rounded-[var(--radius-panel)] border border-border transition-colors hover:bg-accent/30"
      style={{ gap: "var(--sp-2)", padding: "var(--sp-3)", textDecoration: "none" }}
    >
      <span className="text-label font-medium" style={{ color: "var(--fg)" }}>
        {name}
      </span>
      {media}
      <span className="text-caption" style={{ color: "var(--fg-4)" }}>
        {caption}
      </span>
    </a>
  );
}
