import type { AuthProvider, AuthProviderConnection } from "@first-tree/shared";
import { Github, Link2, Unlink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { updateMyProfile } from "../api/members.js";
import { getAuthProviders, startProviderLink, startProviderUnlink } from "../api/user-settings.js";
import { useAuth } from "../auth/auth-context.js";
import { Avatar } from "../components/avatar.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";

const ERROR_COPY: Record<string, string> = {
  "identity-conflict": "That account is already connected to another First Tree user.",
  "identity-mismatch": "You selected a different account. Sign in with the account currently connected here.",
  "last-provider": "Connect another sign-in method before disconnecting this one.",
  "state-expired": "The authentication request expired. Start again.",
  "provider-not-configured": "This sign-in provider is not configured on this deployment.",
};

export function UserSettingsPage() {
  const { user, refreshMe } = useAuth();
  const location = useLocation();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [providers, setProviders] = useState<AuthProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAuthProviders();
      setProviders(result.providers);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load authentication connections.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
    const params = new URLSearchParams(location.search);
    const error = params.get("error");
    const connection = params.get("connection");
    if (error) setMessage(ERROR_COPY[error] ?? "Authentication connection did not complete. Try again.");
    else if (connection) setMessage("Authentication connections updated.");
    if (error || connection) window.history.replaceState(null, "", "/user-settings");
  }, [location.search, loadProviders]);

  const saveProfile = async () => {
    const normalized = displayName.trim().replace(/\s+/g, " ");
    if (!normalized) return;
    setBusy("profile");
    setMessage(null);
    try {
      await updateMyProfile({ displayName: normalized });
      await refreshMe();
      setMessage("Profile updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update profile.");
    } finally {
      setBusy(null);
    }
  };

  const providerAction = async (provider: AuthProvider, action: "link" | "unlink") => {
    if (action === "unlink" && !window.confirm(`Disconnect ${provider === "google" ? "Google" : "GitHub"}?`)) return;
    setBusy(`${provider}-${action}`);
    setMessage(null);
    try {
      const result = action === "link" ? await startProviderLink(provider) : await startProviderUnlink(provider);
      window.location.assign(result.redirectUrl);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start authentication.");
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-title">User Settings</h1>
        <p className="mt-1 text-body text-muted-foreground">Manage your personal profile and sign-in methods.</p>
      </div>

      {message && <div className="rounded-[var(--radius-panel)] border p-3 text-body">{message}</div>}

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Avatar src={user?.avatarUrl ?? null} name={user?.displayName ?? "User"} size={48} />
            <div className="text-label text-muted-foreground">
              Your avatar comes from the provider used at registration.
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-settings-username">Username</Label>
            <Input id="user-settings-username" value={user?.username ?? ""} readOnly disabled />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-settings-display-name">Display name</Label>
            <Input
              id="user-settings-display-name"
              value={displayName}
              maxLength={200}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
          <Button disabled={busy === "profile" || !displayName.trim()} onClick={() => void saveProfile()}>
            {busy === "profile" ? "Saving…" : "Save profile"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Authentication connections</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <p className="text-body text-muted-foreground">Loading connections…</p>
          ) : (
            providers.map((provider) => (
              <ProviderCard key={provider.provider} provider={provider} busy={busy} onAction={providerAction} />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ProviderCard({
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
    <div className="flex items-center justify-between gap-4 rounded-[var(--radius-panel)] border p-4">
      <div className="flex min-w-0 items-center gap-3">
        {provider.provider === "github" ? (
          <Github className="h-5 w-5" />
        ) : (
          <span className="flex h-5 w-5 items-center justify-center font-semibold">G</span>
        )}
        <div className="min-w-0">
          <div className="font-medium">{label}</div>
          <div className="truncate text-label text-muted-foreground">
            {!provider.available
              ? "Not configured"
              : provider.connected
                ? provider.accountName || provider.email || "Connected"
                : "Not connected"}
          </div>
          {provider.connectedAt && (
            <div className="text-caption text-muted-foreground">
              Connected {new Date(provider.connectedAt).toLocaleDateString()}
            </div>
          )}
          {provider.unlinkBlockedReason === "last-provider" && (
            <div className="text-caption text-muted-foreground">
              Connect another sign-in method before disconnecting.
            </div>
          )}
        </div>
      </div>
      <Button variant="outline" disabled={disabled} onClick={() => void onAction(provider.provider, action)}>
        {action === "link" ? <Link2 className="h-4 w-4" /> : <Unlink className="h-4 w-4" />}
        {busy === `${provider.provider}-${action}` ? "Starting…" : action === "link" ? "Connect" : "Disconnect"}
      </Button>
    </div>
  );
}
