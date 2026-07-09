import { ArrowUpRight } from "lucide-react";
import { DISCORD_INVITE_URL, WECHAT_QR_SRC } from "../lib/community.js";

/**
 * Discord's official mark (simple-icons path), monochrome via currentColor so
 * it follows the neutral ink like every other glyph — brand shape, not brand
 * color, per DESIGN.md's near-monochrome rule.
 */
function DiscordMark({ size }: { size: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

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
            <DiscordMark size={40} />
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
