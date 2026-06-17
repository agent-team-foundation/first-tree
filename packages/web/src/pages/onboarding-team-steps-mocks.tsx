import { ArrowRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { FirstTreeLogo } from "../components/first-tree-logo.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";

/**
 * DEV-only mockups for the team (welcome) step's "what's next" step preview
 * above Get started — single column (the two-column split was dropped). Two
 * formats for the user to compare:
 *   - MockTeamStepsA — compact numbered list under a "What's next" eyebrow.
 *   - MockTeamStepsB — a single muted one-liner with arrows.
 * Also previews the proposed label change "What should we call your team?" →
 * "Name your team" (consistent with create-agent's "Name your agent").
 */

const STEPS = ["Install First Tree", "Create your first agent", "Connect to GitHub"] as const;

function Frame({ preview }: { preview: ReactNode }): ReactNode {
  const [name, setName] = useState("Gandy's team");
  return (
    <div className="flex flex-col" style={{ height: "100%", background: "var(--bg)" }}>
      <header className="flex items-center justify-between" style={{ padding: "var(--sp-4) var(--sp-5)" }}>
        <span className="inline-flex items-center" style={{ gap: "var(--sp-2)", color: "var(--fg)" }}>
          <FirstTreeLogo width={22} height={25} />
          <span className="text-label font-semibold">First Tree</span>
        </span>
        <Button type="button" variant="link" className="h-auto p-0 text-label">
          Sign out
        </Button>
      </header>
      <div
        className="flex-1 flex flex-col items-center"
        style={{ overflowY: "auto", paddingTop: "6rem", paddingInline: "var(--sp-5)" }}
      >
        <main className="flex flex-col" style={{ width: "34rem", maxWidth: "100%", gap: "var(--sp-6)" }}>
          <div className="flex flex-col" style={{ gap: "var(--sp-2_5)" }}>
            <h1 className="text-title font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
              Welcome to First Tree
            </h1>
            <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
              You and your local coding agent (Claude Code, Codex) join a First Tree team to work together.
            </p>
          </div>
          <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
            <label htmlFor="mock-team" className="text-label font-medium" style={{ color: "var(--fg-2)" }}>
              Name your team
            </label>
            <Input id="mock-team" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </div>
          {preview}
          <div className="flex">
            <Button type="button">
              <span>Get started</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </main>
      </div>
    </div>
  );
}

/** A — compact numbered list. */
export function MockTeamStepsA(): ReactNode {
  return (
    <Frame
      preview={
        <div className="flex flex-col" style={{ gap: "var(--sp-2_5)" }}>
          <p className="text-eyebrow" style={{ margin: 0, color: "var(--fg-4)", textTransform: "uppercase" }}>
            What's next
          </p>
          <ol className="flex flex-col" style={{ gap: "var(--sp-2)", margin: 0, padding: 0 }}>
            {STEPS.map((s, i) => (
              <li key={s} className="flex items-center" style={{ gap: "var(--sp-2_5)", listStyle: "none" }}>
                <span
                  className="inline-flex items-center justify-center text-caption font-semibold"
                  style={{
                    flexShrink: 0,
                    width: "var(--sp-5)",
                    height: "var(--sp-5)",
                    borderRadius: "var(--radius-full)",
                    background: "color-mix(in srgb, var(--primary) 12%, transparent)",
                    color: "var(--primary)",
                  }}
                >
                  {i + 1}
                </span>
                <span className="text-label" style={{ color: "var(--fg-2)" }}>
                  {s}
                </span>
              </li>
            ))}
          </ol>
        </div>
      }
    />
  );
}

/** B — single muted one-liner with arrows. */
export function MockTeamStepsB(): ReactNode {
  return (
    <Frame
      preview={
        <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
          <span style={{ color: "var(--fg-3)" }}>Next: </span>
          {STEPS.join("  →  ")}
        </p>
      }
    />
  );
}

/**
 * Ceremonial welcome — a centered "this is a moment" treatment that builds
 * anticipation: prominent brand mark, a warm headline, a payoff-teasing subline
 * (your coding agent working alongside your team, in minutes), the single
 * naming action, and a low-effort expectation ("3 quick steps · ~2 minutes").
 * Vertically centered, generous spacing, center-aligned hero.
 */
export function MockWelcomeCeremonial(): ReactNode {
  const [name, setName] = useState("Gandy's team");
  return (
    <div className="flex flex-col" style={{ height: "100%", background: "var(--bg)" }}>
      <header className="flex items-center justify-between" style={{ padding: "var(--sp-4) var(--sp-5)" }}>
        <span className="inline-flex items-center" style={{ gap: "var(--sp-2)", color: "var(--fg)" }}>
          <FirstTreeLogo width={22} height={25} />
          <span className="text-label font-semibold">First Tree</span>
        </span>
        <Button type="button" variant="link" className="h-auto p-0 text-label">
          Sign out
        </Button>
      </header>
      <div
        className="flex-1 flex flex-col items-center"
        style={{
          overflowY: "auto",
          // Anchored in the upper third (not dead-center) so the welcome sits high.
          paddingTop: "clamp(var(--sp-12), 13vh, var(--sp-20))",
          paddingBottom: "var(--sp-8)",
          paddingInline: "var(--sp-5)",
        }}
      >
        {/* Three deliberate zones with their own rhythm: HERO (brand + value),
            ROADMAP (quiet "what's next"), ACTION (name + a restrained CTA). */}
        <main className="flex flex-col items-center" style={{ width: "100%", maxWidth: "46rem" }}>
          {/* ── Hero ── (wide enough for the subtitle to sit on ONE line) */}
          <FirstTreeLogo width={42} height={47} style={{ color: "var(--brand-dim)" }} />
          <h1
            className="text-headline font-semibold"
            style={{ margin: "var(--sp-5) 0 0", color: "var(--fg)", textAlign: "center" }}
          >
            Welcome to First Tree
          </h1>
          <p
            className="text-body"
            style={{ margin: "var(--sp-2_5) 0 0", color: "var(--fg-3)", textAlign: "center", whiteSpace: "nowrap" }}
          >
            You and your local coding agent (Claude Code, Codex) join a First Tree team to work together.
          </p>

          {/* ── Roadmap ── quiet, refined: a faint eyebrow + delicate numerals
              (no filled chips) so it reads as a light roadmap, not a heavy list. */}
          <p
            className="text-eyebrow"
            style={{
              margin: "var(--sp-7) 0 0",
              color: "var(--fg-4)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              textAlign: "center",
            }}
          >
            What's next
          </p>
          <ol className="flex flex-col" style={{ margin: "var(--sp-3) 0 0", padding: 0, gap: "var(--sp-2)" }}>
            {STEPS.map((s, i) => (
              <li
                key={s}
                className="flex items-baseline text-label"
                style={{ gap: "var(--sp-2_5)", listStyle: "none" }}
              >
                <span
                  className="mono"
                  style={{ width: "var(--sp-3)", flexShrink: 0, color: "var(--brand-dim)", textAlign: "right" }}
                >
                  {i + 1}
                </span>
                <span style={{ color: "var(--fg-2)" }}>{s}</span>
              </li>
            ))}
          </ol>

          {/* ── Action ── (clear gap above separates it from orientation). The
              CTA is auto-width + centered (a restrained pill, not a heavy
              full-width black bar). */}
          <div
            className="flex flex-col items-center"
            style={{ marginTop: "var(--sp-10)", gap: "var(--sp-4)", width: "100%", maxWidth: "22rem" }}
          >
            {/* Inline field: the preset team name as the value, with a muted
                "← rename it freely" hint trailing it — signals editability on the
                same line, no separate label row. The input sizes to its content
                so the hint sits right after the name. */}
            <label
              htmlFor="mock-cer-team"
              className="flex items-center"
              style={{
                width: "100%",
                gap: "var(--sp-2)",
                padding: "var(--sp-2) var(--sp-2_5)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-input)",
                background: "var(--bg)",
                cursor: "text",
              }}
            >
              <input
                id="mock-cer-team"
                value={name}
                onChange={(e) => setName(e.target.value)}
                size={Math.max(name.length, 4)}
                maxLength={200}
                className="text-body"
                style={{ border: 0, outline: "none", background: "transparent", color: "var(--fg)", padding: 0 }}
              />
              <span className="text-label" style={{ color: "var(--fg-4)", whiteSpace: "nowrap", flexShrink: 0 }}>
                ← rename it freely
              </span>
            </label>
            <Button type="button" className="justify-center">
              <span>Get started</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </main>
      </div>
    </div>
  );
}
