import { BookOpen, Github, Terminal } from "lucide-react";
import { LINKS } from "../content/links.js";
import { useReveal } from "../lib/use-reveal.js";

// MVP: the stats strip is intentionally **not rendered** yet. This project is
// brand new and any hand-picked number would read as marketing fluff to the
// developer audience we're trying to pull. The component + constants stay in
// the file so the follow-up — wiring `/api/v1/public/stats` into the strip —
// is a one-line re-enable inside the Hero JSX plus a fetch hook.
// TODO(live): hit /api/v1/public/stats and render <StatsStrip /> with real data.
type Stat = { label: string; value: string };
const SHOW_STATS_STRIP = false; // flip to true once the public endpoint lands
const STATS: Stat[] = [
  { label: "Agents registered", value: "—" },
  { label: "Organizations", value: "—" },
  { label: "Sessions (24h)", value: "—" },
  { label: "Runtimes supported", value: "—" },
];

export function Hero() {
  const ref = useReveal<HTMLDivElement>();
  return (
    <section id="top" style={{ paddingBlock: "var(--m-sp-20) var(--m-sp-16)" }}>
      <div className="m-shell m-reveal" ref={ref}>
        <span className="m-eyebrow" style={{ color: "var(--m-accent-dim)" }}>
          ◇ Open source · infrastructure for agent teams
        </span>
        <h1
          style={{
            fontSize: "clamp(40px, 5.5vw, 68px)",
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: "-0.03em",
            marginTop: "var(--m-sp-4)",
            marginBottom: "var(--m-sp-4)",
            background: "linear-gradient(120deg, var(--m-fg) 0%, var(--m-accent) 45%, var(--m-violet) 95%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          The team of agents
          <br />
          your team is missing.
        </h1>

        <p
          style={{
            fontSize: "clamp(17px, 1.6vw, 20px)",
            lineHeight: 1.55,
            maxWidth: 640,
            color: "var(--m-fg-3)",
            marginBottom: "var(--m-sp-8)",
          }}
        >
          First Tree Hub is the open-source spine for coordinating AI agents — register them, message them, wire them
          into Slack / Feishu, and manage everything from one dashboard. Postgres only. JWT only. No hidden magic.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--m-sp-3)" }}>
          <a href={LINKS.repo} target="_blank" rel="noreferrer" className="m-btn m-btn--primary">
            <Github size={16} />
            Star on GitHub
          </a>
          <a href={LINKS.quickstart} target="_blank" rel="noreferrer" className="m-btn m-btn--ghost">
            <Terminal size={16} />
            Quickstart
          </a>
          <a href={LINKS.docs} target="_blank" rel="noreferrer" className="m-btn m-btn--ghost">
            <BookOpen size={16} />
            Docs
          </a>
        </div>

        {SHOW_STATS_STRIP && <StatsStrip />}
      </div>

      <HeroGlow />
    </section>
  );
}

function StatsStrip() {
  return (
    <div
      style={{
        marginTop: "var(--m-sp-12)",
        display: "grid",
        gridTemplateColumns: `repeat(${STATS.length}, minmax(0, 1fr))`,
        gap: "var(--m-sp-1)",
        border: "var(--m-hairline) solid var(--m-border)",
        borderRadius: "var(--m-radius-lg)",
        background: "color-mix(in oklab, var(--m-bg-raised) 80%, transparent)",
        padding: "var(--m-sp-4)",
        backdropFilter: "blur(8px)",
      }}
    >
      {STATS.map((s, i) => (
        <div
          key={s.label}
          style={{
            padding: "var(--m-sp-3) var(--m-sp-4)",
            borderLeft: i === 0 ? "none" : "var(--m-hairline) solid var(--m-border-faint)",
          }}
        >
          <div
            className="m-mono"
            style={{
              fontFamily: "var(--m-font-mono)",
              fontSize: "clamp(22px, 2vw, 28px)",
              fontWeight: 600,
              color: "var(--m-fg)",
              letterSpacing: "-0.02em",
            }}
          >
            {s.value}
          </div>
          <div className="m-eyebrow" style={{ marginTop: 4, color: "var(--m-fg-4)" }}>
            {s.label}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Decorative glow blobs behind the hero copy, pinned so they don't scroll. */
function HeroGlow() {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: "0 0 auto 0",
        height: "140vh",
        zIndex: -1,
        pointerEvents: "none",
        maskImage: "linear-gradient(to bottom, black 30%, transparent 100%)",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: -80,
          left: "-10%",
          width: 520,
          height: 520,
          borderRadius: "50%",
          background: "color-mix(in oklab, var(--m-accent) 22%, transparent)",
          filter: "blur(100px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 60,
          right: "-12%",
          width: 580,
          height: 580,
          borderRadius: "50%",
          background: "color-mix(in oklab, var(--m-violet) 18%, transparent)",
          filter: "blur(110px)",
        }}
      />
    </div>
  );
}
