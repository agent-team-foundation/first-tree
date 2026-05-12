import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_REGEX,
  type Agent,
  type AgentVisibility,
  type ClientCapabilities,
  isReservedAgentName,
  type RuntimeProvider,
} from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { getClientCapabilities, type HubClient, listClients } from "../api/activity.js";
import { type AgentNameAvailability, checkAgentNameAvailability, createAgent } from "../api/agents.js";
import { ApiError, api, type ValidationIssue } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { slugify } from "../utils/agent-naming.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

const DISPLAY_NAME_MAX = 200;

type FieldKey = "name" | "displayName" | "clientId";
type FieldErrors = Partial<Record<FieldKey | "_root", string>>;

function issuesToFieldErrors(issues: ValidationIssue[] | undefined): FieldErrors {
  if (!issues || issues.length === 0) return {};
  const out: FieldErrors = {};
  const known: readonly FieldKey[] = ["name", "displayName", "clientId"];
  for (const issue of issues) {
    const head = issue.path[0];
    if (typeof head === "string" && (known as readonly string[]).includes(head)) {
      const key = head as FieldKey;
      if (!out[key]) out[key] = issue.message;
    } else {
      out._root = issue.message;
    }
  }
  return out;
}

/**
 * Simplified agent creation dialog for the onboarding flow.
 *
 * Display-name-first layout (see docs/agent-naming-design.md §3.6):
 *   - "Display name" is the primary input at the top (required-feeling, unicode).
 *   - The derived @handle previews under the display name as a quiet
 *     `@my-dev-assistant · permanent · Edit` line. Most users never need to
 *     touch it; clicking Edit reveals the full handle editor (input, helper,
 *     availability status). Editing severs the slug-follows-display-name
 *     link so the user stays in control.
 *   - A debounced availability probe calls the server so collisions and
 *     reserved words surface inline before submit; the error shows under
 *     the compact preview too, so the collapsed view never hides a problem.
 *
 * Hidden defaults:
 *   - type = "personal_assistant"
 *   - manager = current user
 *   - delegateMention = not surfaced
 *
 * Surfaced choices: visibility (shared with team / private to you), the
 * connected computer the agent will run on, and the runtime provider —
 * filtered to whatever is actually installed and signed-in on that
 * computer (mirrors onboarding step 2).
 */

// Runtime selection sources its values from `RuntimeProvider`; new providers
// extend the union in `@agent-team-foundation/first-tree-hub-shared` and the
// dialog picks them up automatically.

/**
 * Lightweight normalizer applied to every keystroke in the agent-name
 * input: downcase + fold illegal runs to `-`, but keep trailing `-` /
 * `_` so users can type `alice-bot` one character at a time. Leading
 * separators are still stripped because the server regex will reject
 * them on submit and live-feedback is more useful than tolerating an
 * input that can't be saved.
 */
function normalizeNameInput(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, AGENT_NAME_MAX_LENGTH);
}

/**
 * Narrow an arbitrary capability key to a `RuntimeProvider`. Capability
 * blobs are `Record<string, ...>` so old clients can ship runtimes the UI
 * doesn't know about yet — the UI just ignores anything it can't render.
 */
function asRuntimeProvider(provider: string): RuntimeProvider | null {
  if (provider === "claude-code" || provider === "codex") return provider;
  return null;
}

/**
 * Pick the preferred runtime among the ones in `ok` state on a given
 * client. Claude Code wins over Codex; if neither is ok we fall back to
 * whatever else the client reports as ok (still narrowed to a known
 * RuntimeProvider), then `null`.
 */
function pickPreferredRuntime(caps: ClientCapabilities): RuntimeProvider | null {
  if (caps["claude-code"]?.state === "ok") return "claude-code";
  if (caps.codex?.state === "ok") return "codex";
  for (const [provider, entry] of Object.entries(caps)) {
    if (entry.state === "ok") {
      const rt = asRuntimeProvider(provider);
      if (rt) return rt;
    }
  }
  return null;
}

function prettyRuntimeLabel(provider: RuntimeProvider): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex") return "Codex";
  return provider;
}

