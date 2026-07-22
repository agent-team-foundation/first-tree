import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Copy,
  Lock,
  ShieldCheck,
  Terminal,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { FirstTreeLogo } from "../components/first-tree-logo.js";
import { Button } from "../components/ui/button.js";
import { useCopyFeedback } from "../lib/use-copy-feedback.js";
import { cn } from "../lib/utils.js";
import {
  type ContextTreeSetupPreviewRole,
  contextTreeSetupPreviewModel,
  normalizeContextTreeSetupPreviewQuery,
} from "./context-tree-setup-preview-model.js";

const HANDOFF_COPY = {
  admin: {
    status: "Gandy's team is ready",
    meta: "Created automatically · You are Admin",
    intro:
      "Paste this once into Claude Code or Codex. First Tree will detect your environment and guide the rest of setup there.",
    copyLabel: "Copy setup prompt",
    detail:
      "Your coding agent initializes and binds the Tree first, then opens GitHub to install or connect the App and grant the exact Tree repository. Only automatic Review creates a reviewer Agent. The final step is your team invite link.",
    response:
      "I detected this environment. I'll initialize the Tree here and ask for browser consent only when needed.",
  },
  member: {
    status: "You joined Gandy's team",
    meta: "Member · Shared setup is ready",
    intro:
      "Paste this once into Claude Code or Codex. First Tree will detect your environment and connect it to your team's shared context.",
    copyLabel: "Copy connection prompt",
    detail:
      "Your coding agent installs the staging First Tree bundle and verifies an exact read of the Team Tree as shared.",
    response: "First Tree detected this environment. Connecting to Gandy's team and checking an exact Tree read.",
  },
} as const;

export function ContextTreeSetupPreviewPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const query = useMemo(() => normalizeContextTreeSetupPreviewQuery(location.search), [location.search]);
  const [fixtureStates, setFixtureStates] = useState<
    Record<ContextTreeSetupPreviewRole, { version: number; expired: boolean }>
  >(() => ({
    admin: { version: 0, expired: query.expired },
    member: { version: 0, expired: query.expired },
  }));

  useEffect(() => {
    if (!query.changed) return;
    void navigate({ pathname: location.pathname, search: query.search }, { replace: true });
  }, [location.pathname, navigate, query.changed, query.search]);

  useEffect(() => {
    setFixtureStates((current) => {
      if (current[query.role].expired === query.expired) return current;
      return {
        ...current,
        [query.role]: { ...current[query.role], expired: query.expired },
      };
    });
  }, [query.expired, query.role]);

  const clearExpired = (): void => {
    const params = new URLSearchParams(query.search);
    params.delete("code");
    void navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  };

  const regenerate = (): void => {
    setFixtureStates((current) => ({
      ...current,
      [query.role]: {
        version: current[query.role].version + 1,
        expired: false,
      },
    }));
    clearExpired();
  };

  return (
    <div className="min-h-screen bg-background text-foreground" data-context-tree-setup-preview={query.role}>
      <PreviewHeader role={query.role} controls={query.controls} fixtureStates={fixtureStates} />
      <HandoffPage
        key={query.role}
        role={query.role}
        version={fixtureStates[query.role].version}
        expired={fixtureStates[query.role].expired}
        onRegenerate={regenerate}
      />
    </div>
  );
}

