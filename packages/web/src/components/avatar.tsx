/**
 * Avatar — circular user image with initials fallback.
 *
 * Renders the GitHub avatar URL when present; otherwise falls back to
 * a single-color circle with the user's first initial. Color tokens
 * come from the design system (no per-user palette) — recognizability
 * comes from the initial itself.
 */

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
};

export function Avatar({ src, name, size = 28, className }: AvatarProps) {
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
  return (
    <span
      className={className}
      role="img"
      aria-label={name}
      style={{
        width: dim,
        height: dim,
        borderRadius: "50%",
        background: "var(--accent)",
        color: "var(--bg-raised)",
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
