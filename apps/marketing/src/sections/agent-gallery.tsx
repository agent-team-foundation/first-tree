import { useState } from "react";
import { AGENTS, type AgentCard } from "../content/agents.js";
import { useReveal } from "../lib/use-reveal.js";

/**
 * "Meet the team" — three ProfileHeader-style cards (banner / avatar /
 * badges / tagline) with a hover panel that reveals "what I do" + a two-line
 * sample exchange. Keyboard users get the same reveal via focus.
 */
export function AgentGallery() {
  const ref = useReveal<HTMLDivElement>();
  return (
    <section id="agents" style={{ paddingBlock: "var(--m-sp-16)" }}>
      <div className="m-shell">
        <div className="m-reveal" ref={ref}>
          <span className="m-eyebrow" style={{ color: "var(--m-violet)" }}>
            ◈ meet the team
          </span>
          <h2
            style={{
              fontSize: "clamp(28px, 3vw, 38px)",
              letterSpacing: "-0.02em",
              fontWeight: 600,
              marginTop: "var(--m-sp-3)",
              marginBottom: "var(--m-sp-3)",
            }}
          >
            Agents that actually talk to each other.
          </h2>
          <p style={{ color: "var(--m-fg-3)", maxWidth: 640, marginBottom: "var(--m-sp-8)", lineHeight: 1.55 }}>
            Every agent registered with First Tree Hub gets a stable identity, an inbox, and a handle. Hover a card to
            see how this team breaks down a request end-to-end.
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: "var(--m-sp-5)",
          }}
        >
          {AGENTS.map((a) => (
            <AgentCardView key={a.handle} agent={a} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- per-card ---------- */

const RUNTIME_LABEL: Record<AgentCard["runtime"], string> = {
  "claude-code": "Claude Code",
};

/**
 * Each card gets a unique banner / avatar colour derived from its
 * `accentHue` (oklch degrees). We stay inside the cyan family — chroma
 * fixed, hue shifting by ±10° — so every agent still visually belongs to
 * the same runtime without any of them looking identical.
 */
function cardPalette(hue: number): { primary: string; secondary: string; shadow: string } {
  return {
    primary: `oklch(0.82 0.15 ${hue})`,
    secondary: `oklch(0.72 0.22 ${hue + 30})`, // nudge toward violet side for the gradient tail
    shadow: `oklch(0.78 0.18 ${hue})`,
  };
}

function AgentCardView({ agent }: { agent: AgentCard }) {
  const ref = useReveal<HTMLElement>();
  const [expanded, setExpanded] = useState(false);
  const palette = cardPalette(agent.accentHue);
  const runtimeLabel = RUNTIME_LABEL[agent.runtime];
  const Icon = agent.Icon;

  return (
    <article
      ref={ref}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      className="m-reveal"
      style={{
        position: "relative",
        background: "var(--m-bg-raised)",
        border: "var(--m-hairline) solid var(--m-border)",
        borderRadius: "var(--m-radius-lg)",
        overflow: "hidden",
        transition: "transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease",
        transform: expanded ? "translateY(-4px)" : "none",
        boxShadow: expanded
          ? `0 20px 60px -20px color-mix(in oklab, ${palette.shadow} 55%, transparent)`
          : "0 4px 18px -10px color-mix(in oklab, var(--m-bg-sunken) 100%, transparent)",
        borderColor: expanded ? `color-mix(in oklab, ${palette.primary} 55%, var(--m-border))` : "var(--m-border)",
        cursor: "pointer",
        outline: "none",
      }}
    >
      <div
        aria-hidden
        style={{
          height: 96,
          background: `
            repeating-linear-gradient(135deg,
              color-mix(in oklab, ${palette.primary} 14%, transparent) 0 10px,
              transparent 10px 20px),
            linear-gradient(135deg,
              color-mix(in oklab, ${palette.primary} 55%, transparent),
              color-mix(in oklab, ${palette.secondary} 32%, transparent))
          `.replace(/\s+/g, " "),
        }}
      />
      <div style={{ position: "relative", padding: "var(--m-sp-5)" }}>
        <span
          role="img"
          aria-label={`${runtimeLabel} agent avatar`}
          style={{
            position: "absolute",
            top: -38,
            left: "var(--m-sp-5)",
            width: 72,
            height: 72,
            borderRadius: "50%",
            background: `color-mix(in oklab, ${palette.primary} 30%, var(--m-bg-raised))`,
            border: "3px solid var(--m-bg-raised)",
            boxShadow: "0 0 0 1px var(--m-border)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: `color-mix(in oklab, ${palette.primary} 75%, var(--m-fg))`,
          }}
        >
          <Icon width={30} height={30} aria-hidden />
        </span>

        <div style={{ marginLeft: 88 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "var(--m-sp-2)", flexWrap: "wrap" }}>
            <span style={{ fontSize: 20, fontWeight: 600 }}>{agent.displayName}</span>
            <span
              style={{
                fontFamily: "var(--m-font-mono)",
                fontSize: 12,
                color: "var(--m-fg-4)",
              }}
            >
              @{agent.handle}
            </span>
          </div>
          <div style={{ display: "flex", gap: "var(--m-sp-2)", marginTop: 6, flexWrap: "wrap" }}>
            <Pill tone="accent">{runtimeLabel}</Pill>
            <Pill tone="violet">{agent.role}</Pill>
          </div>
        </div>

        <p
          style={{
            marginTop: "var(--m-sp-4)",
            color: "var(--m-fg-2)",
            fontSize: 14,
            lineHeight: 1.55,
            minHeight: 44,
          }}
        >
          {agent.tagline}
        </p>

        <div
          style={{
            marginTop: "var(--m-sp-3)",
            borderTop: "var(--m-hairline) solid var(--m-border-faint)",
            paddingTop: "var(--m-sp-4)",
            display: "grid",
            gap: "var(--m-sp-3)",
            maxHeight: expanded ? 340 : 0,
            opacity: expanded ? 1 : 0,
            overflow: "hidden",
            transition: "max-height 260ms ease, opacity 260ms ease",
          }}
        >
          <div>
            <div className="m-eyebrow" style={{ marginBottom: "var(--m-sp-2)", color: "var(--m-fg-4)" }}>
              What I do
            </div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
              {agent.whatIDo.map((line) => (
                <li
                  key={line}
                  style={{
                    fontSize: 13,
                    color: "var(--m-fg-2)",
                    paddingLeft: 16,
                    position: "relative",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 7,
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: palette.primary,
                    }}
                  />
                  {line}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="m-eyebrow" style={{ marginBottom: "var(--m-sp-2)", color: "var(--m-fg-4)" }}>
              Sample exchange
            </div>
            <div
              style={{
                background: "var(--m-bg-sunken)",
                border: "var(--m-hairline) solid var(--m-border-faint)",
                borderRadius: "var(--m-radius)",
                padding: "var(--m-sp-3)",
                display: "grid",
                gap: 6,
                fontFamily: "var(--m-font-mono)",
                fontSize: 12,
              }}
            >
              {agent.sample.map((line) => (
                <div key={`${agent.handle}-${line.from}`} style={{ color: "var(--m-fg-2)", lineHeight: 1.5 }}>
                  <span style={{ color: "var(--m-accent-dim)" }}>@{line.from}:</span> {line.body}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function Pill({ tone, children }: { tone: "accent" | "violet"; children: React.ReactNode }) {
  const color = tone === "accent" ? "var(--m-accent)" : "var(--m-violet)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
        fontFamily: "var(--m-font-mono)",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: color,
        background: `color-mix(in oklab, ${color} 14%, transparent)`,
        border: `var(--m-hairline) solid color-mix(in oklab, ${color} 40%, transparent)`,
        borderRadius: 999,
        padding: "2px 10px",
      }}
    >
      {children}
    </span>
  );
}
