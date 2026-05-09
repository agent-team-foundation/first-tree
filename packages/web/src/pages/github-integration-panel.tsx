import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { getGithubIntegrationSetting, putGithubIntegrationSetting } from "../api/org-settings.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { FlatSectionHeader } from "../components/ui/flat-section-header.js";

/**
 * Admin-only panel for the per-org GitHub integration: just the webhook
 * secret used to verify GitHub-signed requests for this team.
 *
 * The webhook URL is computed server-side from `server.publicUrl` — when
 * the Hub does not have its public URL configured, the UI shows a
 * "contact your site administrator" notice rather than fall back to
 * `window.location.origin` (which is wrong behind a reverse proxy).
 *
 * The plaintext secret is never echoed back; once configured, the panel
 * only shows a "configured" status with a "Replace" affordance.
 */
export function GithubIntegrationPanel() {
  const { organizationId } = useAuth();
  const queryClient = useQueryClient();

  const settingQuery = useQuery({
    queryKey: ["org-setting", organizationId, "github_integration"],
    queryFn: () => (organizationId ? getGithubIntegrationSetting(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
  });

  const [secretInput, setSecretInput] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!settingQuery.data) return;
    // Don't clear secret input mid-edit — only sync on first load.
  }, [settingQuery.data]);

  const webhookUrl = settingQuery.data?.webhookUrl ?? "";

  const mutation = useMutation({
    mutationFn: () => {
      if (!organizationId) throw new Error("organization not loaded");
      const trimmedSecret = secretInput.trim();
      // Only send `webhookSecret` when the admin actually typed something
      // (or explicitly cleared after pressing Replace). Otherwise leave
      // the cipher untouched.
      if (trimmedSecret.length === 0 && !replacing) {
        return Promise.resolve(settingQuery.data);
      }
      return putGithubIntegrationSetting(organizationId, {
        webhookSecret: trimmedSecret.length > 0 ? trimmedSecret : null,
      });
    },
    onSuccess: (next) => {
      if (!next) return;
      queryClient.setQueryData(["org-setting", organizationId, "github_integration"], next);
      setSecretInput("");
      setReplacing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  const copyWebhookUrl = async () => {
    if (!webhookUrl) return;
    await navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const secretConfigured = settingQuery.data?.webhookSecretConfigured ?? false;

  return (
    <section>
      <FlatSectionHeader
        right={
          <div className="flex items-center gap-1.5">
            {saved && (
              <span className="mono text-caption" style={{ color: "var(--accent-dim)" }}>
                saved
              </span>
            )}
            <Button
              type="submit"
              form="github-integration-form"
              size="xs"
              variant="outline"
              disabled={mutation.isPending || !settingQuery.data}
            >
              <Check className="h-3 w-3" />
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        }
      >
        GitHub integration
      </FlatSectionHeader>
      {settingQuery.isLoading ? (
        <div className="text-body" style={{ color: "var(--fg-3)", padding: "var(--sp-3) var(--sp-1)" }}>
          Loading…
        </div>
      ) : settingQuery.error ? (
        <div className="text-body" style={{ color: "var(--state-error)", padding: "var(--sp-3) var(--sp-1)" }}>
          {settingQuery.error instanceof Error ? settingQuery.error.message : "Failed to load setting"}
        </div>
      ) : (
        <form id="github-integration-form" onSubmit={handleSubmit}>
          {webhookUrl ? (
            <ReadOnlyField
              label="Webhook URL"
              hint="Configure this URL in GitHub repo / org Settings → Webhooks. Never changes."
              value={webhookUrl}
              rightSlot={
                <Button type="button" size="xs" variant="ghost" onClick={copyWebhookUrl}>
                  <Copy className="h-3 w-3" />
                  {copied ? "Copied" : "Copy"}
                </Button>
              }
            />
          ) : (
            <NoticeRow
              label="Webhook URL"
              message="The Hub's public URL is not configured. Please contact your site administrator to enable the GitHub webhook."
            />
          )}
          {secretConfigured && !replacing ? (
            <SecretStatusRow
              onReplace={() => {
                setReplacing(true);
                setSecretInput("");
              }}
            />
          ) : (
            <Field
              label="Webhook secret"
              hint="Paste the value you used when configuring the GitHub webhook. Stored encrypted; never echoed back."
              value={secretInput}
              onChange={setSecretInput}
              mono
              placeholder={replacing ? "Enter new secret" : "(none)"}
              type="password"
            />
          )}
          {mutation.error instanceof Error && (
            <div className="text-body" style={{ color: "var(--state-error)", marginTop: "var(--sp-2)" }}>
              {mutation.error.message}
            </div>
          )}
        </form>
      )}
    </section>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  mono,
  placeholder,
  type,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  mono?: boolean;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div
      className="grid items-start gap-5"
      style={{
        gridTemplateColumns: "var(--sp-45) 1fr",
        padding: "var(--sp-3_5) var(--sp-1)",
        borderTop: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div>
        <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
          {label}
        </div>
        <div className="text-label" style={{ color: "var(--fg-3)", marginTop: 2 }}>
          {hint}
        </div>
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type ?? "text"}
        placeholder={placeholder}
        className={`w-full outline-none text-body ${mono ? "mono" : ""}`}
        style={{
          padding: "var(--sp-1_25) var(--sp-2_5)",
          background: "var(--bg-sunken)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-input)",
          color: "var(--fg)",
        }}
      />
    </div>
  );
}

function ReadOnlyField({
  label,
  hint,
  value,
  rightSlot,
}: {
  label: string;
  hint: string;
  value: string;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div
      className="grid items-start gap-5"
      style={{
        gridTemplateColumns: "var(--sp-45) 1fr",
        padding: "var(--sp-3_5) var(--sp-1)",
        borderTop: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div>
        <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
          {label}
        </div>
        <div className="text-label" style={{ color: "var(--fg-3)", marginTop: 2 }}>
          {hint}
        </div>
      </div>
      <div
        className="mono text-body flex items-center justify-between gap-2"
        style={{
          padding: "var(--sp-1_25) var(--sp-2_5)",
          background: "var(--bg-sunken)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-input)",
          color: "var(--fg-3)",
          overflow: "hidden",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
        {rightSlot}
      </div>
    </div>
  );
}

function NoticeRow({ label, message }: { label: string; message: string }) {
  return (
    <div
      className="grid items-start gap-5"
      style={{
        gridTemplateColumns: "var(--sp-45) 1fr",
        padding: "var(--sp-3_5) var(--sp-1)",
        borderTop: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div>
        <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
          {label}
        </div>
      </div>
      <div
        className="flex items-start gap-2 text-body"
        style={{
          padding: "var(--sp-1_25) var(--sp-2_5)",
          background: "var(--bg-sunken)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-input)",
          color: "var(--state-warning, var(--fg-3))",
        }}
      >
        <AlertTriangle className="h-4 w-4 shrink-0" style={{ marginTop: 2 }} />
        <span>{message}</span>
      </div>
    </div>
  );
}

function SecretStatusRow({ onReplace }: { onReplace: () => void }) {
  return (
    <div
      className="grid items-center gap-5"
      style={{
        gridTemplateColumns: "var(--sp-45) 1fr",
        padding: "var(--sp-3_5) var(--sp-1)",
        borderTop: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div>
        <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
          Webhook secret
        </div>
        <div className="text-label" style={{ color: "var(--fg-3)", marginTop: 2 }}>
          Configured. Replace to rotate; webhook signature verification will fail until GitHub is also updated.
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-body" style={{ color: "var(--accent-dim)" }}>
          ••••••••
        </span>
        <Button type="button" size="xs" variant="ghost" onClick={onReplace}>
          Replace
        </Button>
      </div>
    </div>
  );
}
