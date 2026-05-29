import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { COPY } from "./copy.js";

/**
 * Progressive-disclosure visual help. Collapsed by default so confident
 * users breeze past; a beginner can expand a step-by-step illustration of
 * what's about to happen. Native <details> for built-in keyboard/screen-
 * reader support; the only motion (chevron rotation, terminal caret) is
 * stilled under prefers-reduced-motion via index.css.
 */
export function ShowMeHow({ label = "Show me how", children }: { label?: string; children: ReactNode }) {
  return (
    <details className="onboarding-show-me-how">
      <summary
        className="inline-flex items-center text-label font-medium"
        style={{ gap: "var(--sp-1)", color: "var(--primary)" }}
      >
        <ChevronRight className="onboarding-disclosure-chevron h-3.5 w-3.5" />
        {label}
      </summary>
      <div style={{ marginTop: "var(--sp-3)" }}>{children}</div>
    </details>
  );
}

function GuideSteps({ steps }: { steps: readonly string[] }) {
  return (
    <ol
      className="flex flex-col"
      style={{ gap: "var(--sp-1_5)", margin: "var(--sp-3) 0 0", padding: 0, listStyle: "none" }}
    >
      {steps.map((step, i) => (
        <li key={step} className="flex items-start text-label" style={{ gap: "var(--sp-2)", color: "var(--fg-3)" }}>
          <span
            aria-hidden="true"
            className="mono inline-flex items-center justify-center"
            style={{
              width: "var(--sp-4)",
              height: "var(--sp-4)",
              flexShrink: 0,
              borderRadius: 999,
              background: "color-mix(in oklch, var(--primary) 14%, transparent)",
              color: "var(--primary)",
            }}
          >
            {i + 1}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

function WindowDots() {
  return (
    <div className="flex items-center" style={{ gap: "var(--sp-1)" }}>
      {[0, 1, 2].map((d) => (
        <span
          key={d}
          aria-hidden="true"
          style={{
            width: "var(--sp-1_5)",
            height: "var(--sp-1_5)",
            borderRadius: 999,
            background: "var(--fg-4)",
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

/** Mock terminal: what the connect-a-computer command looks like in action. */
export function TerminalGuide() {
  return (
    <div>
      <div
        role="img"
        aria-label="A terminal window showing the install and login commands, then a connected confirmation."
        style={{
          borderRadius: "var(--radius-input)",
          border: "var(--hairline) solid var(--border-faint)",
          background: "color-mix(in oklch, var(--bg-sunken) 60%, var(--bg))",
          overflow: "hidden",
        }}
      >
        <div
          className="flex items-center"
          style={{
            gap: "var(--sp-2)",
            padding: "var(--sp-1_5) var(--sp-2_5)",
            borderBottom: "var(--hairline) solid var(--border-faint)",
          }}
        >
          <WindowDots />
          <span className="text-caption" style={{ color: "var(--fg-4)" }}>
            Terminal
          </span>
        </div>
        <div
          className="mono text-label flex flex-col"
          style={{ padding: "var(--sp-2_5) var(--sp-3)", gap: "var(--sp-1)" }}
        >
          <div style={{ color: "var(--fg-3)" }}>
            <span style={{ color: "var(--fg-4)" }}>$ </span>npm install -g first-tree
          </div>
          <div style={{ color: "var(--fg-3)" }}>
            <span style={{ color: "var(--fg-4)" }}>$ </span>first-tree login a1b2c3…
            <span
              aria-hidden="true"
              className="onboarding-guide-caret"
              style={{
                display: "inline-block",
                width: "var(--sp-1_5)",
                height: "1em",
                marginLeft: "var(--sp-0_5)",
                verticalAlign: "text-bottom",
                background: "var(--primary)",
              }}
            />
          </div>
          <div style={{ color: "color-mix(in oklch, var(--primary) 30%, var(--fg))", marginTop: "var(--sp-1)" }}>
            ✓ macbook-pro connected
          </div>
        </div>
      </div>
      <GuideSteps
        steps={[
          "On a Mac: open the app called Terminal. On Windows: press the Start button, type PowerShell, and open it.",
          "Paste the command above and press Enter.",
          "When it finishes, this page updates to “connected” on its own.",
        ]}
      />
      <p className="text-label" style={{ margin: "var(--sp-3) 0 0", color: "var(--fg-4)" }}>
        First time? Your computer may need Node.js (a free, one-time install) before the command works:{" "}
        <a
          href={COPY.connectComputer.nodeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium"
          style={{ color: "var(--primary)" }}
        >
          {COPY.connectComputer.nodeLinkLabel}
        </a>
      </p>
    </div>
  );
}

function FlowChip({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center text-caption font-medium"
      style={{
        padding: "var(--sp-1) var(--sp-2)",
        borderRadius: "var(--radius-input)",
        background: "color-mix(in oklch, var(--primary) 8%, transparent)",
        border: "var(--hairline) solid color-mix(in oklch, var(--primary) 22%, transparent)",
        color: "var(--fg-2)",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

/** What connecting code looks like on GitHub's side, then back here. */
export function InstallGuide() {
  return (
    <div>
      <div
        role="img"
        aria-label="Flow: choose your projects on GitHub, click install, then return to setup."
        className="flex items-center"
        style={{
          gap: "var(--sp-2)",
          flexWrap: "wrap",
          padding: "var(--sp-3)",
          borderRadius: "var(--radius-input)",
          border: "var(--hairline) solid var(--border-faint)",
          background: "color-mix(in oklch, var(--bg-raised) 40%, transparent)",
        }}
      >
        <FlowChip label="Choose your projects" />
        <ChevronRight className="h-3.5 w-3.5" style={{ color: "var(--fg-4)", flexShrink: 0 }} aria-hidden="true" />
        <FlowChip label="Click Install" />
        <ChevronRight className="h-3.5 w-3.5" style={{ color: "var(--fg-4)", flexShrink: 0 }} aria-hidden="true" />
        <FlowChip label="Back here automatically" />
      </div>
      <GuideSteps
        steps={[
          "GitHub asks which projects First Tree may access — pick yours.",
          "Click the green Install button.",
          "GitHub sends you straight back here to keep going.",
        ]}
      />
    </div>
  );
}
