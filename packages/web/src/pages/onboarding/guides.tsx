import { Check, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { COPY } from "./copy.js";

/**
 * Progressive-disclosure visual help. Collapsed by default so confident
 * users breeze past; a beginner can expand a step-by-step illustration of
 * what's about to happen. Native <details> for built-in keyboard/screen-
 * reader support; the only motion (chevron rotation, terminal caret) is
 * stilled under prefers-reduced-motion via index.css.
 */
export function ShowMeHow({
  label = "Need help?",
  open,
  onToggle,
  children,
}: {
  label?: string;
  /** Controlled open state. Omit for an uncontrolled (native) disclosure. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details className="onboarding-show-me-how" open={open} onToggle={(e) => onToggle?.(e.currentTarget.open)}>
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

/**
 * Troubleshooting block for the Connect-computer "Need help?" disclosure:
 * a neutral-titled list of "why it might not be connecting" reasons + the
 * Node.js install link. Distinct from the shared `ConnectStuckPanel` (which
 * the Settings → Computers dialog still uses, auto-shown only after the
 * stuck timeout) — here it lives inside the disclosure with a state-neutral
 * title, since the user can open Need help? proactively, not only when stuck.
 */
export function ConnectTroubleshooting() {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2)", marginTop: "var(--sp-4)" }}>
      <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
        {COPY.connectComputer.troubleshootTitle}
      </p>
      <ul className="flex flex-col" style={{ gap: "var(--sp-1_5)", margin: 0, paddingLeft: "var(--sp-4)" }}>
        {COPY.connectComputer.stuckReasons.map((reason) => (
          <li key={reason} className="text-label" style={{ color: "var(--fg-3)" }}>
            {reason}
          </li>
        ))}
      </ul>
      <a
        href={COPY.connectComputer.nodeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center text-label font-medium self-start"
        style={{ gap: "var(--sp-1)", color: "var(--primary)" }}
      >
        {COPY.connectComputer.nodeLinkLabel}
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
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
              borderRadius: "var(--radius-full)",
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
            borderRadius: "var(--radius-full)",
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
          <div
            className="inline-flex items-center"
            style={{ gap: "var(--sp-1)", color: "var(--success)", marginTop: "var(--sp-1)" }}
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            macbook-pro connected
          </div>
        </div>
      </div>
      <GuideSteps
        steps={[
          "Open Terminal (Mac) or PowerShell (Windows).",
          "Paste the command and press Enter.",
          "This page switches to “connected” on its own.",
        ]}
      />
      {/* The Node.js install hint lives in <ConnectTroubleshooting> now (one
          home for it), so it isn't repeated here. */}
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

/**
 * Troubleshooting block for the connect-code "Need help?" disclosure (paired
 * with InstallGuide), mirroring ConnectTroubleshooting on connect-computer:
 * a neutral-titled "if the install didn't go through" line. The disclosure
 * auto-opens when the user returns from GitHub without an installation, so the
 * two steps give the same "stuck → help opens" experience.
 */
export function InstallTroubleshooting() {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-1)", marginTop: "var(--sp-4)" }}>
      <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
        {COPY.connectCode.troubleshootTitle}
      </p>
      <p className="text-label" style={{ margin: 0, color: "var(--fg-3)" }}>
        {COPY.connectCode.troubleshootBody}
      </p>
    </div>
  );
}
