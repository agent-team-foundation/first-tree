import type { Agent } from "@first-tree/shared";
import { Pencil } from "lucide-react";
import { resolveAvatarHue } from "../../components/chat/chat-row-avatar.js";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";

/**
 * Appearance — display of the agent's avatar (image or fallback color/initial).
 * Editing is handled by the unified ProfileEditDialog owned by the Profile tab,
 * so this is display-only: the Edit button and the avatar both call `onEdit`.
 *
 * Render priority: image → color override + initial → hashed color + initial.
 */
export type AppearanceSectionProps = {
  agent: Agent;
  canEdit?: boolean;
  /** Opens the unified Profile edit dialog; omit to hide the edit affordance. */
  onEdit?: () => void;
  variant?: "section" | "inline";
};

function initial(s: string): string {
  return s.trim()[0]?.toUpperCase() ?? "?";
}

export function AvatarPreview({ agent, size }: { agent: Agent; size: number }) {
  if (agent.avatarImageUrl) {
    return (
      <img
        src={agent.avatarImageUrl}
        alt={agent.displayName}
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: "var(--radius-full)", objectFit: "cover", display: "block" }}
      />
    );
  }
  // dynamic: scales with avatar size; no fixed token applies
  const initialFontSize = Math.round(size * 0.42);
  return (
    <span
      aria-hidden="true"
      className="font-bold"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "var(--radius-full)",
        background: resolveAvatarHue(agent.avatarColorToken, agent.uuid),
        color: "var(--fg-on-vivid)",
        fontSize: initialFontSize,
        lineHeight: 1,
        letterSpacing: "-0.02em",
        userSelect: "none",
      }}
    >
      {initial(agent.displayName)}
    </span>
  );
}

export function AppearanceSection({ agent, canEdit = true, onEdit, variant = "section" }: AppearanceSectionProps) {
  const colorLabel =
    typeof agent.avatarColorToken === "string" && agent.avatarColorToken.length > 0 ? agent.avatarColorToken : "auto";

  const canOpenEditor = canEdit && !!onEdit && agent.status === "active";
  const action = canOpenEditor ? (
    <Button size="xs" variant="outline" onClick={onEdit}>
      <Pencil className="h-3 w-3" /> Edit
    </Button>
  ) : null;

  const avatar = canOpenEditor ? (
    <button
      type="button"
      aria-label="Edit avatar"
      title="Edit avatar"
      onClick={onEdit}
      className="relative inline-flex shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 rounded-[var(--radius-full)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1"
      style={{ width: 56, height: 56 }}
    >
      <AvatarPreview agent={agent} size={56} />
      <span
        className="absolute inline-flex items-center justify-center"
        aria-hidden="true"
        style={{
          right: -2,
          bottom: -2,
          width: 20,
          height: 20,
          borderRadius: "var(--radius-full)",
          background: "var(--bg-raised)",
          border: "var(--hairline) solid var(--border)",
          color: "var(--fg-2)",
        }}
      >
        <Pencil className="h-3 w-3" />
      </span>
    </button>
  ) : (
    <AvatarPreview agent={agent} size={56} />
  );

  const content = (
    <div
      className="flex min-w-0 items-center gap-3"
      style={{
        padding: "var(--sp-3) 0",
        borderBottom: variant === "inline" ? undefined : "var(--hairline) solid var(--border-faint)",
      }}
    >
      {avatar}
      <div className="min-w-0">
        <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
          {agent.avatarImageUrl ? "Custom image" : "Generated avatar"}
        </div>
        <div className="text-caption" style={{ color: "var(--fg-4)", marginTop: "var(--sp-0_5)" }}>
          {agent.avatarImageUrl ? "Image uploaded" : "No custom image uploaded"} · Color {colorLabel}
        </div>
        {variant === "section" && (
          <div className="text-caption" style={{ color: "var(--fg-4)", marginTop: "var(--sp-1)" }}>
            Updates appear immediately in chats, lists, and mentions.
          </div>
        )}
      </div>
    </div>
  );

  if (variant === "inline") {
    return <div>{content}</div>;
  }

  return (
    <Section
      title="Appearance"
      description="Controls how this agent is recognized in chats, lists, and mentions."
      action={action}
    >
      {content}
    </Section>
  );
}