function availabilityReasonMessage(reason: "invalid" | "reserved" | "taken"): string {
  switch (reason) {
    case "taken":
      return "That agent name is already in use in this organization. Pick a different one.";
    case "reserved":
      return "That agent name is reserved — pick a different one.";
    case "invalid":
      return "Agent name must start with a letter or digit and contain only lowercase letters, digits, hyphens (-), and underscores (_).";
  }
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agent: Agent, runtimeProvider: RuntimeProvider) => void;
};

type AvailabilityState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok" }
  | { status: "bad"; reason: "invalid" | "reserved" | "taken" };

export function NewAgentDialog({ open, onOpenChange, onCreated }: Props) {
  const queryClient = useQueryClient();
  const { refreshMe, organizationId } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  // Default is "private": the surfaced agent type is `personal_assistant`
  // (literally "personal"), so the conservative default is "only I see it".
  // Sharing with the team is an explicit decision the user opts into; the
  // previous default ("organization") quietly published every onboarding
  // agent into the team roster, which surprised users who expected
  // personal-assistant to mean personal.
  const [visibility, setVisibility] = useState<AgentVisibility>("private");
  const [runtime, setRuntime] = useState<RuntimeProvider>("claude-code");
  // The @handle editor is collapsed by default — 99% of users keep the
  // auto-derived slug. The preview line under "Display name" surfaces it
  // and offers an Edit affordance for the rest.
  const [editingHandle, setEditingHandle] = useState(false);

  // Computer + runtime detection — lifted into the form so the user sees
  // which machine will host the agent (and which runtimes are actually
  // installed there) before clicking Create. Mirrors onboarding step 2.
  const [connectedClients, setConnectedClients] = useState<HubClient[]>([]);
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const [pickedClientId, setPickedClientId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ClientCapabilities | null>(null);
  const [capabilitiesClientId, setCapabilitiesClientId] = useState<string | null>(null);
  // Connect-token state for the zero-computer recovery affordance. We only
  // generate one when 0 clients are connected; the dialog then shows the
  // real `first-tree-hub connect <token>` command instead of a useless
  // bare-command hint (codex review caught this). We hold the full
  // command string from the server response so the CLI binary name stays
  // a server-side concern — if it ever changes the dialog won't drift.
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [connectCommand, setConnectCommand] = useState<string | null>(null);
  const [connectTokenExpiresAt, setConnectTokenExpiresAt] = useState<number | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const [availability, setAvailability] = useState<AvailabilityState>({ status: "idle" });

  useEffect(() => {
    if (open) {
      setDisplayName("");
      setName("");
      setNameDirty(false);
      setVisibility("private");
      setRuntime("claude-code");
      setEditingHandle(false);
      setConnectedClients([]);
      setClientsLoaded(false);
      setPickedClientId(null);
      setCapabilities(null);
      setCapabilitiesClientId(null);
      setConnectToken(null);
      setConnectCommand(null);
      setConnectTokenExpiresAt(null);
      setTokenCopied(false);
      setClientErrors({});
      setAvailability({ status: "idle" });
    }
  }, [open]);

  // Keep the agent name following the display name until the user
  // explicitly edits the agent name. After `nameDirty = true`, changes to
  // display name no longer rewrite the slug.
  useEffect(() => {
    if (nameDirty) return;
    setName(slugify(displayName));
  }, [displayName, nameDirty]);

  // Debounced availability probe. Mirrors the client-side format check so
  // we don't waste a round-trip when the slug can't possibly be valid; once
  // it passes the local check, a 300ms debounce gates the network call so
  // typing a full name doesn't fan out into per-keystroke requests.
  const latestProbeIdRef = useRef(0);
  useEffect(() => {
    if (!open || !name) {
      setAvailability({ status: "idle" });
      return;
    }
    if (!AGENT_NAME_REGEX.test(name)) {
      setAvailability({ status: "bad", reason: "invalid" });
      return;
    }
    if (isReservedAgentName(name)) {
      setAvailability({ status: "bad", reason: "reserved" });
      return;
    }
    const probeId = ++latestProbeIdRef.current;
    setAvailability({ status: "checking" });
    const timer = window.setTimeout(() => {
      checkAgentNameAvailability(name)
        .then((res: AgentNameAvailability) => {
          // Ignore stale responses: the user may have typed more characters
          // while the in-flight request was pending, in which case this
          // handler no longer speaks for the current input.
          if (probeId !== latestProbeIdRef.current) return;
          if (res.available) {
            setAvailability({ status: "ok" });
          } else {
            setAvailability({ status: "bad", reason: res.reason });
          }
        })
        .catch(() => {
          if (probeId !== latestProbeIdRef.current) return;
          // Network-level failure shouldn't block submission — the server
          // validates authoritatively on POST. Fall back to idle.
          setAvailability({ status: "idle" });
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [name, open]);

  // Poll `listClients` to keep the connected-computer list fresh while the
  // dialog is open. 3s cadence matches onboarding step 2 so a computer
  // coming online (or going offline) reflects without the user closing
  // and reopening the dialog.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const list = await listClients();
        if (cancelled) return;
        const connected = list
          .filter((c) => c.status === "connected")
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
        setConnectedClients(connected);
        setClientsLoaded(true);
      } catch {
        // Best-effort. Mark as loaded so the empty-state UI shows instead of
        // a forever spinner — the user can still see *something* and the
        // next tick will recover.
        if (!cancelled) setClientsLoaded(true);
      }
    };
    void tick();
    const handle = window.setInterval(tick, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [open]);

  // Auto-pick the most-recently-seen connected client, but stay on the
  // user's manual choice as long as it's still in the list.
  useEffect(() => {
    if (connectedClients.length === 0) {
      setPickedClientId(null);
      return;
    }
    setPickedClientId((prev) => {
      if (prev && connectedClients.some((c) => c.id === prev)) return prev;
      return connectedClients[0]?.id ?? null;
    });
  }, [connectedClients]);

  // Capability fetch — polls every 3s while a client is picked. Same
  // cadence as the listClients poll above so a transient API failure
  // self-heals on the next tick rather than freezing the UI in
  // "Detecting installed runtimes…" until the user reopens the dialog.
  // Mirrors onboarding step 2's `detect` loop.
  useEffect(() => {
    if (!pickedClientId) {
      setCapabilities(null);
      setCapabilitiesClientId(null);
      return;
    }
    let cancelled = false;
    const fetchCaps = async (): Promise<void> => {
      try {
        const res = await getClientCapabilities(pickedClientId);
        if (cancelled) return;
        setCapabilities(res.capabilities);
        setCapabilitiesClientId(pickedClientId);
      } catch {
        // Transient — keep whatever we have (initial null shows "detecting…",
        // prior success keeps the chips). The next tick will retry.
      }
    };
    void fetchCaps();
    const handle = window.setInterval(fetchCaps, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [pickedClientId]);

  // Connect-token generation. Only fires when the dialog is open AND the
  // user has zero connected computers — so an existing user creating their
  // Nth agent doesn't burn a token just by opening the dialog. Mirrors
  // onboarding step 2's token-refresh logic: schedule a clear at expiry
  // and let the next render fetch a fresh one.
  useEffect(() => {
    if (!open) return;
    if (connectedClients.length > 0) return;
    if (connectToken && connectTokenExpiresAt && connectTokenExpiresAt > Date.now()) {
      const refreshAt = Math.max(connectTokenExpiresAt - Date.now(), 0);
      const handle = window.setTimeout(() => {
        setConnectToken(null);
        setConnectTokenExpiresAt(null);
      }, refreshAt);
      return () => window.clearTimeout(handle);
    }
    if (connectToken) {
      // Expired token still hanging around — clear it before fetching anew.
      setConnectToken(null);
      setConnectCommand(null);
      setConnectTokenExpiresAt(null);
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.post<{ token: string; expiresIn: number; command: string }>("/me/connect-tokens", {});
        if (cancelled) return;
        setConnectToken(r.token);
        setConnectCommand(r.command);
        setConnectTokenExpiresAt(Date.now() + r.expiresIn * 1000);
      } catch {
        // Best-effort. The UI shows "Generating token…" until the user
        // reopens the dialog; we don't surface this as a hard error since
        // the user's primary path (connect any machine that's already
        // configured) doesn't depend on it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, connectedClients.length, connectToken, connectTokenExpiresAt]);

  // Capabilities tied to the *currently* picked client only — guards
  // against acting on stale data right after the user switches machines.
  const activeCapabilities = pickedClientId && capabilitiesClientId === pickedClientId ? capabilities : null;
  const okRuntimes = useMemo<RuntimeProvider[]>(() => {
    if (!activeCapabilities) return [];
    const out: RuntimeProvider[] = [];
    for (const [provider, entry] of Object.entries(activeCapabilities)) {
      if (entry.state !== "ok") continue;
      const rt = asRuntimeProvider(provider);
      if (rt) out.push(rt);
    }
    return out;
  }, [activeCapabilities]);

  // Realign the runtime selection whenever the picked client's capabilities
  // change — if the previous selection isn't `ok` on the new machine, fall
  // back to whatever the new machine prefers. Same pattern as onboarding.
  useEffect(() => {
    if (!activeCapabilities) return;
    setRuntime((prev) => {
      if (activeCapabilities[prev]?.state === "ok") return prev;
      return pickPreferredRuntime(activeCapabilities) ?? prev;
    });
  }, [activeCapabilities]);

  const createMut = useMutation({
    mutationFn: async (opts: { clientId?: string }) => {
      const effectiveDisplay = displayName.trim() || name.trim() || "Untitled assistant";
      const effectiveName = name || undefined;
      return createAgent({
        name: effectiveName,
        type: "personal_assistant",
        displayName: effectiveDisplay,
        clientId: opts.clientId,
        runtimeProvider: runtime,
        visibility,
        // Pin the agent to the org the user is currently viewing in the
        // dropdown — the JWT default org is non-deterministic across logins
        // (auth.ts member pick) and creating into "wherever the JWT lands"
        // is the source of "I created it in atf, why is it in gandy02?".
        ...(organizationId ? { organizationId } : {}),
      });
    },
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      // Refresh /me so onboardingStep flips to "completed" — otherwise the
      // onboarding banner sticks around even though the user just
      // created an agent through this non-onboarding path.
      void refreshMe();
      onCreated(agent, runtime);
    },
  });

  const serverErrors = useMemo<FieldErrors>(() => {
    const err = createMut.error;
    if (!err) return {};
    if (err instanceof ApiError) {
      const fromIssues = issuesToFieldErrors(err.issues);
      if (Object.keys(fromIssues).length > 0) return fromIssues;
      if (err.status === 409) {
        return { name: "That agent name is already in use in this organization. Pick a different one." };
      }
      return { _root: err.message };
    }
    if (err instanceof Error) return { _root: err.message };
    return {};
  }, [createMut.error]);

  const availabilityError = availability.status === "bad" ? availabilityReasonMessage(availability.reason) : undefined;
  const fieldErrors: FieldErrors = {
    ...(availabilityError ? { name: availabilityError } : {}),
    ...serverErrors,
    ...clientErrors,
  };

  function validateForm(): FieldErrors {
    const errs: FieldErrors = {};
    if (name) {
      if (name.length > AGENT_NAME_MAX_LENGTH) {
        errs.name = `Agent name must be at most ${AGENT_NAME_MAX_LENGTH} characters (got ${name.length}).`;
      } else if (!AGENT_NAME_REGEX.test(name)) {
        errs.name =
          "Agent name must start with a letter or digit and contain only lowercase letters, digits, hyphens (-), and underscores (_).";
      } else if (isReservedAgentName(name)) {
        errs.name = "That agent name is reserved — pick a different one.";
      }
    } else if (displayName.trim().length > 0) {
      // Display name had content but slugify collapsed it to nothing (e.g.
      // pure-symbol or pure-CJK input). Server would auto-generate a name,
      // but the user probably didn't intend that — surface it.
      errs.name = "Agent name must contain at least one letter or digit (e.g. a-z, 0-9).";
    }
    if (displayName.length > DISPLAY_NAME_MAX) {
      errs.displayName = `Display name must be at most ${DISPLAY_NAME_MAX} characters (got ${displayName.length}).`;
    }
    return errs;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errs = validateForm();
    setClientErrors(errs);
    if (Object.keys(errs).length > 0) return;
    if (availability.status === "bad") return;
    if (!pickedClientId) return;
    // Defense in depth: the Create button is disabled when the picked client
    // has no ok runtime or when the current selection isn't ok on it. Guard
    // here too so a button-disabled bypass (browser quirk, Enter while a
    // focused element re-enables submit, etc.) doesn't push an
    // un-runnable agent through.
    if (okRuntimes.length === 0 || !okRuntimes.includes(runtime)) return;
    createMut.mutate({ clientId: pickedClientId });
  }

  const hasBlockingAvailability = availability.status === "bad";
  const canSubmit =
    displayName.trim().length > 0 &&
    !hasBlockingAvailability &&
    !createMut.isPending &&
    !!pickedClientId &&
    okRuntimes.length > 0 &&
    okRuntimes.includes(runtime);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Agent</DialogTitle>
        </DialogHeader>
        {/* min-w-0 lets the grid item (this form) shrink below its
            content's intrinsic width — without it, a long command/token in
            the zero-computer state would push the dialog past max-w-lg. */}
        <form onSubmit={handleSubmit} className="space-y-5 min-w-0">
          <div className="space-y-2">
            <Label htmlFor="new-agent-display-name">Display name</Label>
            <Input
              id="new-agent-display-name"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                if (clientErrors.displayName) setClientErrors((prev) => ({ ...prev, displayName: undefined }));
              }}
              placeholder="My Dev Assistant"
              autoFocus
              maxLength={DISPLAY_NAME_MAX}
              aria-invalid={fieldErrors.displayName ? true : undefined}
              aria-describedby="new-agent-display-name-help new-agent-display-name-error"
            />
            <p id="new-agent-display-name-help" className="text-caption text-muted-foreground">
              How teammates see this agent in chats and lists. Can be changed anytime.
            </p>
            {fieldErrors.displayName && (
              <p id="new-agent-display-name-error" className="text-caption text-destructive">
                {fieldErrors.displayName}
              </p>
            )}
            {/* Compact @handle preview. Lives inside the displayName block so
                it reads as "and here's the handle that comes out of it";
                appears only once the user has typed something so the dialog
                opens quietly. */}
            {!editingHandle && (displayName.trim() || name) && (
              <div className="flex items-baseline gap-2 text-caption text-muted-foreground">
                {name ? (
                  <>
                    <span className="font-mono">@{name}</span>
                    <span aria-hidden>·</span>
                    <span>permanent</span>
                  </>
                ) : (
                  <span className="italic">No @handle from this display name</span>
                )}
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => setEditingHandle(true)}
                  className="text-foreground underline underline-offset-2 hover:text-primary focus:outline-none focus-visible:text-primary"
                >
                  Edit
                </button>
              </div>
            )}
            {!editingHandle && fieldErrors.name && <p className="text-caption text-destructive">{fieldErrors.name}</p>}
          </div>

          {editingHandle && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <Label htmlFor="new-agent-name">Agent name</Label>
                <button
                  type="button"
                  onClick={() => setEditingHandle(false)}
                  className="text-caption text-muted-foreground underline underline-offset-2 hover:text-primary focus:outline-none focus-visible:text-primary"
                >
                  Done
                </button>
              </div>
              <div className="flex items-stretch">
                <span
                  aria-hidden
                  className="inline-flex items-center px-2 font-mono text-body text-muted-foreground border border-r-0 border-input rounded-l-[var(--radius-input)] bg-muted/40"
                >
                  @
                </span>
                <Input
                  id="new-agent-name"
                  value={name}
                  autoFocus
                  onChange={(e) => {
                    // `normalizeNameInput` keeps trailing `-`/`_` so users
                    // can type `alice-bot` one char at a time; the stricter
                    // `slugify` fires only on blur to tidy a trailing
                    // separator the user never follows up with a letter.
                    const next = normalizeNameInput(e.target.value);
                    setName(next);
                    setNameDirty(true);
                    if (clientErrors.name) setClientErrors((prev) => ({ ...prev, name: undefined }));
                  }}
                  onBlur={(e) => {
                    const cleaned = slugify(e.target.value);
                    if (cleaned !== name) setName(cleaned);
                  }}
                  placeholder="my-dev-assistant"
                  className="rounded-l-none font-mono"
                  maxLength={AGENT_NAME_MAX_LENGTH}
                  aria-invalid={fieldErrors.name ? true : undefined}
                  aria-describedby="new-agent-name-help new-agent-name-error new-agent-name-status"
                />
              </div>
              <p id="new-agent-name-help" className="text-caption text-muted-foreground">
                Used in @mentions and CLI commands. Lowercase letters, digits, hyphens (-), and underscores (_). Up to{" "}
                {AGENT_NAME_MAX_LENGTH} characters. Permanent after creation.
              </p>
              {/* availability chip — only renders when there's a status worth
                  announcing. We skip it for the `idle` case (no name typed, or
                  the probe network-failed) so screen readers don't land on an
                  empty paragraph via `aria-describedby`. */}
              {name && !fieldErrors.name && availability.status !== "idle" && (
                <p
                  id="new-agent-name-status"
                  className="text-caption"
                  style={{
                    color:
                      availability.status === "ok"
                        ? "var(--state-idle)"
                        : availability.status === "checking"
                          ? "var(--fg-3)"
                          : "var(--fg-4)",
                  }}
                >
                  {availability.status === "checking" && "Checking availability…"}
                  {availability.status === "ok" && "Available."}
                </p>
              )}
              {fieldErrors.name && (
                <p id="new-agent-name-error" className="text-caption text-destructive">
                  {fieldErrors.name}
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label>Visibility</Label>
            <div className="space-y-2">
              <label
                className={
                  visibility === "organization"
                    ? "flex items-start gap-3 rounded-md border border-primary bg-primary/5 p-3 cursor-pointer"
                    : "flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-accent/30"
                }
              >
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === "organization"}
                  onChange={() => setVisibility("organization")}
                  className="mt-1"
                />
                <div>
                  <div className="text-body font-medium">Shared with team</div>
                  <div className="text-caption text-muted-foreground">
                    Anyone in your org can @mention and chat with this agent.
                  </div>
                </div>
              </label>
              <label
                className={
                  visibility === "private"
                    ? "flex items-start gap-3 rounded-md border border-primary bg-primary/5 p-3 cursor-pointer"
                    : "flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-accent/30"
                }
              >
                <input
                  type="radio"
                  name="visibility"
                  checked={visibility === "private"}
                  onChange={() => setVisibility("private")}
                  className="mt-1"
                />
                <div>
                  <div className="text-body font-medium">Private to you</div>
                  <div className="text-caption text-muted-foreground">
                    Only you can see this agent and chat with it. Others on the team won't see it listed. (default)
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/*
            "Where it runs" block. Reserves a stable minHeight so the dialog
            doesn't visibly jump as async data (listClients → capabilities)
            streams in. Three asynchronous loads used to swap a short
            placeholder paragraph for a tall card, shifting the modal's
            vertical center on every state transition. The reserved space
            below covers the common single-computer + runtime-chip case
            so loading skeletons render *inside* a stable box and
            the surrounding form stays put. Empty `0 computers` and N-radio
            states can still grow taller — that's fine, the jump is only
            from the *initial detection* states which were the visible bug.
          */}
          <div className="space-y-3" style={{ minHeight: 168 }}>
            <Label>Where it runs</Label>

            {/* Computer picker. 0 / 1 / N branches keep the most common
                case (1 connected computer) free of radio-button noise. */}
            {!clientsLoaded ? (
              <ComputerCardSkeleton label="Detecting connected computers…" />
            ) : connectedClients.length === 0 ? (
              <ZeroComputerBlock
                command={connectCommand}
                copied={tokenCopied}
                onCopy={async () => {
                  if (!connectCommand) return;
                  await navigator.clipboard.writeText(connectCommand);
                  setTokenCopied(true);
                  window.setTimeout(() => setTokenCopied(false), 1500);
                }}
              />
            ) : connectedClients.length === 1 ? (
              <SingleComputerCard client={connectedClients[0]} />
            ) : (
              <div className="space-y-2">
                {connectedClients.map((client) => {
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
                        name="picked-client"
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
            )}

            {/* Runtime row. Renders *whenever* a computer is picked OR while
                we're still detecting computers — keeping a stable "Powered
                by" slot below the computer card prevents the second jump
                (skeleton paragraph being replaced by the runtime chip row).
                Only the inner content swaps; the section header and a
                skeleton chip row hold the space. */}
            {(pickedClientId || !clientsLoaded) && (
              <div className="space-y-1.5">
                <div className="text-caption text-muted-foreground">Powered by</div>
                {!pickedClientId || activeCapabilities === null ? (
                  <RuntimeChipsSkeleton />
                ) : okRuntimes.length === 0 ? (
                  <p className="text-caption text-destructive">
                    No runtime ready on this computer. Install Claude Code or Codex on it (and sign in), then come back.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {okRuntimes.map((provider) => {
                      const active = runtime === provider;
                      return (
                        <label
                          key={provider}
                          className={
                            active
                              ? "inline-flex items-center gap-2 rounded-md border border-primary bg-primary/5 px-3 py-1.5 cursor-pointer"
                              : "inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 cursor-pointer hover:bg-accent/30"
                          }
                        >
                          <input type="radio" name="runtime" checked={active} onChange={() => setRuntime(provider)} />
                          <span className="text-body">{prettyRuntimeLabel(provider)}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {fieldErrors.clientId && <p className="text-caption text-destructive">{fieldErrors.clientId}</p>}
          </div>

          {fieldErrors._root && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-body text-destructive">
              {fieldErrors._root}
            </div>
          )}

          <DialogFooter>
            <Button type="submit" disabled={!canSubmit}>
              {createMut.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Empty-state block for "0 computers connected." Shows the real
 * `first-tree-hub connect <token>` command (with a one-shot connect
 * token generated by the parent) so the user can actually recover from
 * this state without leaving the dialog.
 */
function ZeroComputerBlock({
  command,
  copied,
  onCopy,
}: {
  command: string | null;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
      <div className="text-body font-medium">No computer connected yet.</div>
      <div className="text-caption text-muted-foreground">
        Run this on the machine where this agent should live. We&apos;ll pick it up here automatically.
      </div>
      <div className="flex items-stretch gap-2 min-w-0">
        <code
          className="block flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-caption px-2 py-1.5 bg-muted/50 border border-border rounded"
          title={command ?? undefined}
        >
          {command ?? "Generating token…"}
        </code>
        <button
          type="button"
          onClick={onCopy}
          disabled={!command}
          className="shrink-0 px-3 py-1.5 text-caption font-medium border border-border rounded hover:bg-accent/30 disabled:opacity-50"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/**
 * Single-computer card. Used in the common case where the user only has
 * one computer connected — no radio, just a visual confirmation of where
 * the agent will live.
 */
function SingleComputerCard({ client }: { client: HubClient | undefined }) {
  if (!client) return null;
  return (
    <div className="rounded-md border border-primary bg-primary/5 p-3">
      <div className="text-body font-medium truncate">{client.hostname ?? client.id}</div>
      <div className="text-caption text-muted-foreground">
        {client.os ?? "unknown OS"} · last seen {new Date(client.lastSeenAt).toLocaleString()}
      </div>
    </div>
  );
}

/**
 * Loading placeholder that mirrors `SingleComputerCard`'s dimensions
 * (border + 2-line content + same padding) so the surrounding form keeps
 * a stable height while `listClients` is in flight. The previous
 * placeholder was a single-line paragraph, which is what made the dialog
 * visibly jump when the real card replaced it.
 */
function ComputerCardSkeleton({ label }: { label: string }) {
  return (
    <div
      className="rounded-md border border-border bg-muted/20 p-3"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="text-body font-medium" style={{ color: "var(--fg-3)" }}>
        {label}
      </div>
      <div className="text-caption text-muted-foreground">Looking for a machine running the Hub client…</div>
    </div>
  );
}

/**
 * Loading placeholder for the runtime chip row. A single greyed chip-shaped
 * box reserves the height the real chips will occupy. Pairs with
 * `ComputerCardSkeleton` so the whole "Where it runs" block reaches its
 * steady-state height on first paint — no second jump when capabilities
 * resolve.
 */
function RuntimeChipsSkeleton() {
  return (
    <div className="flex flex-wrap gap-2" role="status" aria-live="polite" aria-label="Detecting installed runtimes">
      <span
        className="inline-flex items-center rounded-md border border-border bg-muted/30 px-3 py-1.5 text-body"
        style={{ color: "var(--fg-4)" }}
      >
        Detecting installed runtimes…
      </span>
    </div>
  );
}