function PreviewHeader({
  role,
  controls,
  fixtureStates,
}: {
  role: ContextTreeSetupPreviewRole;
  controls: boolean;
  fixtureStates: Record<ContextTreeSetupPreviewRole, { version: number; expired: boolean }>;
}) {
  return (
    <header className="border-b border-border-faint bg-background">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-10">
        <div className="flex min-w-0 items-center gap-3 sm:gap-5">
          <Link to="/" className="flex shrink-0 items-center gap-2 text-foreground" aria-label="First Tree workspace">
            <FirstTreeLogo className="h-5 w-auto text-brand" />
            <span className="hidden text-title font-semibold sm:inline">First Tree</span>
          </Link>
          <span className="h-7 border-l border-border-faint" aria-hidden="true" />
          <div className="flex min-w-0 items-center gap-2 text-body font-medium">
            {role === "member" ? <Users className="h-4 w-4 shrink-0 text-fg-3" aria-hidden="true" /> : null}
            <span className="truncate">Gandy's team</span>
          </div>
          <span className="rounded-[var(--radius-chip)] bg-bg-sunken px-2 py-1 text-eyebrow uppercase text-fg-3">
            Preview
          </span>
        </div>
        <div className="flex items-center gap-3">
          {controls ? (
            <nav aria-label="Context Tree setup preview role" className="hidden items-center gap-1 sm:flex">
              <RoleLink previewRole="admin" activeRole={role} expired={fixtureStates.admin.expired} />
              <RoleLink previewRole="member" activeRole={role} expired={fixtureStates.member.expired} />
            </nav>
          ) : null}
          <a href="#preview-help" className="hidden text-body text-fg-2 hover:text-foreground sm:inline">
            Help
          </a>
          <span
            role="img"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-full)] bg-bg-sunken text-label font-semibold"
            aria-label={role === "admin" ? "Gandy, Admin preview" : "Jamie, Member preview"}
          >
            {role === "admin" ? "GG" : "J"}
          </span>
        </div>
      </div>
      {controls ? (
        <nav
          aria-label="Context Tree setup preview role on narrow screens"
          className="flex items-center justify-center gap-1 border-t border-border-faint px-4 py-2 sm:hidden"
        >
          <RoleLink previewRole="admin" activeRole={role} expired={fixtureStates.admin.expired} />
          <RoleLink previewRole="member" activeRole={role} expired={fixtureStates.member.expired} />
        </nav>
      ) : null}
    </header>
  );
}

function RoleLink({
  previewRole,
  activeRole,
  expired,
}: {
  previewRole: ContextTreeSetupPreviewRole;
  activeRole: ContextTreeSetupPreviewRole;
  expired: boolean;
}) {
  const params = new URLSearchParams({ role: previewRole, controls: "1" });
  if (expired) params.set("code", "expired");
  return (
    <Link
      to={{ pathname: "/preview/context-tree-setup", search: params.toString() }}
      aria-current={previewRole === activeRole ? "page" : undefined}
      className={cn(
        "rounded-[var(--radius-input)] px-3 py-2 text-label font-medium",
        previewRole === activeRole
          ? "bg-primary text-primary-foreground"
          : "text-fg-2 hover:bg-bg-hover hover:text-foreground",
      )}
    >
      {previewRole === "admin" ? "Admin" : "Member"}
    </Link>
  );
}

