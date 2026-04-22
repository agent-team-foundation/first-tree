import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { type HubClient, listClients } from "../api/activity.js";
import { createAgent } from "../api/agents.js";
import { ApiError, type ValidationIssue } from "../api/client.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

/** Mirrors the `createAgentSchema` name regex in `packages/shared/src/schemas/agent.ts`. */
const NAME_PATTERN = /^[a-z0-9_-]+$/;
const NAME_MAX = 100;

type FieldKey = "name" | "displayName" | "clientId";
type FieldErrors = Partial<Record<FieldKey | "_root", string>>;

/**
 * Map a server-returned validation-issue array (Zod `issues` shape, forwarded
 * by the server's `setErrorHandler` as `details[]`) to per-field messages.
 * Issues whose `path` doesn't point at a known form field fall through to
 * `_root` so they still surface somewhere instead of being silently dropped.
 */
function issuesToFieldErrors(issues: ValidationIssue[] | undefined): FieldErrors {
  if (!issues || issues.length === 0) return {};
  const out: FieldErrors = {};
  const known: readonly FieldKey[] = ["name", "displayName", "clientId"];
  for (const issue of issues) {
    const head = issue.path[0];
    if (typeof head === "string" && (known as readonly string[]).includes(head)) {
      const key = head as FieldKey;
      // First message for a field wins; later issues are usually less specific.
      if (!out[key]) out[key] = issue.message;
    } else {
      out._root = issue.message;
    }
  }
  return out;
}

/**
 * Simplified agent creation dialog for the onboarding flow (M5).
 *
 * Hidden defaults (see hub-onboarding-mvp proposal §2.2):
 *   - type = "personal_assistant" (Team agents go through a different path)
 *   - manager = current user (admin-assisted creation uses a separate UI)
 *   - delegateMention, visibility, clientId = not surfaced
 *
 * Name vs. display name:
 *   - `name` is the permanent hub ID (lowercase slug). Format help is shown
 *     inline so the rule is visible before the user hits Submit.
 *   - `displayName` is the friendly label and defaults to the user's raw
 *     text input. We keep the two linked until the user edits `displayName`
 *     directly — after that, editing `name` no longer touches it.
 *
 * Runtime choice:
 *   - "claude-code" — agent binds to the user's computer on first WS connect.
 *     After create, we hand the dialog off to `LastStepModal` for the
 *     `curl | sh … --token` command + polling.
 *   - "kael" — agent runs in the hub's managed runtime. Disabled for
 *     Pre-MVP until adapter_configs provisioning lands (#86).
 *
 * Prompt is intentionally not asked here — users edit it on the agent detail
 * page after creation. Keeps onboarding focused on identity + location.
 */

type Runtime = "claude-code" | "kael";

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called after the agent row is created. Receives the new agent and the
   * chosen runtime so the caller can decide what to do next (e.g. open the
   * Last-step modal for Claude Code, or redirect to the Workspace for Kael).
   */
  onCreated: (agent: Agent, runtime: Runtime) => void;
};

type Step = "form" | "pick-computer";

