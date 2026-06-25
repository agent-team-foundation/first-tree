import { Github, GitPullRequest, Sparkles } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { reportOnboardingEvent } from "../../api/onboarding-events.js";
import { useAuth } from "../../auth/auth-context.js";
import { FirstTreeLogo } from "../../components/first-tree-logo.js";
import { Button } from "../../components/ui/button.js";
import { normalizeGitHubRepoUrl, writeRepoWorkIntent } from "./intent.js";

const START_PATH = "/repo-work/start";
const GITHUB_AUTH_HREF = `/api/v1/auth/github/start?next=${encodeURIComponent(START_PATH)}`;

export function RepoWorkLandingPage() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [repoUrl, setRepoUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedRepoUrl = String(new FormData(event.currentTarget).get("repoUrl") ?? repoUrl);
    const intent = normalizeGitHubRepoUrl(submittedRepoUrl);
    if (!intent) {
      setError("Enter a GitHub repository URL");
      return;
    }
    setError(null);
    writeRepoWorkIntent(intent);
    void reportOnboardingEvent("repo_work_landing_submitted", {
      repoHost: "github.com",
    });
    if (isAuthenticated) {
      navigate(START_PATH);
    } else {
      window.location.assign(GITHUB_AUTH_HREF);
    }
  }

  return (
    <div className="landing-marketing min-h-screen bg-background text-foreground">
      <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-5 py-6">
        <header className="flex items-center justify-between">
          <a href="/" className="inline-flex items-center gap-2 text-body text-fg-2 hover:text-foreground">
            <FirstTreeLogo width={24} height={28} />
            First Tree
          </a>
          <a href="/login" className="text-label text-fg-3 hover:text-foreground">
            Sign in
          </a>
        </header>

        <section className="grid flex-1 content-center gap-10 py-12 md:grid-cols-[1.1fr_0.9fr] md:items-center">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-[var(--radius-input)] border border-border px-3 py-1 text-label text-fg-2">
              <GitPullRequest className="h-3.5 w-3.5" />
              GitHub repo work thread
            </div>
            <div className="space-y-4">
              <h1 className="max-w-3xl text-[3.5rem] font-semibold leading-none tracking-normal md:text-[5rem]">
                Find work worth continuing.
              </h1>
              <p className="max-w-2xl text-title text-fg-2">
                Start from a GitHub repo URL. First Tree connects your local coding agent, opens a repo-specific thread,
                and turns the first useful task into a resumable Task Brief.
              </p>
            </div>
          </div>

          <form onSubmit={submit} className="rounded-[var(--radius-panel)] border border-border bg-card p-5">
            <div className="space-y-2">
              <label htmlFor="repo-work-url" className="text-label text-fg-2">
                GitHub repo URL
              </label>
              <input
                id="repo-work-url"
                name="repoUrl"
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="https://github.com/acme/backend"
                className="w-full rounded-[var(--radius-input)] border border-border bg-background px-3 py-2 text-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {error ? (
                <p className="text-label" style={{ color: "var(--fg-error-strong)" }}>
                  {error}
                </p>
              ) : null}
            </div>

            <Button type="submit" className="mt-4 w-full bg-foreground text-background hover:bg-foreground/90">
              <Github className="h-4 w-4" />
              Continue with GitHub
            </Button>

            <div className="mt-4 grid gap-3 border-t border-border pt-4 text-label text-fg-3">
              <p className="inline-flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5" />
                GitHub is identity only here. Repo access stays local-first.
              </p>
              <p>GitHub App appears later only when a PR, comment, or durable repo integration needs it.</p>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