function HandoffPage({
  role,
  version,
  expired,
  onRegenerate,
}: {
  role: ContextTreeSetupPreviewRole;
  version: number;
  expired: boolean;
  onRegenerate: () => void;
}) {
  const copy = HANDOFF_COPY[role];
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfterRegenerationRef = useRef(false);
  const terminalRef = useRef<HTMLPreElement>(null);
  const { status: copyStatus, copy: copyPrompt, reset: resetCopy } = useCopyFeedback();
  const [showCommand, setShowCommand] = useState(false);
  const [showMemberHelp, setShowMemberHelp] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Preview fixture · simulated expiry 9:42");
  const model = useMemo(() => contextTreeSetupPreviewModel(role, version), [role, version]);

  useEffect(() => {
    if (copyStatus === "copied") {
      setStatusMessage("Preview prompt copied · fixture login will not complete");
    }
    if (copyStatus === "failed") {
      setStatusMessage("Copy failed. The terminal fallback is open for manual copy.");
      setShowCommand(true);
    }
  }, [copyStatus]);

  useEffect(() => {
    if (copyStatus === "failed" && showCommand) terminalRef.current?.focus();
  }, [copyStatus, showCommand]);

  useEffect(() => {
    if (!focusAfterRegenerationRef.current || expired) return;
    copyButtonRef.current?.focus();
    focusAfterRegenerationRef.current = false;
  }, [expired, version]);

  const regenerate = (): void => {
    setStatusMessage("New preview fixture generated · simulated expiry 9:42");
    resetCopy();
    focusAfterRegenerationRef.current = true;
    onRegenerate();
  };

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
      <div className="mb-8 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2 text-success">
          <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          <strong className="text-title">{copy.status}</strong>
        </div>
        <span className="text-body text-fg-2">{copy.meta}</span>
      </div>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] xl:gap-12">
        <section className="min-w-0" aria-labelledby="handoff-title">
          <h1 id="handoff-title" className="text-title font-semibold text-foreground">
            Continue in your coding agent
          </h1>
          <p className="mt-3 max-w-2xl text-body text-fg-2">{copy.intro}</p>

          <div className="mt-5 rounded-[var(--radius-panel)] border border-border bg-bg-sunken p-4 sm:p-5">
            <p className="mb-3 text-label font-semibold text-error">Preview — fixture codes do not authenticate</p>
            <pre className="mono overflow-x-auto whitespace-pre-wrap text-label text-foreground">
              <code data-testid="setup-prompt">{model.prompt}</code>
            </pre>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              ref={copyButtonRef}
              type="button"
              variant="cta"
              size="lg"
              disabled={expired}
              onClick={() => void copyPrompt(model.prompt)}
            >
              {copyStatus === "copied" ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              {expired
                ? "Fixture expired"
                : copyStatus === "copied"
                  ? "Copied"
                  : copyStatus === "failed"
                    ? "Copy failed"
                    : copy.copyLabel}
            </Button>
            {expired ? (
              <Button type="button" variant="default" onClick={regenerate}>
                Generate new fixture
              </Button>
            ) : null}
            <span
              className={cn("text-label", expired || copyStatus === "failed" ? "text-error" : "text-fg-3")}
              role="status"
              aria-live="polite"
            >
              {expired ? "Generate a new fixture to continue preview." : statusMessage}
            </span>
          </div>

          <ul
            className="mt-5 flex list-none flex-wrap gap-x-5 gap-y-2 text-label text-fg-3"
            aria-label="Bootstrap results"
          >
            <li className="inline-flex items-center gap-2">
              <Check className="h-4 w-4 text-success" aria-hidden="true" />
              {role === "admin" ? "Installs First Tree locally" : "Installs First Tree and signs you in"}
            </li>
            <li className="inline-flex items-center gap-2">
              <CircleHelp className="h-4 w-4" aria-hidden="true" />
              Connects this computer when supported
            </li>
            <li className="inline-flex items-center gap-2">
              <CircleHelp className="h-4 w-4" aria-hidden="true" />
              Starts the daemon when available
            </li>
          </ul>
          <p className="mt-3 max-w-3xl text-label text-fg-3">
            Computer registration and daemon startup are best effort. If either needs attention, it does not block
            {role === "admin" ? " Tree setup" : " your Tree access"}; this bootstrap does not create a First Tree Agent.
          </p>

          <Button
            type="button"
            variant="link"
            disabled={expired}
            aria-expanded={showCommand}
            aria-controls={`${role}-terminal-command`}
            onClick={() => setShowCommand((current) => !current)}
            className="mt-4 h-auto p-0"
          >
            <Terminal className="h-4 w-4" aria-hidden="true" />
            Prefer a terminal command?
            <ChevronDown
              className={cn("h-4 w-4 transition-transform", showCommand && "rotate-180")}
              aria-hidden="true"
            />
          </Button>
          {showCommand ? (
            <pre
              ref={terminalRef}
              id={`${role}-terminal-command`}
              data-testid="terminal-bootstrap-command"
              tabIndex={-1}
              className="mono mt-3 overflow-x-auto whitespace-pre rounded-[var(--radius-input)] border border-border-faint bg-bg-sunken p-4 text-label text-foreground focus-visible:outline-none focus-visible:border-ring"
            >
              <code>{model.command}</code>
            </pre>
          ) : null}

          <div id="preview-help" className="mt-7 border-t border-border-faint pt-6">
            <p className="max-w-3xl text-body text-fg-2">{copy.detail}</p>
            {role === "admin" ? (
              <p className="mt-3 flex items-start gap-2 text-label text-fg-3">
                <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                Computer reuse is optional. Only a Local Reviewer Host needs to stay online.
              </p>
            ) : (
              <p className="mt-3 flex items-start gap-2 text-label text-fg-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                Shared Team setup is already complete. This handoff only installs, signs in, and verifies your exact
                Tree read.
              </p>
            )}
            {role === "member" ? (
              <>
                <Button
                  type="button"
                  variant="link"
                  aria-expanded={showMemberHelp}
                  aria-controls="member-repository-help"
                  onClick={() => setShowMemberHelp((current) => !current)}
                  className="mt-4 h-auto justify-start whitespace-normal p-0 text-left"
                >
                  <CircleHelp className="h-4 w-4" aria-hidden="true" />
                  Can't read the Tree? Ask an admin for repository access.
                </Button>
                {showMemberHelp ? (
                  <p
                    id="member-repository-help"
                    className="mt-3 rounded-[var(--radius-input)] border border-border-faint bg-bg-sunken p-3 text-label text-fg-2"
                  >
                    Send this screen to a Team admin. They can restore your Context Tree repository access, then you can
                    paste the same prompt again.
                  </p>
                ) : null}
              </>
            ) : null}
            <p className="mt-5 flex items-center gap-2 text-label text-fg-3">
              <Lock className="h-4 w-4" aria-hidden="true" />
              Nothing runs until you paste the prompt.
            </p>
          </div>
        </section>

        <CodingAgentPreview role={role} prompt={model.prompt} response={copy.response} />
      </div>
    </main>
  );
}

