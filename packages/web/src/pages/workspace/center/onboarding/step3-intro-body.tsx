import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getAgentConfig, updateAgentConfig } from "../../../../api/agent-config.js";
import { listManagedAgents } from "../../../../api/agents.js";
import { createAgentChat, sendChatMessage } from "../../../../api/chats.js";
import { type GithubRepo, listGithubRepos } from "../../../../api/github.js";
import { reportOnboardingEvent } from "../../../../api/onboarding-events.js";
import { getContextTreeSetting, putContextTreeSetting } from "../../../../api/org-settings.js";
import { useAuth } from "../../../../auth/auth-context.js";
import { Button } from "../../../../components/ui/button.js";
import { useToast } from "../../../../components/ui/toast.js";
import { readOnboardingAgentUuid } from "../../../../utils/onboarding-flags.js";
import { buildBindBootstrap, buildCreateBootstrap } from "./bootstrap-prose.js";
import { StepFrame, StepRailLine } from "./step-frame.js";

type TreeMode = "existing" | "new";

export function Step3IntroBody() {
  const navigate = useNavigate();
  const { dismissOnboarding, organizationId } = useAuth();
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [treeMode, setTreeMode] = useState<TreeMode | null>(null);
  const [existingTreeUrl, setExistingTreeUrl] = useState("");
  const [selectedRepoUrl, setSelectedRepoUrl] = useState<string | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);

  // Lazy-load the GitHub repo list once when Step 3 mounts. Plan B keeps
  // source picker here (not Step 2) so agent creation in Step 2 stays
  // independent of GitHub OAuth health — agent already exists by the time
  // this runs, so an OAuth hiccup only blocks Step 3, not the user's
  // entire onboarding.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listGithubRepos();
        if (cancelled) return;
        setRepos(list);
      } catch (err) {
        if (!cancelled) setReposError(err instanceof Error ? err.message : "Failed to list GitHub repositories");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Pre-fill from the org's existing `context_tree` binding when the
  // caller can read it. Today this only fires for **admins** —
  // `GET /orgs/:orgId/settings/:namespace` is admin-gated server-side, so
  // a non-admin invitee's call 403s and we silently fall through to the
  // empty toggle (same behaviour as before this change). The conservative
  // value here is for admins re-running onboarding.
  //
  // The proper invitee fix — either relaxing the GET to org members for
  // non-secret namespaces, or surfacing the binding through `/me`, plus
  // hiding the Bind/Create toggle entirely so an invitee cannot
  // accidentally spawn a duplicate tree — is deferred to Phase B, which
  // also introduces the `source_repos` namespace and lets Step 3
  // collapse/skip cleanly for invitees.
  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await getContextTreeSetting(organizationId);
        if (cancelled) return;
        if (settings.repo) {
          setExistingTreeUrl(settings.repo);
          setTreeMode((m) => m ?? "existing");
        }
      } catch {
        // Non-fatal — admins without the namespace bound (or non-admins
        // who can't read it) just see the empty toggle, same as before.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const trimmedTreeUrl = existingTreeUrl.trim();
  const isExistingUrlValid = (() => {
    if (treeMode !== "existing") return true;
    if (!trimmedTreeUrl) return false;
    try {
      const u = new URL(trimmedTreeUrl);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  })();

  const showSetupHiddenToast = useCallback(() => {
    addToast({
      title: "Setup hidden",
      description:
        "Resume any time in Settings → Setup. Your agent isn't bound to a source repo yet — add one in Agent settings when ready.",
      action: { label: "Open settings", onClick: () => navigate("/settings/setup") },
    });
  }, [addToast, navigate]);

  // "I'll do it later" — server dismiss + toast. Same recovery path as
  // clicking the stepper `✕` (single source of truth, server-side flag).
  // The toast also nudges the user about the unbound source repo (Plan B
  // moves source picker into Step 3, so skipping leaves the agent without
  // an explicit code repo binding).
  const handleLater = useCallback(() => {
    void reportOnboardingEvent("tree_intro_dismissed");
    void dismissOnboarding();
    showSetupHiddenToast();
  }, [dismissOnboarding, showSetupHiddenToast]);

  const handleContinue = useCallback(async () => {
    if (!selectedRepoUrl) return;
    if (!treeMode) return;
    if (treeMode === "existing" && !isExistingUrlValid) return;
    setError(null);
    setBusy(true);
    try {
      // Resolve the onboarding agent in priority order:
      //   1. The UUID stashed at Step 2 success.
      //   2. Most recently created managed agent (UUID v7 sort desc).
      //   3. Any non-human managed agent.
      const stashedUuid = readOnboardingAgentUuid();
      const managed = await listManagedAgents();
      const nonHuman = managed.filter((a) => a.type !== "human");
      const agent =
        (stashedUuid ? managed.find((a) => a.uuid === stashedUuid) : undefined) ??
        nonHuman.slice().sort((a, b) => b.uuid.localeCompare(a.uuid))[0] ??
        managed[0];
      if (!agent) {
        throw new Error("No agent available to chat with — finish Step 2 first.");
      }

      // Plan B: bind the source repo to the agent NOW (before chat starts)
      // so `prepareGitWorktrees` can clone it on session start. Step 2
      // creates an unbound agent; Step 3 is where the binding happens.
      // Sequential await — chat creation below races the runtime config
      // PATCH otherwise.
      const cfg = await getAgentConfig(agent.uuid);
      await updateAgentConfig(agent.uuid, {
        expectedVersion: cfg.version,
        payload: { gitRepos: [{ url: selectedRepoUrl }] },
      });

      // Path A: persist the existing tree URL to the org NOW via the
      // generic per-org settings surface (`context_tree` namespace). Agent
      // will still write `.first-tree/local-tree.json` to the source repo
      // via PR (proper binding), but Hub already has the URL cached so
      // future agents in this org can find it without re-reading source
      // files.
      if (treeMode === "existing" && organizationId) {
        try {
          await putContextTreeSetting(organizationId, { repo: trimmedTreeUrl });
        } catch (err) {
          // Non-fatal — the agent will still bind in chat. Log + continue.
          // eslint-disable-next-line no-console
          console.warn("Step 3: PUT context_tree settings failed; agent will still proceed", err);
        }
      }

      const chat = await createAgentChat(agent.uuid);
      const bootstrap =
        treeMode === "existing"
          ? buildBindBootstrap(selectedRepoUrl, trimmedTreeUrl)
          : buildCreateBootstrap(selectedRepoUrl);
      try {
        await sendChatMessage(chat.id, bootstrap);
      } catch {
        // intentionally non-fatal — user lands in the empty chat
      }
      void reportOnboardingEvent("tree_chat_started", {
        agentUuid: agent.uuid,
        chatId: chat.id,
        treeMode,
      });
      // Step 3 launched — auto-dismiss the stepper so it doesn't linger
      // above the user's first chat. No toast here (mid-success path).
      void dismissOnboarding();
      navigate(`/?c=${encodeURIComponent(chat.id)}`, { replace: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the tree-init chat");
      setBusy(false);
    }
  }, [selectedRepoUrl, treeMode, isExistingUrlValid, trimmedTreeUrl, organizationId, navigate, dismissOnboarding]);

  const canContinue = !!selectedRepoUrl && treeMode !== null && !busy && (treeMode === "new" || isExistingUrlValid);

  const treeModeChosen = !!treeMode && (treeMode === "new" || isExistingUrlValid);

  return (
    <>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)", maxWidth: 720 }}>
        Build the <span style={{ color: "var(--fg-2)" }}>context-tree</span> — your team&apos;s shared knowledge that
        grows with your code.
      </p>

      <div style={{ marginTop: "var(--sp-5)", position: "relative" }}>
        <StepRailLine />

        <StepFrame number="01" state={selectedRepoUrl ? "complete" : "active"}>
          <RepoPickerSection
            disabled={busy}
            repos={repos}
            error={reposError}
            selectedRepoUrl={selectedRepoUrl}
            onSelect={setSelectedRepoUrl}
          />
        </StepFrame>

        <StepFrame number="02" state={treeModeChosen ? "complete" : selectedRepoUrl ? "active" : "idle"}>
          <h2
            className="text-subtitle font-semibold"
            style={{
              margin: 0,
              color: selectedRepoUrl ? "var(--fg)" : "var(--fg-4)",
              fontWeight: selectedRepoUrl ? 600 : 500,
            }}
          >
            Bind or create the tree
          </h2>
          {selectedRepoUrl ? (
            <div style={{ marginTop: "var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
              {/* Segmented toggle — two-option choice as a single inline
                control instead of stacked radio cards. Real <input
                type="radio"> sit under the labels for screen readers; the
                visible "buttons" are styled labels. The conditional URL
                input below grows in only when "Bind to existing" is the
                active side, so the layout doesn't reserve dead space for
                the "Create new" path. */}
              <fieldset
                aria-label="Bind or create the tree"
                disabled={busy}
                style={{
                  display: "inline-flex",
                  alignSelf: "flex-start",
                  padding: "var(--sp-0_5)",
                  margin: 0,
                  background: "var(--surface-2)",
                  border: "var(--hairline) solid var(--border-faint)",
                  borderRadius: "var(--radius-input)",
                  gap: "var(--sp-0_5)",
                }}
              >
                <legend className="sr-only">Bind or create the tree</legend>
                {(
                  [
                    { value: "existing", label: "Bind to an existing tree" },
                    { value: "new", label: "Create a new tree" },
                  ] as const
                ).map((opt) => {
                  const active = treeMode === opt.value;
                  return (
                    <label
                      key={opt.value}
                      className="text-body transition-colors"
                      style={{
                        padding: "var(--sp-1_5) var(--sp-3)",
                        background: active ? "var(--bg)" : "transparent",
                        borderRadius: "calc(var(--radius-input) - var(--sp-0_5))",
                        color: active ? "var(--fg)" : "var(--fg-3)",
                        fontWeight: active ? 600 : 400,
                        boxShadow: active ? "var(--shadow-sm)" : "none",
                        cursor: busy ? "not-allowed" : "pointer",
                        userSelect: "none",
                      }}
                    >
                      <input
                        type="radio"
                        name="tree-mode"
                        value={opt.value}
                        checked={active}
                        onChange={() => setTreeMode(opt.value)}
                        className="sr-only"
                      />
                      {opt.label}
                    </label>
                  );
                })}
              </fieldset>

              {treeMode === "existing" ? (
                <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
                  <label htmlFor="onboarding-existing-tree-url" className="text-label" style={{ color: "var(--fg-3)" }}>
                    Tree GitHub URL
                  </label>
                  <input
                    id="onboarding-existing-tree-url"
                    type="url"
                    value={existingTreeUrl}
                    onChange={(e) => setExistingTreeUrl(e.target.value)}
                    placeholder="https://github.com/your-org/your-tree"
                    disabled={busy}
                    className="text-body"
                    style={{
                      padding: "var(--sp-2) var(--sp-3)",
                      background: "var(--bg)",
                      border: "var(--hairline) solid var(--border)",
                      borderRadius: "var(--radius-input)",
                      color: "var(--fg)",
                      outline: "none",
                      fontFamily: "var(--font-mono)",
                    }}
                  />
                </div>
              ) : null}

              {treeMode === "new" ? (
                <p className="text-label" style={{ margin: 0, color: "var(--fg-3)" }}>
                  Your agent will scaffold a new GitHub repo for the tree and bind it to your source repo.
                </p>
              ) : null}
            </div>
          ) : null}
        </StepFrame>

        <StepFrame number="03" state={treeModeChosen ? "active" : "idle"}>
          <h2
            className="text-subtitle font-semibold"
            style={{
              margin: 0,
              color: treeModeChosen ? "var(--fg)" : "var(--fg-4)",
              fontWeight: treeModeChosen ? 600 : 500,
            }}
          >
            Let your agent build it
          </h2>
          {treeModeChosen ? (
            <>
              <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
                It&apos;ll install the skill, set up the tree, and open a PR back to your source repo.
              </p>

              {error ? (
                <div
                  className="text-body"
                  style={{
                    marginTop: "var(--sp-3)",
                    padding: "var(--sp-2_5) var(--sp-3)",
                    background: "color-mix(in oklch, var(--state-error) 12%, transparent)",
                    border: "var(--hairline) solid color-mix(in oklch, var(--state-error) 28%, transparent)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--state-error)",
                  }}
                >
                  {error}
                </div>
              ) : null}

              <div className="flex" style={{ marginTop: "var(--sp-3)", gap: "var(--sp-2)" }}>
                <Button type="button" disabled={!canContinue} onClick={() => void handleContinue()}>
                  {busy ? "Starting…" : "Continue"}
                </Button>
                <Button type="button" variant="outline" onClick={handleLater} disabled={busy}>
                  I&apos;ll do it later
                </Button>
              </div>
            </>
          ) : null}
        </StepFrame>
      </div>
    </>
  );
}

function RepoPickerSection({
  disabled,
  repos,
  error,
  selectedRepoUrl,
  onSelect,
}: {
  disabled: boolean;
  repos: GithubRepo[] | null;
  error: string | null;
  selectedRepoUrl: string | null;
  onSelect: (url: string | null) => void;
}) {
  const heading = (
    <h2
      className="text-subtitle font-semibold"
      style={{
        color: disabled ? "var(--fg-4)" : "var(--fg)",
        fontWeight: disabled ? 500 : 600,
      }}
    >
      Pick the source repo
    </h2>
  );

  if (disabled) {
    return <div>{heading}</div>;
  }

  if (error) {
    return (
      <div style={{ animation: "subtle-fade 200ms ease-out" }}>
        {heading}
        <p className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-2)" }}>
          {error}. Reconnect your GitHub account to grant repo access.
        </p>
        <div style={{ marginTop: "var(--sp-2)" }}>
          <Button type="button" variant="outline" size="sm" asChild>
            <a href="/api/v1/auth/github/start?next=/">Reconnect GitHub</a>
          </Button>
        </div>
      </div>
    );
  }

  if (repos === null) {
    return (
      <div style={{ animation: "subtle-fade 200ms ease-out" }}>
        {heading}
        <p className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-2)" }}>
          Loading your GitHub repositories…
        </p>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div style={{ animation: "subtle-fade 200ms ease-out" }}>
        {heading}
        <p className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-2)" }}>
          No repositories found on your GitHub account. Create one and refresh this page.
        </p>
      </div>
    );
  }

  return (
    <div style={{ animation: "subtle-fade 200ms ease-out" }}>
      {heading}
      <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
        The code your tree will organize knowledge about.
      </p>
      <RepoPickerPopover repos={repos} selectedRepoUrl={selectedRepoUrl} onSelect={onSelect} />
    </div>
  );
}

function RepoPickerPopover({
  repos,
  selectedRepoUrl,
  onSelect,
}: {
  repos: GithubRepo[];
  selectedRepoUrl: string | null;
  onSelect: (url: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Click-outside + Escape, mirroring user-menu.tsx's popover pattern.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Group by owner — `<owner>/<repo>` is GitHub's canonical fullName, so
  // splitting on the first `/` is reliable. Owners sorted alphabetically;
  // repos within an owner keep server-returned order (most-recently-pushed
  // first per `pushedAt desc`).
  const groups = useMemo(() => {
    const byOwner = new Map<string, GithubRepo[]>();
    for (const r of repos) {
      const owner = r.fullName.split("/")[0] ?? "";
      const list = byOwner.get(owner);
      if (list) list.push(r);
      else byOwner.set(owner, [r]);
    }
    return [...byOwner.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [repos]);

  const selectedRepo = repos.find((r) => r.cloneUrl === selectedRepoUrl) ?? null;

  return (
    <div ref={ref} className="relative" style={{ marginTop: "var(--sp-2)" }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="text-body"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--sp-2)",
          padding: "var(--sp-2) var(--sp-3)",
          background: "var(--bg)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-input)",
          color: selectedRepo ? "var(--fg)" : "var(--fg-3)",
          outline: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span className="truncate" style={{ minWidth: 0, flex: 1 }}>
          {selectedRepo ? selectedRepo.fullName : "Select a repository…"}
        </span>
        <ChevronDown
          className="h-4 w-4"
          style={{
            color: "var(--fg-3)",
            transition: "transform 120ms ease",
            transform: open ? "rotate(180deg)" : "none",
            flexShrink: 0,
          }}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="GitHub repository"
          className="absolute z-30 rounded-md border bg-popover shadow-md"
          style={{
            top: "calc(100% + var(--sp-1))",
            left: 0,
            right: 0,
            maxHeight: "min(56vh, 30rem)",
            overflowY: "auto",
            padding: "var(--sp-1) 0",
          }}
        >
          {groups.map(([owner, ownerRepos], groupIdx) => (
            <div key={owner}>
              {groupIdx > 0 && (
                <div
                  aria-hidden="true"
                  style={{
                    margin: "var(--sp-1) 0",
                    height: "var(--hairline)",
                    background: "var(--border-faint)",
                  }}
                />
              )}
              <div
                className="text-eyebrow"
                style={{
                  padding: "var(--sp-1) var(--sp-3)",
                  color: "var(--fg-3)",
                }}
              >
                {owner}
              </div>
              {ownerRepos.map((repo) => {
                const selected = repo.cloneUrl === selectedRepoUrl;
                const repoName = repo.fullName.slice(owner.length + 1);
                return (
                  <button
                    key={repo.cloneUrl}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onSelect(repo.cloneUrl);
                      setOpen(false);
                    }}
                    className="text-body transition-colors w-full"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--sp-2)",
                      padding: "var(--sp-1_5) var(--sp-3)",
                      background: selected ? "var(--accent-bg)" : "transparent",
                      color: selected ? "var(--accent)" : "var(--fg)",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                    onMouseEnter={(e) => {
                      if (!selected) e.currentTarget.style.background = "var(--surface-1)";
                    }}
                    onMouseLeave={(e) => {
                      if (!selected) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span style={{ width: 14, display: "inline-flex", flexShrink: 0 }}>
                      {selected ? <Check className="h-3.5 w-3.5" /> : null}
                    </span>
                    <span className="truncate" style={{ minWidth: 0, flex: 1 }}>
                      {repoName}
                    </span>
                    {repo.private && (
                      <span
                        className="mono uppercase text-caption"
                        style={{
                          padding: "var(--hairline) var(--sp-1_75)",
                          borderRadius: "var(--radius-chip)",
                          color: "var(--fg-3)",
                          border: "var(--hairline) solid var(--border)",
                          background: "var(--bg-sunken)",
                          flexShrink: 0,
                        }}
                      >
                        private
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
