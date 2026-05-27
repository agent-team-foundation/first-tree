import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import type { ReactNode } from "react";
import { InlineCommand } from "./inline-command.js";
import { buildInstallCommand, PROVIDER_LABEL, PROVIDER_LOGIN_COMMAND, PROVIDER_NPM_PACKAGE } from "./providers.js";

type RuntimeInstallBoxProps = {
  provider: RuntimeProvider;
  /**
   * Current capability state for this provider, or null if the client
   * has never reported any. Drives the command + headline:
   *   - null / missing → "install + login" two-liner
   *   - unauthenticated → "login only" one-liner
   *   - error → "reinstall — last probe error: ..." + install command
   *   - ok → no install box rendered (caller suppresses)
   */
  entry: CapabilityEntry | null;
  /** Computer hostname for the diagnostic copy. */
  hostname: string;
};

/**
 * One install-box per runtime on a Setup-incomplete card.
 *
 * Mockup §"Variant B-2" shows two boxes side-by-side (Claude Code +
 * Codex). The box's job is to give the operator one copy-pasteable
 * command and the smallest possible operator-side narration. Distinct
 * from the `ProviderRow` chips in the Ready card's CapabilityMatrix —
 * that's a state-only summary line; this is an actionable surface.
 */
export function RuntimeInstallBox({ provider, entry, hostname }: RuntimeInstallBoxProps) {
  const label = PROVIDER_LABEL[provider];
  const { headline, command } = installBoxView(entry, provider, hostname);

  // No outer raised-bg / border / radius — the inner `InlineCommand`'s
  // sunken pre-block is the only chrome that earns its weight (commands
  // are a single visual unit the operator scans + copies). Wrapping
  // again would nest a box inside a box inside the page, which fights
  // the Settings tab's "flat hairline-only" vocabulary.
  //
  // Layout: `height: 100%` lets the box take the full grid-row height
  // (CSS Grid stretches items by default), and the InlineCommand
  // wrapper is pushed to the bottom via `margin-top: auto`. The result
  // is that when two boxes sit side-by-side with headlines of
  // different lengths, their Copy buttons baseline-align at the bottom
  // — the operator's eye doesn't have to chase varying button
  // positions.
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-1_5)", height: "100%" }}>
      <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
        {label}
      </div>
      <p className="text-caption" style={{ margin: 0, color: "var(--fg-3)" }}>
        {renderHeadlineWithCode(headline)}
      </p>
      <div style={{ marginTop: "auto" }}>
        <InlineCommand command={command} ariaLabel={`${label} setup command`} />
      </div>
    </div>
  );
}

/**
 * Render a headline string with `inline-code` segments wrapped in `<code>`.
 * The view-model emits literal backticks (e.g. "Run `claude login` on
 * host") for the diagnostic copy; without this helper the user sees raw
 * backticks rendered as text.
 */
function renderHeadlineWithCode(text: string): ReactNode {
  const parts = text.split(/`([^`]+)`/);
  return parts.map((part, idx) =>
    idx % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: text is static; index identifies the segment.
      <code key={idx} className="mono text-label" style={{ color: "var(--fg-2)" }}>
        {part}
      </code>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: text is static; index identifies the segment.
      <span key={idx}>{part}</span>
    ),
  );
}

/**
 * Pure helper — returns `{headline, command}` for a given capability
 * entry. Extracted for testability so the install-box's per-state
 * branching is unit-tested without DOM.
 */
export function installBoxView(
  entry: CapabilityEntry | null,
  provider: RuntimeProvider,
  hostname: string,
): { headline: string; command: string } {
  if (!entry || entry.state === "missing") {
    return {
      headline: `Install ${PROVIDER_LABEL[provider]} and run \`${PROVIDER_LOGIN_COMMAND[provider]}\` on ${hostname}.`,
      command: buildInstallCommand(provider),
    };
  }
  if (entry.state === "unauthenticated") {
    return {
      headline: `${PROVIDER_LABEL[provider]} is installed${entry.sdkVersion ? ` (v${entry.sdkVersion})` : ""} but not logged in. Run on ${hostname}:`,
      command: PROVIDER_LOGIN_COMMAND[provider],
    };
  }
  if (entry.state === "error") {
    return {
      headline: `${PROVIDER_LABEL[provider]} probe failed: ${entry.error ?? "unknown error"}. Reinstall on ${hostname}:`,
      command: `npm install -g ${PROVIDER_NPM_PACKAGE[provider]}`,
    };
  }
  // `ok` should not reach here — the Setup-incomplete card filters such
  // entries out. Provide a defensive fallback that's still actionable.
  return {
    headline: `${PROVIDER_LABEL[provider]} is configured. To reinstall, run on ${hostname}:`,
    command: buildInstallCommand(provider),
  };
}
