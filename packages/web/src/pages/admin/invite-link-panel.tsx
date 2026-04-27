import { Copy } from "lucide-react";
import { useState } from "react";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { Panel } from "../../components/ui/panel.js";
import { SectionHeader } from "../../components/ui/section-header.js";

/**
 * `/admin` Members tab — workspace public share link (M6 / P0-2 in
 * docs/saas-onboarding-journey.md). Shown only to admin callers; the
 * server's `/me` route already gates the field, so a non-admin will
 * see `inviteUrl === null` here and the panel is omitted.
 *
 * v1 has no per-link revocation: a leaked link can only be invalidated
 * by deleting the workspace. The copy text says so explicitly so an
 * admin doesn't paste it into a public Slack channel without knowing
 * the trade-off. Token rotation is the design doc's deferred v2 work.
 */
export function InviteLinkPanel() {
  const { inviteUrl } = useAuth();
  const [copied, setCopied] = useState(false);

  if (!inviteUrl) return null;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked (insecure context, missing permission) —
      // user can still select and copy the visible value below.
    }
  };

  return (
    <Panel>
      <SectionHeader>Workspace invite link</SectionHeader>
      <div className="space-y-2" style={{ padding: "var(--sp-2)" }}>
        <p className="text-caption" style={{ color: "var(--fg-3)" }}>
          Anyone with this link can sign in via GitHub and join this workspace as a member. Treat it like a password —
          v1 doesn't support rotating it; share it through a private channel.
        </p>
        <div
          className="flex items-center gap-2 rounded-md border border-border"
          style={{ padding: "var(--sp-1) var(--sp-2)", background: "var(--bg-sunken)" }}
        >
          <code className="flex-1 truncate text-caption font-mono" style={{ color: "var(--fg)" }}>
            {inviteUrl}
          </code>
          <Button type="button" variant="outline" size="sm" onClick={onCopy}>
            <Copy className="h-3 w-3" />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
