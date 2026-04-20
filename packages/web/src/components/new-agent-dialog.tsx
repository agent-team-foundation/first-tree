import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { type HubClient, listClients } from "../api/activity.js";
import { getAgentConfig, updateAgentConfig } from "../api/agent-config.js";
import { createAgent } from "../api/agents.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

/**
 * Simplified agent creation dialog for the onboarding flow (M5).
 *
 * Hidden defaults (see hub-onboarding-mvp proposal §2.2):
 *   - type = "personal_assistant" (Team agents go through a different path)
 *   - manager = current user (admin-assisted creation uses a separate UI)
 *   - displayName = Name, slug derived automatically
 *   - delegateMention, visibility, clientId = not surfaced
 *
 * Runtime choice:
 *   - "claude-code" — agent binds to the user's computer on first WS connect.
 *     After create, we hand the dialog off to `LastStepModal` for the
 *     `curl | sh … --token` command + polling.
 *   - "kael" — agent runs in the hub's managed runtime. Disabled for
 *     Pre-MVP until adapter_configs provisioning lands (#86).
 */

type Runtime = "claude-code" | "kael";

type Template = {
  key: "writing" | "coding" | "research" | "custom";
  label: string;
  emoji: string;
  prompt: string;
};

const TEMPLATES: Template[] = [
  {
    key: "writing",
    label: "Writing",
    emoji: "📝",
    prompt:
      "You are a writing assistant. Help the user draft, edit, and polish text — emails, docs, posts, proposals. Match the user's tone, ask for the target audience when it's unclear, and suggest tighter phrasings without being precious about it.",
  },
  {
    key: "coding",
    label: "Coding",
    emoji: "💻",
    prompt:
      "You are a coding assistant, skilled at debugging, refactoring, and writing clean code. Prefer minimal, targeted diffs. Trace actual behavior before changing it. State assumptions explicitly. When the user reports a bug, investigate the root cause before suggesting a fix.",
  },
  {
    key: "research",
    label: "Research",
    emoji: "🔬",
    prompt:
      "You are a research assistant. Help the user find, compare, and synthesize information. Cite sources, flag uncertainty, surface trade-offs, and summarize long documents into the three things the user actually needs to decide.",
  },
  { key: "custom", label: "Custom", emoji: "✏️", prompt: "" },
];

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
   * Called after the agent row + prompt config are saved. Receives the new
   * agent and the chosen runtime so the caller can decide what to do next
   * (e.g. open the Last-step modal for Claude Code, or redirect to the
   * Workspace for Kael).
   */
  onCreated: (agent: Agent, runtime: Runtime) => void;
};

type Step = "form" | "pick-computer";

export function NewAgentDialog({ open, onOpenChange, onCreated }: Props) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [templateKey, setTemplateKey] = useState<Template["key"]>("coding");
  const codingTemplate = TEMPLATES.find((t) => t.key === "coding");
  const [prompt, setPrompt] = useState(codingTemplate?.prompt ?? "");
  const [runtime, setRuntime] = useState<Runtime>("claude-code");

  // Step 2 state — shown only when the user has multiple connected computers
  // and we need them to pick one for the new agent to pin to.
  const [step, setStep] = useState<Step>("form");
  const [candidateClients, setCandidateClients] = useState<HubClient[]>([]);
  const [pickedClientId, setPickedClientId] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setNameDirty(false);
      setTemplateKey("coding");
      setPrompt(TEMPLATES.find((t) => t.key === "coding")?.prompt ?? "");
      setRuntime("claude-code");
      setStep("form");
      setCandidateClients([]);
      setPickedClientId(null);
      setProbing(false);
    }
  }, [open]);

  const slug = slugify(name);

  const createMut = useMutation({
    mutationFn: async (opts: { clientId?: string }) => {
      const displayName = name.trim() || "Untitled assistant";
      const effectiveName = slug || undefined;
      const agent = await createAgent({
        name: effectiveName,
        type: "personal_assistant",
        displayName,
        // When a clientId is provided (scenario B), the server pins the agent
        // on create and emits an `agent:pinned` WebSocket frame to the
        // matching client; its runtime then writes the local agent.yaml and
        // opens the agent WS on its own. The caller can skip the Last-step
        // modal and jump straight to the Workspace.
        clientId: opts.clientId,
      });
      // Seed the prompt — fetch current config to grab expectedVersion, then PATCH.
      if (prompt.trim()) {
        try {
          const current = await getAgentConfig(agent.uuid);
          await updateAgentConfig(agent.uuid, {
            expectedVersion: current.version,
            payload: { prompt: { append: prompt.trim() } },
          });
        } catch {
          // Non-fatal — the agent exists, the user can edit the prompt later.
        }
      }
      return agent;
    },
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      onCreated(agent, runtime);
    },
  });

  function selectTemplate(t: Template) {
    setTemplateKey(t.key);
    // Only overwrite the prompt when it still matches the previous template,
    // or when picking Custom (which is meant to start blank).
    const previous = TEMPLATES.find((x) => x.key === templateKey);
    if (!prompt.trim() || prompt === previous?.prompt || t.key === "custom") {
      setPrompt(t.prompt);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
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
            <p className="text-sm text-muted-foreground">
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
                      <div className="text-sm font-medium truncate">{client.hostname ?? client.id}</div>
                      <div className="text-xs text-muted-foreground">
                        {client.os ?? "unknown OS"} · last seen {new Date(client.lastSeenAt).toLocaleString()}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            {createMut.error instanceof Error && (
              <div className="text-sm text-destructive">{createMut.error.message}</div>
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
                setName(e.target.value);
                setNameDirty(true);
              }}
              placeholder="My Dev Assistant"
              autoFocus
              maxLength={80}
            />
            {nameDirty && slug && (
              <p className="text-xs text-muted-foreground">
                ID on hub: <span className="font-mono">{slug}</span>
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>What it does</Label>
            <div className="flex flex-wrap gap-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => selectTemplate(t)}
                  className={
                    templateKey === t.key
                      ? "inline-flex items-center gap-1.5 rounded-full border border-primary bg-primary/10 px-3 py-1 text-sm"
                      : "inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm hover:bg-accent/50 transition-colors"
                  }
                >
                  <span>{t.emoji}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
            <textarea
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                // Switching to Custom the moment the user edits a template.
                if (templateKey !== "custom") setTemplateKey("custom");
              }}
              placeholder="You are a coding assistant, skilled at debugging and refactoring…"
              rows={5}
              maxLength={8000}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
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
                  <div className="text-sm font-medium">Claude Code</div>
                  <div className="text-xs text-muted-foreground">
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
                  <div className="text-sm font-medium">
                    Kael <span className="ml-1 text-xs font-normal text-muted-foreground">— coming soon</span>
                  </div>
                  <div className="text-xs text-muted-foreground">Ready to go, runs in the cloud.</div>
                </div>
              </label>
            </div>
          </div>

          {createMut.error instanceof Error && (
            <div className="text-sm text-destructive">{createMut.error.message}</div>
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