function CodingAgentPreview({
  role,
  prompt,
  response,
}: {
  role: ContextTreeSetupPreviewRole;
  prompt: string;
  response: string;
}) {
  return (
    <aside className="min-w-0 xl:border-l xl:border-border-faint xl:pl-10" aria-label="Coding agent handoff preview">
      <h2 className="text-subtitle font-semibold text-foreground">Your coding agent</h2>
      <p className="mt-1 text-body text-fg-2">Claude Code · Codex</p>
      <div className="surface-raised mt-4 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border-faint px-4 py-3" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-[var(--radius-full)] bg-state-error" />
          <span className="h-2.5 w-2.5 rounded-[var(--radius-full)] bg-state-needs-you" />
          <span className="h-2.5 w-2.5 rounded-[var(--radius-full)] bg-state-working" />
        </div>
        <div className="space-y-5 p-4 sm:p-5">
          <div className="flex items-center gap-3 border-b border-border-faint pb-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-input)] border border-border bg-bg-sunken">
              <Bot className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <strong className="text-subtitle">Coding agent</strong>
              <p className="text-label text-fg-3">How can I help you today?</p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-full)] bg-bg-sunken text-caption font-semibold">
              {role === "admin" ? "GG" : "J"}
            </span>
            <div className="min-w-0 flex-1">
              <strong className="text-label">You</strong>
              <pre className="mono mt-2 overflow-x-auto whitespace-pre-wrap rounded-[var(--radius-input)] bg-bg-sunken p-3 text-caption text-fg-2">
                <code data-testid="agent-prompt">{prompt}</code>
              </pre>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-input)] bg-brand-bg text-brand">
              <FirstTreeLogo className="h-4 w-auto" />
            </span>
            <div className="min-w-0 flex-1">
              <strong className="text-label">First Tree</strong>
              <p className="mt-2 rounded-[var(--radius-input)] bg-success-soft p-3 text-label text-success">
                {response}
              </p>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
