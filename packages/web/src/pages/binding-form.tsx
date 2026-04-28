import { ADAPTER_PLATFORMS } from "@agent-team-foundation/first-tree-hub-shared";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";

/**
 * Shared "create or edit a platform binding" form.
 *
 * Used by the Settings (formerly /bindings) page. Bot bindings (adapters) and
 * user bindings (adapter mappings) share enough of the platform-picker /
 * status-picker / credentials JSON UX that splitting them would just
 * duplicate code; the differentiator is `binding.kind`.
 *
 * The form is intentionally agent-agnostic — callers pass the resolved
 * `agentId` (and an `agentLabel` for the dialog title). The agent picker
 * itself lives in BindingsPage so this dialog stays focused on the platform
 * payload.
 */

const platformValues = Object.values(ADAPTER_PLATFORMS);

export type BindingKind = "bot" | "user";

export type BotBindingDraft = {
  platform: "feishu" | "slack" | "kael";
  status: "active" | "inactive";
  /** Plain credentials object the caller will encrypt server-side. */
  credentials?: Record<string, unknown>;
};

export type UserBindingDraft = {
  platform: "feishu" | "slack" | "kael";
  externalUserId: string;
  displayName: string | null;
};

export type BindingFormSubmit =
  | { kind: "bot-create"; draft: Required<BotBindingDraft> }
  | { kind: "bot-update"; status: "active" | "inactive"; credentials?: Record<string, unknown> }
  | { kind: "user-create"; draft: UserBindingDraft };

export type BindingFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "bot" creates an adapter; "user" creates a mapping. */
  kind: BindingKind;
  /** Edit mode for bot bindings; user bindings are create-only today. */
  editingId: number | null;
  /** Pre-fixed platform when editing, otherwise the picker shows all platforms. */
  initialPlatform?: "feishu" | "slack" | "kael";
  /** Pre-fixed status when editing. */
  initialStatus?: "active" | "inactive";
  /** Title context — usually the agent display name. */
  agentLabel: string;
  pending: boolean;
  errorMessage: string | null;
  onSubmit: (payload: BindingFormSubmit) => void;
};

const EMPTY_FORM = {
  platform: "feishu" as "feishu" | "slack" | "kael",
  feishuAppId: "",
  feishuAppSecret: "",
  credentialsJson: "{}",
  status: "active" as "active" | "inactive",
  externalUserId: "",
  displayName: "",
  kaelUserId: "",
  kaelProjectId: "",
};

