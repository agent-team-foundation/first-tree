import { FirstTreeLogo } from "../first-tree-logo.js";

export const FIRST_TREE_ONBOARDING_SYSTEM_SENDER = "first_tree_onboarding";
export const FIRST_TREE_SYSTEM_SENDER_NAME = "First Tree";

type TrustedFirstTreeMessageShape = {
  source: string | null | undefined;
  format: string;
  content: unknown;
  metadata: unknown;
};

export function isFirstTreeOnboardingSystemSenderMetadata(metadata: unknown): boolean {
  if (typeof metadata !== "object" || metadata === null) return false;
  return (metadata as { systemSender?: unknown }).systemSender === FIRST_TREE_ONBOARDING_SYSTEM_SENDER;
}

/**
 * Trust gate for onboarding system-trigger rows. The server is the only writer
 * allowed to preserve `metadata.systemSender`, and it emits these rows with
 * `source: "api"` so regular web/agent sends cannot spoof the sender.
 */
export function isTrustedFirstTreeOnboardingSystemMessage(msg: TrustedFirstTreeMessageShape): boolean {
  return (
    msg.source === "api" &&
    (msg.format === "text" || msg.format === "markdown") &&
    typeof msg.content === "string" &&
    isFirstTreeOnboardingSystemSenderMetadata(msg.metadata)
  );
}

export function FirstTreeSystemAvatar({ size = 20 }: { size?: number }) {
  const dim = `${size}px`;
  return (
    <span
      role="img"
      aria-label={FIRST_TREE_SYSTEM_SENDER_NAME}
      style={{
        width: dim,
        height: dim,
        borderRadius: "50%",
        background: "var(--primary)",
        color: "var(--bg)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
      }}
    >
      <FirstTreeLogo width={Math.round(size * 0.55)} height={Math.round(size * 0.62)} />
    </span>
  );
}
