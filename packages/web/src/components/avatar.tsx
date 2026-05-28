/**
 * Avatar — circular avatar with initials fallback.
 *
 * Renders an image URL when present (member GitHub avatar, agent custom
 * upload). Falls back to a colored circle + initial. The fill color is
 * resolved from `colorToken` when provided (manager-selected agent
 * override), otherwise from the deterministic hash on `seed`. When
 * neither is supplied, falls back to the brand color.
 */

import { resolveAvatarHue } from "./chat/chat-row-avatar.js";

function initial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed[0]?.toUpperCase() ?? "?";
}

type AvatarProps = {
  src?: string | null;
  name: string;
  size?: number;
  className?: string;
  /**
   * Manager-selected color token (e.g. an agent's `avatarColorToken`).
   * When omitted the fallback color is resolved from `seed`, then from
   * `--brand` if neither is provided.
   */
  colorToken?: string | null;
  /**
   * Stable seed used to derive a deterministic fallback color (typically
   * the agent's uuid). Only used when `colorToken` is absent.
   */
  seed?: string;
};

export function Avatar({ src, name, size = 28, className, colorToken, seed }: AvatarProps) {
  const dim = `${size}px`;
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        className={className}
        style={{
          width: dim,
          height: dim,
          borderRadius: "50%",
          objectFit: "cover",
          display: "block",
        }}
      />
    );
  }
  const hasHueInput = (typeof colorToken === "string" && colorToken.length > 0) || (seed && seed.length > 0);
  const background = hasHueInput ? resolveAvatarHue(colorToken, seed ?? "") : "var(--brand)";
  const color = hasHueInput ? "var(--fg-on-vivid)" : "var(--bg-raised)";
  return (
    <span
      className={className}
      role="img"
      aria-label={name}
      style={{
        width: dim,
        height: dim,
        borderRadius: "50%",
        background,
        color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        userSelect: "none",
      }}
    >
      <span className="text-subtitle font-semibold">{initial(name)}</span>
    </span>
  );
}
