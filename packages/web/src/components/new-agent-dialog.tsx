import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_REGEX,
  type Agent,
  type ClientCapabilities,
  isReservedAgentName,
  type RuntimeProvider,
} from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { generateConnectToken, getClientCapabilities, type HubClient, listClients } from "../api/activity.js";
import { type AgentNameAvailability, checkAgentNameAvailability, createAgent } from "../api/agents.js";
import { ApiError, type ValidationIssue } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { slugify } from "../utils/agent-naming.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

const DISPLAY_NAME_MAX = 200;
const CLIENT_DETECT_POLL_MS = 3_000;

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

function normalizeNameInput(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
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

function prettyRuntimeLabel(provider: string): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex") return "Codex";
  return provider;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

type AvailabilityState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok" }
  | { status: "bad"; reason: "invalid" | "reserved" | "taken" };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agent: Agent, runtimeProvider: RuntimeProvider) => void;
};

/**
 * Agent creation dialog used on /team for non-first-time users.
 *
 * Mirrors the visual language of the first-time `OnboardingView`: connected-
 * client pill, "Powered by" runtime chips, inline command box + waiting dot
 * for the empty state. Always shows the bound computer up front so the user
 * never points at a black box on submit.
 */
export function NewAgentDialog({ open, onOpenChange, onCreated }: Props) {
  const queryClient = useQueryClient();
  const { refreshMe, organizationId, currentMembership } = useAuth();

  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [handleExpanded, setHandleExpanded] = useState(false);
  const [availability, setAvailability] = useState<AvailabilityState>({ status: "idle" });

  const [clients, setClients] = useState<HubClient[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ClientCapabilities | null>(null);
  const [capabilitiesClientId, setCapabilitiesClientId] = useState<string | null>(null);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [selectedRuntime, setSelectedRuntime] = useState<RuntimeProvider | null>(null);
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [connectTokenExpiresAt, setConnectTokenExpiresAt] = useState<number | null>(null);
  const [clientErrors, setClientErrors] = useState<FieldErrors>({});

  const capsSeqRef = useRef(0);

  // Reset state when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setDisplayName("");
    setName("");
    setNameDirty(false);
    setHandleExpanded(false);
    setAvailability({ status: "idle" });
    setClients([]);
    setSelectedClientId(null);
    setCapabilities(null);
    setCapabilitiesClientId(null);
    setCapabilitiesError(null);
    setSelectedRuntime(null);
    setConnectToken(null);
    setConnectTokenExpiresAt(null);
    setClientErrors({});
  }, [open]);

  // Slug follows display name until the user explicitly edits it.
  useEffect(() => {
    if (nameDirty) return;
    setName(slugify(displayName));
  }, [displayName, nameDirty]);

  // Debounced availability probe — only runs while the slug section is open
  // (no point hitting the server while the user hasn't even seen the slug).
  useEffect(() => {
    if (!open || !handleExpanded || !name) {
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
    let cancelled = false;
    setAvailability({ status: "checking" });
    const timer = window.setTimeout(() => {
      checkAgentNameAvailability(name)
        .then((res: AgentNameAvailability) => {
          if (cancelled) return;
          setAvailability(res.available ? { status: "ok" } : { status: "bad", reason: res.reason });
        })
        .catch(() => {
          if (cancelled) return;
          setAvailability({ status: "idle" });
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [name, open, handleExpanded]);

  // Live-detect this user's clients while the dialog is open. Re-fetching on
  // every tick is intentional: if the user runs `client connect` mid-flow we
  // want the list to update without anyone touching the dialog.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const detect = async (): Promise<void> => {
      try {
        const list = await listClients();
        if (cancelled) return;
        setClients(list);
      } catch {
        // best-effort
      }
    };
    void detect();
    const handle = setInterval(detect, CLIENT_DETECT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [open]);

  // Default-pick a client: prefer connected, then most-recent lastSeenAt.
  // Reset the pick if it disappears from the list.
  useEffect(() => {
    if (clients.length === 0) {
      if (selectedClientId !== null) setSelectedClientId(null);
      return;
    }
    if (selectedClientId && clients.some((c) => c.id === selectedClientId)) return;
    const sorted = [...clients].sort((a, b) => {
      const aOnline = a.status === "connected" ? 0 : 1;
      const bOnline = b.status === "connected" ? 0 : 1;
      if (aOnline !== bOnline) return aOnline - bOnline;
      return b.lastSeenAt.localeCompare(a.lastSeenAt);
    });
    setSelectedClientId(sorted[0]?.id ?? null);
  }, [clients, selectedClientId]);

  // Fetch capabilities for the currently selected client.
  useEffect(() => {
    if (!selectedClientId) {
      setCapabilities(null);
      setCapabilitiesClientId(null);
      setCapabilitiesError(null);
      return;
    }
    let cancelled = false;
    const seq = ++capsSeqRef.current;
    setCapabilitiesError(null);
    void (async () => {
      try {
        const res = await getClientCapabilities(selectedClientId);
        if (cancelled || seq !== capsSeqRef.current) return;
        setCapabilities(res.capabilities);
        setCapabilitiesClientId(selectedClientId);
        setCapabilitiesError(null);
      } catch (err) {
        if (cancelled || seq !== capsSeqRef.current) return;
        // Surface the error so the runtime section can stop spinning on
        // "Detecting…" and tell the user something actionable. Previous
        // capabilities for a different client are dropped via `client !== capabilitiesClientId`.
        setCapabilitiesError(err instanceof Error ? err.message : "Failed to read computer capabilities");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedClientId]);

  const activeCapabilities = selectedClientId && capabilitiesClientId === selectedClientId ? capabilities : null;

  const okRuntimes = useMemo<RuntimeProvider[]>(() => {
    if (!activeCapabilities) return [];
    return Object.entries(activeCapabilities)
      .filter(([, entry]) => entry.state === "ok")
      .map(([provider]) => provider as RuntimeProvider);
  }, [activeCapabilities]);

  // Auto-select first ok runtime; clear if the previous pick is no longer valid.
  useEffect(() => {
    setSelectedRuntime((prev) => {
      if (!activeCapabilities) return prev;
      if (prev && okRuntimes.includes(prev)) return prev;
      return okRuntimes[0] ?? null;
    });
  }, [activeCapabilities, okRuntimes]);

  // Lazy-load a connect token when the user has zero clients.
  // When a token is still valid, schedule a timeout that clears it at expiry
  // so the next effect run mints a fresh one — matches onboarding-view's
  // pattern and avoids regenerating tokens just because `clients.length`
  // flickered.
  useEffect(() => {
    if (!open) return;
    if (clients.length > 0) return;
    if (connectToken && connectTokenExpiresAt && connectTokenExpiresAt > Date.now()) {
      const refreshAt = Math.max(connectTokenExpiresAt - Date.now(), 0);
      const handle = window.setTimeout(() => {
        setConnectToken(null);
        setConnectTokenExpiresAt(null);
      }, refreshAt);
      return () => window.clearTimeout(handle);
    }
    if (connectToken) {
      setConnectToken(null);
      setConnectTokenExpiresAt(null);
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await generateConnectToken();
        if (cancelled) return;
        setConnectToken(r.token);
        setConnectTokenExpiresAt(Date.now() + r.expiresIn * 1000);
      } catch {
        // best-effort; user can still close + retry
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, clients.length, connectToken, connectTokenExpiresAt]);

  const selectedClient = clients.find((c) => c.id === selectedClientId) ?? null;
  const selectedClientOnline = selectedClient?.status === "connected";

  // Returning users (the audience for this dialog) already have the package
  // installed somewhere — copying `npm install -g …` would silently clobber
  // their local version. Show + copy the connect line only. The first-time
  // OnboardingView still ships the install line because new users likely
  // don't have it.
  const cliCommand = connectToken ? `first-tree-hub connect ${connectToken}` : null;

  const createMut = useMutation({
    mutationFn: async () => {
      const effectiveDisplay = displayName.trim() || name.trim() || "Untitled assistant";
      const effectiveName = name || undefined;
      if (!selectedClient || !selectedRuntime) {
        throw new Error("Pick a computer with a runtime before creating.");
      }
      return createAgent({
        name: effectiveName,
        type: "personal_assistant",
        displayName: effectiveDisplay,
        clientId: selectedClient.id,
        runtimeProvider: selectedRuntime,
        ...(organizationId ? { organizationId } : {}),
      });
    },
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      void refreshMe();
      onCreated(agent, selectedRuntime ?? "claude-code");
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
    if (!selectedClient || !selectedRuntime) return;
    createMut.mutate();
  }

  const trimmedDisplay = displayName.trim();
  const canSubmit =
    trimmedDisplay.length > 0 &&
    !!selectedClient &&
    !!selectedRuntime &&
    availability.status !== "bad" &&
    !createMut.isPending;

  const summarySlug = name || slugify(trimmedDisplay) || "agent";
  const orgLabel = currentMembership?.organizationName ?? "this team";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="new-agent-display-name">What should we call this agent?</Label>
            <Input
              id="new-agent-display-name"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                if (clientErrors.displayName) setClientErrors((prev) => ({ ...prev, displayName: undefined }));
              }}
              placeholder="e.g. Code Reviewer"
              autoFocus
              maxLength={DISPLAY_NAME_MAX}
              aria-invalid={fieldErrors.displayName ? true : undefined}
            />
            {fieldErrors.displayName && <p className="text-caption text-destructive">{fieldErrors.displayName}</p>}
            <HandleEditor
              expanded={handleExpanded}
              onToggle={() => setHandleExpanded((v) => !v)}
              name={name}
              onChange={(next) => {
                setName(next);
                setNameDirty(true);
                if (clientErrors.name) setClientErrors((prev) => ({ ...prev, name: undefined }));
              }}
              onBlurCleanup={() => {
                const cleaned = slugify(name);
                if (cleaned !== name) setName(cleaned);
              }}
              availability={availability}
              error={fieldErrors.name}
            />
          </div>

          <div className="space-y-2">
            <Label>Where will it run?</Label>
            <ComputerSection
              clients={clients}
              selectedClientId={selectedClientId}
              onSelectClient={setSelectedClientId}
              cliCommand={cliCommand}
            />
          </div>

          <div className="space-y-2">
            <Label>Powered by</Label>
            <RuntimeSection
              hasClient={!!selectedClient}
              capabilitiesLoaded={activeCapabilities !== null}
              capabilitiesError={capabilitiesError}
              runtimes={okRuntimes}
              selected={selectedRuntime}
              onSelect={setSelectedRuntime}
              hostname={selectedClient?.hostname ?? null}
            />
          </div>

          {fieldErrors._root && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-body text-destructive">
              {fieldErrors._root}
            </div>
          )}

          {trimmedDisplay && selectedClient && selectedRuntime && (
            <p className="text-caption" style={{ color: "var(--fg-3)" }}>
              Will create <span className="mono font-medium">@{summarySlug}</span> in{" "}
              <span className="font-medium">{orgLabel}</span> on{" "}
              <span className="font-medium">{selectedClient.hostname ?? selectedClient.id}</span>
              {selectedClientOnline ? "" : " (offline — will start when it's back)"} using{" "}
              <span className="font-medium">{prettyRuntimeLabel(selectedRuntime)}</span>.
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {createMut.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HandleEditor({
  expanded,
  onToggle,
  name,
  onChange,
  onBlurCleanup,
  availability,
  error,
}: {
  expanded: boolean;
  onToggle: () => void;
  name: string;
  onChange: (next: string) => void;
  onBlurCleanup: () => void;
  availability: AvailabilityState;
  error?: string;
}) {
  const handlePreview = name ? `@${name}` : "@—";
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1 text-caption"
        style={{ color: "var(--fg-3)", background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
      >
        <span>
          Edit handle: <span className="mono">{handlePreview}</span>
        </span>
        <ChevronDown
          className="h-3 w-3"
          style={{ transition: "transform 160ms ease", transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
        />
      </button>
      {expanded && (
        <div className="space-y-1">
          <div className="flex items-stretch">
            <span
              aria-hidden
              className="inline-flex items-center px-2 font-mono text-body text-muted-foreground border border-r-0 border-input rounded-l-[var(--radius-input)] bg-muted/40"
            >
              @
            </span>
            <Input
              value={name}
              onChange={(e) => onChange(normalizeNameInput(e.target.value))}
              onBlur={onBlurCleanup}
              placeholder="my-dev-assistant"
              className="rounded-l-none font-mono"
              maxLength={AGENT_NAME_MAX_LENGTH}
              aria-invalid={error ? true : undefined}
            />
          </div>
          <p className="text-caption" style={{ color: "var(--fg-4)" }}>
            Used in @mentions and CLI commands. Lowercase letters, digits, hyphens, underscores. Permanent after
            creation.
          </p>
          {name && !error && availability.status !== "idle" && (
            <p
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
          {error && <p className="text-caption text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}

function ComputerSection({
  clients,
  selectedClientId,
  onSelectClient,
  cliCommand,
}: {
  clients: HubClient[];
  selectedClientId: string | null;
  onSelectClient: (id: string) => void;
  cliCommand: string | null;
}) {
  if (clients.length === 0) {
    return <EmptyComputer cliCommand={cliCommand} />;
  }

  if (clients.length === 1) {
    const client = clients[0];
    if (!client) return null;
    return <SingleComputer client={client} />;
  }

  // 2+ — picker
  const sorted = [...clients].sort((a, b) => {
    const aOnline = a.status === "connected" ? 0 : 1;
    const bOnline = b.status === "connected" ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });
  const selected = clients.find((c) => c.id === selectedClientId);
  const selectedOffline = selected && selected.status !== "connected";
  return (
    <div className="space-y-1">
      <fieldset className="space-y-1" style={{ margin: 0, padding: 0, border: 0 }}>
        <legend className="sr-only">Pick a computer</legend>
        {sorted.map((client) => {
          const picked = selectedClientId === client.id;
          const online = client.status === "connected";
          return (
            <label
              key={client.id}
              className="flex items-center"
              style={{
                gap: "var(--sp-2)",
                padding: "var(--sp-1_5) 0",
                cursor: "pointer",
                color: picked ? "var(--fg)" : "var(--fg-2)",
              }}
            >
              <input
                type="radio"
                name="new-agent-client"
                checked={picked}
                onChange={() => onSelectClient(client.id)}
                style={{ marginRight: "var(--sp-1)" }}
              />
              <span className="mono font-medium">{client.hostname ?? client.id.slice(0, 12)}</span>
              <span className="text-caption" style={{ color: "var(--fg-4)" }}>
                · {client.os ?? "unknown"} ·{" "}
                {online ? "online" : `offline · last seen ${relativeTime(client.lastSeenAt)}`}
              </span>
            </label>
          );
        })}
      </fieldset>
      {selectedOffline && (
        <p className="text-caption" style={{ color: "var(--fg-3)" }}>
          Will be created, but won't respond until this computer wakes up.
        </p>
      )}
    </div>
  );
}

function SingleComputer({ client }: { client: HubClient }) {
  const online = client.status === "connected";
  if (online) {
    return (
      <div
        className="inline-flex items-center text-body"
        style={{
          gap: "var(--sp-2)",
          padding: "var(--sp-1_5) var(--sp-2_5)",
          borderRadius: 999,
          background: "color-mix(in oklch, var(--accent) 10%, transparent)",
          color: "color-mix(in oklch, var(--accent) 26%, var(--fg))",
        }}
      >
        <Check className="h-3.5 w-3.5" />
        <span>
          <span className="mono font-semibold">{client.hostname ?? client.id.slice(0, 12)}</span> connected
        </span>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div
        className="inline-flex items-center text-body"
        style={{
          gap: "var(--sp-2)",
          padding: "var(--sp-1_5) var(--sp-2_5)",
          borderRadius: 999,
          background: "color-mix(in oklch, var(--state-warning) 10%, transparent)",
          color: "color-mix(in oklch, var(--state-warning) 30%, var(--fg))",
        }}
      >
        <span aria-hidden>⚠</span>
        <span>
          <span className="mono font-semibold">{client.hostname ?? client.id.slice(0, 12)}</span> offline · last seen{" "}
          {relativeTime(client.lastSeenAt)}
        </span>
      </div>
      <p className="text-caption" style={{ color: "var(--fg-3)" }}>
        Will be created, but won't respond until this computer wakes up.
      </p>
    </div>
  );
}

function EmptyComputer({ cliCommand }: { cliCommand: string | null }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (): Promise<void> => {
    if (!cliCommand) return;
    await navigator.clipboard.writeText(cliCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const preview = cliCommand
    ? cliCommand.length > 52
      ? `${cliCommand.slice(0, 52)}…`
      : cliCommand
    : "Generating token…";
  return (
    <div className="space-y-2">
      <p className="text-caption" style={{ color: "var(--fg-3)" }}>
        This agent needs a computer to do its work. Open Terminal on that computer and run:
      </p>
      <div className="flex" style={{ gap: "var(--sp-2)", alignItems: "stretch" }}>
        <pre
          className="mono text-label"
          title={cliCommand ?? undefined}
          style={{
            flex: 1,
            minHeight: 38,
            margin: 0,
            padding: "var(--sp-2_5) var(--sp-3)",
            background: "color-mix(in oklch, var(--bg-sunken) 42%, transparent)",
            border: "var(--hairline) solid color-mix(in oklch, var(--border-faint) 58%, transparent)",
            borderRadius: "var(--radius-input)",
            color: "var(--fg-2)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            minWidth: 0,
          }}
        >
          {preview}
        </pre>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCopy}
          disabled={!cliCommand}
          style={{ alignSelf: "stretch", height: "auto", minHeight: 38 }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {cliCommand && cliCommand.length > 52 && (
        <p className="text-caption" style={{ color: "var(--fg-4)" }}>
          Token shortened for display — use Copy to grab the full command.
        </p>
      )}
      <div
        className="flex items-center text-body"
        style={{
          gap: "var(--sp-2)",
          color: "color-mix(in oklch, var(--accent) 24%, var(--fg-3))",
        }}
      >
        <PulsingDot />
        <span>Waiting for your computer…</span>
      </div>
    </div>
  );
}

function RuntimeSection({
  hasClient,
  capabilitiesLoaded,
  capabilitiesError,
  runtimes,
  selected,
  onSelect,
  hostname,
}: {
  hasClient: boolean;
  capabilitiesLoaded: boolean;
  capabilitiesError: string | null;
  runtimes: RuntimeProvider[];
  selected: RuntimeProvider | null;
  onSelect: (next: RuntimeProvider) => void;
  hostname: string | null;
}) {
  if (!hasClient) {
    return (
      <p className="text-caption" style={{ color: "var(--fg-4)" }}>
        Pick a computer first.
      </p>
    );
  }
  if (!capabilitiesLoaded) {
    if (capabilitiesError) {
      return (
        <p className="text-caption" style={{ color: "var(--fg-3)" }}>
          Can't read what's installed on {hostname ?? "this computer"} right now. Reopen this dialog after the computer
          is back online.
        </p>
      );
    }
    return (
      <p className="text-caption" style={{ color: "var(--fg-4)" }}>
        Detecting installed runtimes…
      </p>
    );
  }
  if (runtimes.length === 0) {
    return (
      <p className="text-caption" style={{ color: "var(--fg-3)" }}>
        No runtime ready on {hostname ?? "this computer"}. Install Claude Code or Codex on the host, then reopen this
        dialog.
      </p>
    );
  }
  return (
    <fieldset className="flex" style={{ gap: "var(--sp-4)", flexWrap: "wrap", margin: 0, padding: 0, border: 0 }}>
      <legend className="sr-only">Runtime provider</legend>
      {runtimes.map((provider) => {
        const active = selected === provider;
        return (
          <label
            key={provider}
            className="inline-flex items-center text-body"
            style={{
              gap: "var(--sp-1_5)",
              padding: "var(--sp-1) 0",
              cursor: "pointer",
              color: active ? "color-mix(in oklch, var(--accent) 30%, var(--fg))" : "var(--fg)",
              fontWeight: active ? 600 : 400,
            }}
          >
            <input
              type="radio"
              name="new-agent-runtime"
              value={provider}
              checked={active}
              onChange={() => onSelect(provider)}
              className="sr-only"
            />
            <span
              aria-hidden="true"
              className="inline-flex items-center justify-center"
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                border: active ? "var(--hairline) solid var(--accent)" : "var(--hairline) solid var(--border-strong)",
                background: active ? "color-mix(in oklch, var(--accent) 8%, transparent)" : "transparent",
              }}
            >
              {active && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--accent)",
                  }}
                />
              )}
            </span>
            {prettyRuntimeLabel(provider)}
          </label>
        );
      })}
    </fieldset>
  );
}

function PulsingDot() {
  return (
    <span
      aria-hidden="true"
      style={{ position: "relative", display: "inline-block", width: 8, height: 8, flexShrink: 0 }}
    >
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "var(--accent)" }} />
      <span
        style={{
          position: "absolute",
          inset: -3,
          borderRadius: "50%",
          border: "var(--hairline) solid var(--accent)",
          animation: "ring-pulse 1.8s infinite",
          opacity: 0.55,
        }}
      />
    </span>
  );
}
