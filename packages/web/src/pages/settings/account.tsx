import type { AuthProvider, AuthProviderConnection } from "@first-tree/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Github, Link2, Unlink } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { updateMyProfile } from "../../api/members.js";
import { getAuthProviders, startProviderLink, startProviderUnlink } from "../../api/user-settings.js";
import { useAuth } from "../../auth/auth-context.js";
import { Avatar } from "../../components/avatar.js";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";
import { SettingsField, SettingsSaveButton } from "../../components/ui/settings-field.js";
import { invalidateDisplayNameQueries } from "../../lib/identity-cache.js";

const ERROR_COPY: Record<string, string> = {
  "identity-conflict": "That account is already connected to another First Tree user.",
  "identity-mismatch": "You selected a different account. Sign in with the account currently connected here.",
  "last-provider": "Connect another sign-in method before disconnecting this one.",
  "state-expired": "The authentication request expired. Start again.",
  "provider-not-configured": "This sign-in provider is not configured on this deployment.",
};

type Feedback = {
  kind: "error" | "success";
  message: string;
};

export function SettingsAccountPage() {
  const { user, refreshMe } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [providers, setProviders] = useState<AuthProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAuthProviders();
      setProviders(result.providers);
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not load sign-in methods.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const error = params.get("error");
    const connection = params.get("connection");
    if (error) {
      setFeedback({ kind: "error", message: ERROR_COPY[error] ?? "The sign-in method did not update. Try again." });
    } else if (connection) {
      setFeedback({ kind: "success", message: "Sign-in methods updated." });
    }
    if (error || connection) window.history.replaceState(null, "", "/settings/account");
  }, [location.search]);

  useEffect(() => {
    setDisplayName(user?.displayName ?? "");
  }, [user?.displayName]);

  useEffect(() => {
    if (!profileSaved) return;
    const timeout = window.setTimeout(() => setProfileSaved(false), 2_000);
    return () => window.clearTimeout(timeout);
  }, [profileSaved]);

  const normalizedDisplayName = normalizeDisplayName(displayName);
  const currentDisplayName = normalizeDisplayName(user?.displayName ?? "");
  const canSaveProfile =
    normalizedDisplayName.length > 0 && normalizedDisplayName !== currentDisplayName && busy === null;

  const saveProfile = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSaveProfile) return;
    setBusy("profile");
    setFeedback(null);
    setProfileSaved(false);
    try {
      await updateMyProfile({ displayName: normalizedDisplayName });
      setDisplayName(normalizedDisplayName);
      await Promise.all([refreshMe(), invalidateDisplayNameQueries(queryClient)]);
      setProfileSaved(true);
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : "Could not update profile." });
    } finally {
      setBusy(null);
    }
  };

  const providerAction = async (provider: AuthProvider, action: "link" | "unlink"): Promise<void> => {
    const providerLabel = provider === "google" ? "Google" : "GitHub";
    if (action === "unlink" && !window.confirm(`Disconnect ${providerLabel}?`)) return;
    setBusy(`${provider}-${action}`);
    setFeedback(null);
    try {
      const result = action === "link" ? await startProviderLink(provider) : await startProviderUnlink(provider);
      window.location.assign(result.redirectUrl);
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : `Could not ${action === "link" ? "connect" : "disconnect"} ${providerLabel}.`,
      });
      setBusy(null);
    }
  };

  const displayNameForIdentity = user?.displayName || user?.username || "User";

  return (
    <div
      className="flex w-full max-w-3xl flex-col"
      style={{ gap: "var(--sp-5)", padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}
    >
      <section
        aria-label="Account identity"
        className="flex items-center"
        style={{ gap: "var(--sp-4)", padding: "var(--sp-2) 0 var(--sp-3)" }}
      >
        <Avatar
          src={user?.avatarUrl ?? null}
          name={displayNameForIdentity}
          seed={user?.id ?? user?.username ?? displayNameForIdentity}
          size={56}
          className="shrink-0"
        />
        <div className="min-w-0">
          <p className="text-title m-0 truncate" style={{ color: "var(--fg)" }}>
            {displayNameForIdentity}
          </p>
          {user?.username ? (
            <p className="text-body m-0 truncate" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
              @{user.username}
            </p>
          ) : null}
          <p className="text-label m-0" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1_5)" }}>
            Your avatar comes from the provider you signed up with.
          </p>
        </div>
      </section>

      {feedback ? <FeedbackNotice feedback={feedback} /> : null}

      <Section title="Profile">
        <form onSubmit={(event) => void saveProfile(event)} style={{ paddingTop: "var(--sp-3)" }}>
          <SettingsField
            label="Display name"
            hint="The name teammates and agents see across First Tree."
            value={displayName}
            maxLength={200}
            onChange={(next) => {
              setDisplayName(next);
              setProfileSaved(false);
            }}
            saved={profileSaved}
            rightSlot={<SettingsSaveButton pending={busy === "profile"} disabled={!canSaveProfile} />}
          />
        </form>
      </Section>

      <Section title="Sign-in methods">
        {loading ? (
          <p className="text-body m-0" role="status" style={{ color: "var(--fg-3)", padding: "var(--sp-4) 0" }}>
            Loading sign-in methods…
          </p>
        ) : (
          <div className="flex flex-col" style={{ gap: "var(--sp-3)", padding: "var(--sp-3) 0 var(--sp-1)" }}>
            {providers.map((provider) => (
              <ProviderRow key={provider.provider} provider={provider} busy={busy} onAction={providerAction} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function FeedbackNotice({ feedback }: { feedback: Feedback }) {
  const isError = feedback.kind === "error";
  return (
    <p
      role={isError ? "alert" : "status"}
      className="text-body m-0"
      style={{
        padding: "var(--sp-2_5) var(--sp-3)",
        borderRadius: "var(--radius-input)",
        color: isError ? "var(--color-error)" : "var(--fg)",
        background: isError ? "var(--color-error-soft)" : "var(--color-success-soft)",
      }}
    >
      {feedback.message}
    </p>
  );
}

function ProviderRow({
  provider,
  busy,
  onAction,
}: {
  provider: AuthProviderConnection;
  busy: string | null;
  onAction: (provider: AuthProvider, action: "link" | "unlink") => Promise<void>;
}) {
  const label = provider.provider === "google" ? "Google" : "GitHub";
  const action = provider.connected ? "unlink" : "link";
  const disabled = !provider.available || (action === "unlink" && !provider.canUnlink) || busy !== null;
  return (
    <fieldset
      aria-label={`${label} sign-in method`}
      className="flex items-center justify-between"
      style={{
        gap: "var(--sp-4)",
        padding: "var(--sp-3) var(--sp-4)",
        margin: 0,
        minWidth: 0,
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        background: "var(--bg-raised)",
      }}
    >
      <div className="flex min-w-0 items-center" style={{ gap: "var(--sp-3)" }}>
        {provider.provider === "github" ? (
          <Github className="h-5 w-5 shrink-0" aria-hidden />
        ) : (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center font-semibold" aria-hidden>
            G
          </span>
        )}
        <div className="min-w-0">
          <p className="text-body font-medium m-0" style={{ color: "var(--fg)" }}>
            {label}
          </p>
          <p className="text-label m-0 truncate" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
            {!provider.available
              ? "Not configured"
              : provider.connected
                ? provider.accountName || provider.email || "Connected"
                : "Not connected"}
          </p>
          {provider.connectedAt ? (
            <p className="text-caption m-0" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
              Connected {new Date(provider.connectedAt).toLocaleDateString()}
            </p>
          ) : null}
          {provider.unlinkBlockedReason === "last-provider" ? (
            <p className="text-caption m-0" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
              Connect another sign-in method before disconnecting.
            </p>
          ) : null}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={disabled}
        onClick={() => void onAction(provider.provider, action)}
      >
        {action === "link" ? <Link2 className="h-4 w-4" aria-hidden /> : <Unlink className="h-4 w-4" aria-hidden />}
        {busy === `${provider.provider}-${action}` ? "Starting…" : action === "link" ? "Connect" : "Disconnect"}
      </Button>
    </fieldset>
  );
}
