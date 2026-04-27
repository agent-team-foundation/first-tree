import { Link } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";

/**
 * Placeholder Terms of Service / Privacy pages — M8 P2 in
 * docs/saas-onboarding-journey.md. The legal text isn't drafted yet;
 * the routes exist so /signup's footer links don't 404 and the SaaS
 * landing page reads as a real product instead of an unfinished SPA.
 *
 * Both pages share the same shell: card with a title, a one-paragraph
 * placeholder body, and a back link. Drafting the actual policies is
 * a non-engineering task tracked separately.
 */

export function TermsPage() {
  return (
    <LegalShell
      title="Terms of Service"
      body="Final terms are still being drafted. Until they're posted here, your use of First Tree Hub is governed by your usage agreement with the workspace administrator who invited you (path B) or by the standard Anthropic API usage terms for the underlying Claude API calls (path A)."
    />
  );
}

export function PrivacyPage() {
  return (
    <LegalShell
      title="Privacy"
      body="Final privacy notice is still being drafted. In the meantime: First Tree Hub stores your GitHub identity (numeric ID + login + primary email), your workspace memberships, and metadata about agent runs (no transcript content). All agent execution happens on your own machine via the agent CLI; no run output is uploaded to the hub. Email is contact-only — we do not use it for ads, marketing, or sale to third parties."
    />
  );
}

function LegalShell({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="text-title">{title}</CardTitle>
          <CardDescription>Placeholder while final wording is reviewed.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-body" style={{ color: "var(--fg)" }}>
            {body}
          </p>
          <p className="text-caption">
            <Link to="/signup" className="underline">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
