/**
 * Avatar — avatar with a deterministic identicon fallback.
 *
 * Renders an image URL when present (member GitHub avatar, agent custom
 * upload) as a circle. Otherwise falls back to a GitHub-style identicon — a
 * symmetric block pattern derived from `seed` (or `name` when no seed is
 * given), painted in the subject's themed avatar hue (`colorToken` override,
 * else the deterministic hash). The identicon replaces the old colored
 * circle + initial.
 */

import { resolveAvatarHue } from "./chat/chat-row-avatar.js";
import { Identicon } from "./identicon.js";

type AvatarProps = {
  src?: string | null;
  name: string;
  size?: number;
  className?: string;
  /**
   * Manager-selected color token (e.g. an agent's `avatarColorToken`).
   * When omitted the identicon hue is resolved from `seed` (then `name`).
   */
  colorToken?: string | null;
  /**
   * Stable seed for the deterministic identicon pattern and hue (typically
   * the agent's uuid). Falls back to `name` when absent.
   */
  seed?: string;
};

export function Avatar({ src, name, size = 28, className, colorToken, seed }: AvatarProps) {
  if (src) {
    const dim = `${size}px`;
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
  const identiconSeed = seed && seed.length > 0 ? seed : name;
  const color = resolveAvatarHue(colorToken, identiconSeed);
  return <Identicon seed={identiconSeed} size={size} color={color} className={className} label={name} />;
}
