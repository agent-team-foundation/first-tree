import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_REGEX,
  type Agent,
  isReservedAgentName,
} from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { type HubClient, listClients } from "../api/activity.js";
import { type AgentNameAvailability, checkAgentNameAvailability, createAgent } from "../api/agents.js";
import { ApiError, type ValidationIssue } from "../api/client.js";
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
 *   - "Agent name" auto-slugifies from display name and carries the immutable
 *     `@` prefix adornment. Editing it severs the slug-follows-display-name
 *     link so the user stays in control.
 *   - A debounced availability probe calls the server so collisions and
 *     reserved words surface inline before submit.
 *
 * Hidden defaults:
 *   - type = "personal_assistant"
 *   - manager = current user
 *   - delegateMention, visibility, clientId = not surfaced
 */

type Runtime = "claude-code" | "kael";

/**
 * Slugify a free-text label into an agent name. Output always starts with
 * `[a-z0-9]` (stripping leading hyphens/underscores), uses lowercase ASCII
 * only, and is clamped to the max length so server validation never rejects
 * for length alone.
 */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, AGENT_NAME_MAX_LENGTH);
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
  onCreated: (agent: Agent, runtime: Runtime) => void;
};

type Step = "form" | "pick-computer";
type AvailabilityState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok" }
  | { status: "bad"; reason: "invalid" | "reserved" | "taken" };

export function NewAgentDialog({ open, onOpenChange, onCreated }: Props) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [runtime, setRuntime] = useState<Runtime>("claude-code");

  const [step, setStep] = useState<Step>("form");
  const [candidateClients, setCandidateClients] = useState<HubClient[]>([]);
  const [pickedClientId, setPickedClientId] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});
  const [availability, setAvailability] = useState<AvailabilityState>({ status: "idle" });

  useEffect(() => {
    if (open) {
      setDisplayName("");
      setName("");
      setNameDirty(false);
      setRuntime("claude-code");
      setStep("form");
      setCandidateClients([]);
      setPickedClientId(null);
      setProbing(false);
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

  const createMut = useMutation({
    mutationFn: async (opts: { clientId?: string }) => {
      const effectiveDisplay = displayName.trim() || name.trim() || "Untitled assistant";
      const effectiveName = name || undefined;
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errs = validateForm();
    setClientErrors(errs);
    if (Object.keys(errs).length > 0) return;
    if (availability.status === "bad") return;

    if (runtime !== "claude-code") {
      createMut.mutate({ clientId: undefined });
      return;
    }

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

      const sorted = [...connected].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
      setCandidateClients(sorted);
      setPickedClientId(sorted[0]?.id ?? null);
      setStep("pick-computer");
    } catch {
      createMut.mutate({ clientId: undefined });
    } finally {
      setProbing(false);
    }
  }

  function handlePickerConfirm() {
    if (!pickedClientId) return;
    createMut.mutate({ clientId: pickedClientId });
  }

  const hasBlockingAvailability = availability.status === "bad";
  const canSubmit = displayName.trim().length > 0 && !hasBlockingAvailability && !createMut.isPending && !probing;

  if (step === "pick-computer") {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Choose a computer</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-body text-muted-foreground">
              Multiple computers are online. Pick where <span className="font-medium">{displayName || name}</span>{" "}
              should run:
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
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-agent-name">Agent name</Label>
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
                onChange={(e) => {
                  const next = slugify(e.target.value);
                  setName(next);
                  setNameDirty(true);
                  if (clientErrors.name) setClientErrors((prev) => ({ ...prev, name: undefined }));
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
            {/* availability chip — only renders when we actually have a name */}
            {name && !fieldErrors.name && (
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
