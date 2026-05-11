import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy } from "lucide-react";
import { type FormEvent, useState } from "react";
import { getGithubIntegrationSetting, putGithubIntegrationSetting } from "../api/org-settings.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { SettingsField, SettingsSaveButton } from "../components/ui/settings-field.js";
import { SettingsSection } from "../components/ui/settings-section.js";

/**
 * Admin-only section for the per-org GitHub integration: just the webhook
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
export function GithubIntegrationPanel({ isFirst = false }: { isFirst?: boolean }) {
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

  const webhookUrl = settingQuery.data?.webhookUrl ?? "";

  const mutation = useMutation({
    mutationFn: () => {
      if (!organizationId) throw new Error("organization not loaded");
      const trimmedSecret = secretInput.trim();
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
    <SettingsSection
      title="GitHub webhook"
      description="Routes GitHub issue and comment events to your team's agents."
      isFirst={isFirst}
    >
      {settingQuery.isLoading ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Loading…
        </div>
      ) : settingQuery.error ? (
        <div className="text-body" style={{ color: "var(--state-error)" }}>
          {settingQuery.error instanceof Error ? settingQuery.error.message : "Failed to load setting"}
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          {webhookUrl ? (
            <SettingsField
              label="Webhook URL"
              hint="Configure this URL in GitHub repo / org Settings → Webhooks. Never changes."
              value={webhookUrl}
              readOnly
              mono
              rightSlot={
                <Button type="button" size="sm" variant="outline" onClick={copyWebhookUrl}>
                  <Copy className="h-3 w-3" />
                  {copied ? "Copied" : "Copy"}
                </Button>
              }
            />
          ) : (
            <WebhookUrlNotice />
          )}
          {secretConfigured && !replacing ? (
            <SecretStatusRow
              saved={saved}
              onReplace={() => {
                setReplacing(true);
                setSecretInput("");
              }}
            />
          ) : (
            <SettingsField
              label="Webhook secret"
              hint="Paste the value you used when configuring the GitHub webhook. Stored encrypted; never echoed back."
              value={secretInput}
              onChange={setSecretInput}
              mono
              type="password"
              placeholder={replacing ? "Enter new secret" : "(none)"}
              saved={saved}
              rightSlot={<SettingsSaveButton pending={mutation.isPending} disabled={!settingQuery.data} />}
            />
          )}
          {mutation.error instanceof Error && (
            <div className="text-body" style={{ color: "var(--state-error)" }}>
              {mutation.error.message}
            </div>
          )}
        </form>
      )}
    </SettingsSection>
  );
}

function WebhookUrlNotice() {
  return (
    <div style={{ marginBottom: "var(--sp-4)" }}>
      <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
        Webhook URL
      </div>
      <div
        className="flex items-start text-body"
        style={{
          gap: "var(--sp-2)",
          marginTop: "var(--sp-2)",
          padding: "var(--sp-2) var(--sp-2_5)",
          background: "var(--bg-sunken)",
          borderRadius: "var(--radius-input)",
          color: "var(--state-warning, var(--fg-3))",
        }}
      >
        <AlertTriangle className="h-4 w-4 shrink-0" style={{ marginTop: "var(--sp-0_5)" }} />
        <span>
          The Hub's public URL is not configured. Please contact your site administrator to enable the GitHub webhook.
        </span>
      </div>
    </div>
  );
}

function SecretStatusRow({ saved, onReplace }: { saved: boolean; onReplace: () => void }) {
  return (
    <div style={{ marginBottom: "var(--sp-4)" }}>
      <div className="flex items-baseline justify-between" style={{ gap: "var(--sp-2)" }}>
        <span className="text-body font-medium" style={{ color: "var(--fg)" }}>
          Webhook secret
        </span>
        {saved && (
          <span
            className="text-label inline-flex items-center fade-in"
            style={{
              gap: "var(--sp-1)",
              color: "color-mix(in oklch, var(--accent) 35%, var(--fg))",
            }}
          >
            ✓ Saved
          </span>
        )}
      </div>
      <p className="text-label" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 var(--sp-2)" }}>
        Configured. Replace to rotate; webhook signature verification will fail until GitHub is also updated.
      </p>
      <div className="flex items-stretch" style={{ gap: "var(--sp-2)" }}>
        <div
          className="flex-1 mono text-body flex items-center"
          style={{
            padding: "var(--sp-1_5) var(--sp-2_5)",
            background: "var(--bg-sunken)",
            borderRadius: "var(--radius-input)",
            color: "var(--fg-2)",
          }}
        >
          ••••••••
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onReplace}>
          Replace
        </Button>
      </div>
    </div>
  );
}
