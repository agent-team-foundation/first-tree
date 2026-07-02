import { ArrowRight } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { useGrowthLandingPagesState } from "../../hooks/use-server-channel.js";
import { Footer } from "../landing/footer.js";
import { LandingNav } from "../landing/nav.js";
import { type CampaignSlug, isKnownCampaign } from "../quickstart/campaigns.js";
import { normalizeGitHubRepoUrl } from "../quickstart/intent.js";
import { SCAN_LANDING_COPY } from "./scan-copy.js";

/**
 * Build the landing → quickstart handoff URL. The repo value is
 * percent-encoded per the contract in quickstart `campaigns.ts`: a raw
 * `https://…` repo (with `:` and `//`) is dropped to `/` by `safeRedirectPath`
 * on the post-login `next` round-trip, so it MUST be encoded to survive.
 * Extracted + exported so the contract is unit-tested against quickstart's own
 * `readCampaignHandoff` parser (see scan-landing-page.test.tsx round-trip).
 */
export function buildScanHandoffHref(campaign: CampaignSlug, repoUrl: string): string {
  return `/quickstart?campaign=${campaign}&repo=${encodeURIComponent(repoUrl)}`;
}

/**
 * Scan landing page (`/scan/:campaign`) — the top of the growth funnel.
 *
 * The visitor pastes a GitHub repo and hits Scan; we hand off to the quickstart
 * flow at `/quickstart?campaign=<slug>&repo=<encoded>`, which owns login,
 * connecting a computer, and starting the campaign's first chat. This page does
 * one job: validate the repo and build that handoff URL.
 *
 * Feature-flagged, exactly like the quickstart it feeds: older servers and
 * fetch failures resolve to disabled, keeping the whole funnel hidden until an
 * operator explicitly opens it. Public route (no auth) — login happens later,
 * inside quickstart, carried by the `next` round-trip.
 */
export function ScanLandingPage() {
  const navigate = useNavigate();
  const { campaign: slugParam } = useParams<{ campaign: string }>();
  const campaign: CampaignSlug | null = isKnownCampaign(slugParam) ? slugParam : null;

  const { enabled: growthLandingPagesEnabled, settled } = useGrowthLandingPagesState();

  const copy = campaign ? SCAN_LANDING_COPY[campaign] : null;

  useEffect(() => {
    if (!copy) return;
    const previous = document.title;
    document.title = `${copy.headline} — First Tree`;
    return () => {
      document.title = previous;
    };
  }, [copy]);

  const [repoInput, setRepoInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Hold a neutral surface while the feature flag resolves — never flash the
  // form for a disabled deployment mid-fetch (mirrors the quickstart gate).
  if (!settled) {
    return <div className="landing-marketing min-h-screen bg-background" />;
  }
  // Disabled / old server, or a campaign slug we don't recognise → send home.
  if (!growthLandingPagesEnabled || !campaign || !copy) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const repo = normalizeGitHubRepoUrl(repoInput);
    if (!repo) {
      setError("Enter a public GitHub repo URL, like https://github.com/your-org/your-repo.");
      return;
    }
    setError(null);
    navigate(buildScanHandoffHref(campaign, repo.url));
  };

  return (
    <div className="landing-marketing flex min-h-screen flex-col bg-background text-foreground">
      <LandingNav />
      <main className="flex-1">
        <section className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 pb-24 pt-20 text-center sm:pt-28">
          <p className="mb-6 text-eyebrow uppercase text-fg-3">{copy.eyebrow}</p>
          <h1 className="text-display text-foreground">{copy.headline}</h1>
          <p className="mt-6 max-w-2xl text-lead text-fg-2">{copy.subhead}</p>

          <form onSubmit={onSubmit} className="mt-10 flex w-full max-w-xl flex-col items-stretch gap-3" noValidate>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input
                type="text"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-label="GitHub repository URL"
                aria-invalid={error ? true : undefined}
                aria-describedby="scan-repo-help"
                placeholder={copy.repoPlaceholder}
                value={repoInput}
                onChange={(event) => {
                  setRepoInput(event.target.value);
                  if (error) setError(null);
                }}
                className="h-11 flex-1 text-center sm:text-left"
              />
              <Button type="submit" variant="cta" size="lg" className="group h-11 shrink-0">
                {copy.ctaLabel}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Button>
            </div>
            {/* Stable live region: present before any error so screen readers
                reliably announce it, and the input's aria-describedby can point
                at it. Doubles as the privacy reassurance when there's no error. */}
            <p
              id="scan-repo-help"
              aria-live="polite"
              className={error ? "text-label text-destructive" : "text-label text-fg-3"}
            >
              {error ?? "First Tree runs on your own computer, so your code stays local."}
            </p>
          </form>

          <div className="mt-12 flex flex-col items-center gap-3">
            <p className="text-eyebrow uppercase text-fg-4">{copy.checksLabel}</p>
            <ul className="flex flex-wrap items-center justify-center gap-2">
              {copy.checks.map((check) => (
                <li
                  key={check}
                  className="rounded-[var(--radius-full)] border border-border px-3 py-1 text-label text-fg-2"
                >
                  {check}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