export function NewAgentDialog({ open, onOpenChange, onCreated }: Props) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [displayNameDirty, setDisplayNameDirty] = useState(false);
  const [runtime, setRuntime] = useState<Runtime>("claude-code");

  // Step 2 state — shown only when the user has multiple connected computers
  // and we need them to pick one for the new agent to pin to.
  const [step, setStep] = useState<Step>("form");
  const [candidateClients, setCandidateClients] = useState<HubClient[]>([]);
  const [pickedClientId, setPickedClientId] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (open) {
      setName("");
      setNameDirty(false);
      setDisplayName("");
      setDisplayNameDirty(false);
      setRuntime("claude-code");
      setStep("form");
      setCandidateClients([]);
      setPickedClientId(null);
      setProbing(false);
      setClientErrors({});
    }
  }, [open]);

  const slug = slugify(name);

  const createMut = useMutation({
    mutationFn: async (opts: { clientId?: string }) => {
      const effectiveDisplay = displayName.trim() || name.trim() || "Untitled assistant";
      const effectiveName = slug || undefined;
      // When a clientId is provided (scenario B), the server pins the agent
      // on create and emits an `agent:pinned` WebSocket frame to the
      // matching client; its runtime then writes the local agent.yaml and
      // opens the agent WS on its own. The caller can skip the Last-step
      // modal and jump straight to the Workspace.
      return createAgent({
        name: effectiveName,
        type: "personal_assistant",
        displayName: effectiveDisplay,
        clientId: opts.clientId,
      });
    },
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      onCreated(agent, runtime);
    },
  });

  // Translate a server validation error (Zod `issues[]` emitted by the server
  // `setErrorHandler` in `app.ts`) into per-field messages. Non-validation
  // errors fall through to `_root` so they still render as a banner —
  // except the 409 uniqueness conflict, which we attach to the `name` field
  // because "already exists" is specifically a name collision.
  const serverErrors = useMemo<FieldErrors>(() => {
    const err = createMut.error;
    if (!err) return {};
    if (err instanceof ApiError) {
      const fromIssues = issuesToFieldErrors(err.issues);
      if (Object.keys(fromIssues).length > 0) return fromIssues;
      if (err.status === 409) {
        return { name: "That hub ID is already in use in this organization. Pick a different one." };
      }
      return { _root: err.message };
    }
    if (err instanceof Error) return { _root: err.message };
    return {};
  }, [createMut.error]);

  const fieldErrors: FieldErrors = { ...serverErrors, ...clientErrors };

  /**
   * Client-side mirror of `createAgentSchema` (`name` regex + length) so users
   * see a specific reason before the network round-trip instead of a generic
   * "Error" blob. The server still validates authoritatively. Note: `name`
   * here is the slugified hub ID, not the raw free-text input.
   */
  function validateForm(): FieldErrors {
    const errs: FieldErrors = {};
    if (slug) {
      if (slug.length > NAME_MAX) {
        errs.name = `Hub ID must be at most ${NAME_MAX} characters (got ${slug.length}).`;
      } else if (!NAME_PATTERN.test(slug)) {
        // Shouldn't happen because slugify() enforces the charset, but keep
        // the branch so drift in either direction surfaces clearly instead
        // of as a generic server error.
        errs.name = "Hub ID must contain only lowercase letters, digits, hyphens (-), and underscores (_).";
      }
    } else if (name.trim().length > 0) {
      // Raw input had content but slugify() stripped it down to nothing —
      // e.g. pure-symbol input like "!!!". Server would auto-generate, but
      // the user probably didn't intend that; surface the issue.
      errs.name = "Name must contain at least one letter or digit (e.g. a-z, 0-9).";
    }
    if (displayName.length > 200) {
      errs.displayName = `Display name must be at most 200 characters (got ${displayName.length}).`;
    }
    return errs;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errs = validateForm();
    setClientErrors(errs);
    if (Object.keys(errs).length > 0) return;

    if (runtime !== "claude-code") {
      // Kael (disabled in UI today) wouldn't pin to a local computer anyway.
      createMut.mutate({ clientId: undefined });
      return;
    }

    // Probe the caller's connected computers. If exactly one is online, pin
    // the new agent there so the server emits `agent:pinned` and the client
    // runtime auto-registers — no Last-step terminal step needed. If multiple
    // are online, flip to the pick-computer step and let the user choose.
    // If none or the probe itself fails, fall through to the Last-step modal.
    setProbing(true);
    try {
      const clients = await listClients();
      const connected = clients.filter((c) => c.status === "connected");

      if (connected.length === 0) {
        createMut.mutate({ clientId: undefined });
        return;
      }

      if (connected.length === 1) {
        createMut.mutate({ clientId: connected[0]?.id });
        return;
      }

      // Sort most-recent-seen first so the default selection is the computer
      // the user is most likely currently using.
      const sorted = [...connected].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
      setCandidateClients(sorted);
      setPickedClientId(sorted[0]?.id ?? null);
      setStep("pick-computer");
    } catch {
      // Probe failure (network blip, stale token) shouldn't block the user —
      // fall back to the Last-step modal so they can finish onboarding via
      // the terminal path.
      createMut.mutate({ clientId: undefined });
    } finally {
      setProbing(false);
    }
  }

  function handlePickerConfirm() {
    if (!pickedClientId) return;
    createMut.mutate({ clientId: pickedClientId });
  }

  const canSubmit = name.trim().length > 0 && !createMut.isPending && !probing;

  if (step === "pick-computer") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Choose a computer</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-body text-muted-foreground">
              Multiple computers are online. Pick where <span className="font-medium">{name}</span> should run:
            </p>
            <div className="space-y-2">
              {candidateClients.map((client) => {
                const picked = pickedClientId === client.id;
                return (
                  <label
                    key={client.id}
                    className={
                      picked
                        ? "flex items-start gap-3 rounded-md border border-primary bg-primary/5 p-3 cursor-pointer"
                        : "flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-accent/30"
                    }
                  >
                    <input
                      type="radio"
                      name="target-computer"
                      checked={picked}
                      onChange={() => setPickedClientId(client.id)}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-body font-medium truncate">{client.hostname ?? client.id}</div>
                      <div className="text-caption text-muted-foreground">
                        {client.os ?? "unknown OS"} · last seen {new Date(client.lastSeenAt).toLocaleString()}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            {fieldErrors.clientId && <p className="text-body text-destructive">{fieldErrors.clientId}</p>}
            {fieldErrors._root && (
              <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-body text-destructive">
                {fieldErrors._root}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStep("form")} disabled={createMut.isPending}>
              Back
            </Button>
            <Button onClick={handlePickerConfirm} disabled={!pickedClientId || createMut.isPending}>
              {createMut.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="new-agent-name">Name</Label>
            <Input
              id="new-agent-name"
              value={name}
              onChange={(e) => {
                const next = e.target.value;
                setName(next);
                setNameDirty(true);
                if (!displayNameDirty) setDisplayName(next);
                if (clientErrors.name) setClientErrors((prev) => ({ ...prev, name: undefined }));
              }}
              placeholder="My Dev Assistant"
              autoFocus
              maxLength={NAME_MAX}
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby="new-agent-name-help new-agent-name-error"
            />
            <p id="new-agent-name-help" className="text-caption text-muted-foreground">
              Hub ID: lowercase letters, digits, hyphens (-), and underscores (_). Up to {NAME_MAX} characters.
              Permanent after creation — you can't rename the agent later.
            </p>
            {nameDirty && slug && (
              <p className="text-caption text-muted-foreground">
                ID on hub: <span className="font-mono">{slug}</span>
              </p>
            )}
            {fieldErrors.name && (
              <p id="new-agent-name-error" className="text-caption text-destructive">
                {fieldErrors.name}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-agent-display-name">Display name</Label>
            <Input
              id="new-agent-display-name"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setDisplayNameDirty(true);
                if (clientErrors.displayName) setClientErrors((prev) => ({ ...prev, displayName: undefined }));
              }}
              placeholder="How teammates see this agent"
              maxLength={200}
              aria-invalid={fieldErrors.displayName ? true : undefined}
              aria-describedby="new-agent-display-name-help new-agent-display-name-error"
            />
            <p id="new-agent-display-name-help" className="text-caption text-muted-foreground">
              Shown in chats and lists. Defaults to the Name above; you can change it anytime later.
            </p>
            {fieldErrors.displayName && (
              <p id="new-agent-display-name-error" className="text-caption text-destructive">
                {fieldErrors.displayName}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Where it runs</Label>
            <div className="space-y-2">
              <label
                className={
                  runtime === "claude-code"
                    ? "flex items-start gap-3 rounded-md border border-primary bg-primary/5 p-3 cursor-pointer"
                    : "flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-accent/30"
                }
              >
                <input
                  type="radio"
                  name="runtime"
                  checked={runtime === "claude-code"}
                  onChange={() => setRuntime("claude-code")}
                  className="mt-1"
                />
                <div>
                  <div className="text-body font-medium">Claude Code</div>
                  <div className="text-caption text-muted-foreground">
                    Runs on your computer, can access your local files. (default)
                  </div>
                </div>
              </label>
              <label
                className="flex items-start gap-3 rounded-md border border-border p-3 cursor-not-allowed opacity-60"
                title="Coming soon"
              >
                <input type="radio" name="runtime" disabled className="mt-1" />
                <div>
                  <div className="text-body font-medium">
                    Kael <span className="ml-1 text-caption font-normal text-muted-foreground">— coming soon</span>
                  </div>
                  <div className="text-caption text-muted-foreground">Ready to go, runs in the cloud.</div>
                </div>
              </label>
            </div>
          </div>

          {fieldErrors._root && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-body text-destructive">
              {fieldErrors._root}
            </div>
          )}

          <DialogFooter>
            <Button type="submit" disabled={!canSubmit}>
              {probing ? "Checking computers…" : createMut.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
