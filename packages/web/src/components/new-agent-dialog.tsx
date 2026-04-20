import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
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

export function NewAgentDialog({ open, onOpenChange, onCreated }: Props) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [templateKey, setTemplateKey] = useState<Template["key"]>("coding");
  const codingTemplate = TEMPLATES.find((t) => t.key === "coding");
  const [prompt, setPrompt] = useState(codingTemplate?.prompt ?? "");
  const [runtime, setRuntime] = useState<Runtime>("claude-code");

  useEffect(() => {
    if (open) {
      setName("");
      setNameDirty(false);
      setTemplateKey("coding");
      setPrompt(TEMPLATES.find((t) => t.key === "coding")?.prompt ?? "");
      setRuntime("claude-code");
    }
  }, [open]);

  const slug = slugify(name);

  const createMut = useMutation({
    mutationFn: async () => {
      const displayName = name.trim() || "Untitled assistant";
      const effectiveName = slug || undefined;
      const agent = await createAgent({
        name: effectiveName,
        type: "personal_assistant",
        displayName,
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

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createMut.mutate();
  }

  const canSubmit = name.trim().length > 0 && !createMut.isPending;

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
              {createMut.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
