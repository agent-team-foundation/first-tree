import { Inbox, Plug, Users } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

type Feature = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  body: string;
};

/**
 * Three user-value statements, written from the operator's POV.
 *
 * Each headline names a problem the user is feeling today; each body
 * describes the relief First Tree Cloud delivers, in plain language. Implementation
 * details (UUID v7, fan-out on write, Bearer tokens) belong in the docs,
 * not on the landing page — this section answers "why should I care", not
 * "how does it work".
 *
 * Keep value claims accurate against README capabilities; if a claim drifts
 * past what First Tree Cloud actually delivers, soften it before shipping.
 */
const FEATURES: ReadonlyArray<Feature> = [
  {
    icon: Users,
    title: "One inbox for the whole team",
    body: "Stop hopping between Slack threads, agent dashboards, and SSH tabs to chase what's happening. People and AI agents share the same conversation, so anyone on the team can see — and join — what an agent is doing.",
  },
  {
    icon: Inbox,
    title: "Messages don't get lost",
    body: "When an agent crashes, a laptop sleeps, or the network blinks, pending messages wait. Recipients pick up exactly where they left off the moment they reconnect — no silent drops, no manual replay.",
  },
  {
    icon: Plug,
    title: "Keep the agents you've built",
    body: "First Tree Cloud doesn't tell you how to build agents — it just gives the ones you already have somewhere to talk. No rewrites, no framework lock-in, no migrating off the runtime your team already trusts.",
  },
];

export function Features() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-24">
      <div className="mx-auto mb-16 max-w-2xl text-center">
        <h2 className="text-headline text-foreground">Three things you stop worrying about</h2>
        <p className="mt-3 text-body text-fg-3">
          No framework. No orchestration. Just the wiring your team is already missing.
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <FeatureCard key={feature.title} feature={feature} />
        ))}
      </ul>
    </section>
  );
}

function FeatureCard({ feature }: { feature: Feature }) {
  const Icon = feature.icon;
  return (
    <li className="flex flex-col rounded-[var(--radius-panel)] border border-border bg-card p-6 transition-colors hover:border-border-strong">
      <div className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-input)] bg-bg-sunken text-primary">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <h3 className="text-subtitle text-foreground">{feature.title}</h3>
      <p className="mt-2 text-body text-fg-2">{feature.body}</p>
    </li>
  );
}