export function BindingFormDialog(props: BindingFormProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [credError, setCredError] = useState("");

  useEffect(() => {
    if (props.open) {
      setForm({
        ...EMPTY_FORM,
        platform: props.initialPlatform ?? "feishu",
        status: props.initialStatus ?? "active",
      });
      setCredError("");
    }
  }, [props.open, props.initialPlatform, props.initialStatus]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setCredError("");

    if (props.kind === "user") {
      if (!form.externalUserId) return;
      props.onSubmit({
        kind: "user-create",
        draft: {
          platform: form.platform,
          externalUserId: form.externalUserId,
          displayName: form.displayName || null,
        },
      });
      return;
    }

    // Bot binding (adapter) create or update.
    if (form.platform === "feishu") {
      if (!props.editingId && (!form.feishuAppId || !form.feishuAppSecret)) {
        setCredError("App ID and App Secret are required");
        return;
      }
    } else if (form.platform === "kael") {
      if (!props.editingId && (!form.kaelUserId || !form.kaelProjectId)) {
        setCredError("User ID and Project ID are required");
        return;
      }
    } else {
      const trimmed = form.credentialsJson.trim();
      if (!props.editingId && !trimmed) {
        setCredError("Credentials are required");
        return;
      }
      if (trimmed) {
        try {
          JSON.parse(trimmed);
        } catch {
          setCredError("Invalid JSON");
          return;
        }
      }
    }

    const credentials = buildCredentials(form);
    if (!props.editingId && !credentials) {
      setCredError("Credentials are required");
      return;
    }

    if (props.editingId) {
      props.onSubmit({
        kind: "bot-update",
        status: form.status,
        ...(credentials ? { credentials } : {}),
      });
    } else {
      if (!credentials) return;
      props.onSubmit({
        kind: "bot-create",
        draft: {
          platform: form.platform,
          status: form.status,
          credentials,
        },
      });
    }
  }

  const title =
    props.kind === "user"
      ? `Bind external user → ${props.agentLabel}`
      : props.editingId
        ? `Edit bot binding · ${props.agentLabel}`
        : `Bind bot → ${props.agentLabel}`;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="binding-platform">Platform</Label>
            <select
              id="binding-platform"
              value={form.platform}
              onChange={(e) => setForm({ ...form, platform: e.target.value as typeof form.platform })}
              disabled={!!props.editingId}
              className="flex h-9 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-1 text-body shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            >
              {platformValues.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {props.kind === "user" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="binding-ext-id">External user ID</Label>
                <Input
                  id="binding-ext-id"
                  value={form.externalUserId}
                  onChange={(e) => setForm({ ...form, externalUserId: e.target.value })}
                  placeholder="ou_xxxxxxxx..."
                  className="font-mono"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="binding-name">Display name (optional)</Label>
                <Input
                  id="binding-name"
                  value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                />
              </div>
            </>
          ) : (
            <>
              {form.platform === "feishu" ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="feishu-app-id">
                      App ID{props.editingId ? " — leave empty to keep existing" : ""}
                    </Label>
                    <Input
                      id="feishu-app-id"
                      value={form.feishuAppId}
                      onChange={(e) => setForm({ ...form, feishuAppId: e.target.value })}
                      placeholder="cli_xxxxxxxx"
                      className="font-mono"
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="feishu-app-secret">
                      App Secret{props.editingId ? " — leave empty to keep existing" : ""}
                    </Label>
                    <Input
                      id="feishu-app-secret"
                      type="password"
                      autoComplete="new-password"
                      value={form.feishuAppSecret}
                      onChange={(e) => setForm({ ...form, feishuAppSecret: e.target.value })}
                      placeholder="••••••••"
                    />
                  </div>
                </>
              ) : form.platform === "kael" ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="kael-user-id">
                      User ID{props.editingId ? " — leave empty to keep existing" : ""}
                    </Label>
                    <Input
                      id="kael-user-id"
                      value={form.kaelUserId}
                      onChange={(e) => setForm({ ...form, kaelUserId: e.target.value })}
                      placeholder="user_xxxxxxxx"
                      className="font-mono"
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="kael-project-id">
                      Project ID{props.editingId ? " — leave empty to keep existing" : ""}
                    </Label>
                    <Input
                      id="kael-project-id"
                      value={form.kaelProjectId}
                      onChange={(e) => setForm({ ...form, kaelProjectId: e.target.value })}
                      placeholder="proj_xxxxxxxx"
                      className="font-mono"
                      autoComplete="off"
                    />
                  </div>
                  {!props.editingId && (
                    <p className="text-body" style={{ color: "var(--fg-3)" }}>
                      Agent Token will be created automatically when you save.
                    </p>
                  )}
                </>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="binding-creds">
                    Credentials (JSON){props.editingId ? " — leave empty to keep existing" : ""}
                  </Label>
                  <textarea
                    id="binding-creds"
                    value={form.credentialsJson}
                    onChange={(e) => setForm({ ...form, credentialsJson: e.target.value })}
                    rows={4}
                    className="flex w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-2 text-body shadow-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder='{"bot_token": "xoxb-...", "signing_secret": "..."}'
                  />
                </div>
              )}
              {credError && (
                <p className="text-body" style={{ color: "var(--state-error)" }}>
                  {credError}
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor="binding-status">Status</Label>
                <select
                  id="binding-status"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as "active" | "inactive" })}
                  className="flex h-9 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-1 text-body shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="active">active</option>
                  <option value="inactive">inactive</option>
                </select>
              </div>
            </>
          )}

          {props.errorMessage && (
            <div className="text-body" style={{ color: "var(--state-error)" }}>
              {props.errorMessage}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)} disabled={props.pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={props.pending}>
              {props.pending ? "Saving…" : props.editingId ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function buildCredentials(form: typeof EMPTY_FORM): Record<string, unknown> | null {
  if (form.platform === "feishu") {
    if (!form.feishuAppId && !form.feishuAppSecret) return null;
    if (!form.feishuAppId || !form.feishuAppSecret) return null;
    return { app_id: form.feishuAppId, app_secret: form.feishuAppSecret };
  }
  if (form.platform === "kael") {
    if (!form.kaelUserId && !form.kaelProjectId) return null;
    if (!form.kaelUserId || !form.kaelProjectId) return null;
    return { kaelUserId: form.kaelUserId, kaelProjectId: form.kaelProjectId };
  }
  const trimmed = form.credentialsJson.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as Record<string, unknown>;
}
