import type { ReactNode } from "react";

/**
 * Hairline-separated section inside a computer-card body. All four
 * card bodies (Ready / Offline / AuthExpired / SetupIncomplete) use
 * this single component so their internal section structure renders
 * identically — same padding, same gap, same top hairline.
 *
 * `dimmed` is the only mode toggle; when set, the section + its
 * contents render at reduced opacity. Used by Offline / AuthExpired
 * to mark stale supporting context (runtimes / agents from the last
 * successful heartbeat) without changing the spacing rhythm vs.
 * Ready.
 *
 * The outer card body should be `flex flex-col` with NO inline gap;
 * the top hairline on each section provides separation.
 */
export function CardSection({ dimmed = false, children }: { dimmed?: boolean; children: ReactNode }) {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: "var(--sp-1_5)",
        padding: "var(--sp-2_5) 0",
        borderTop: "var(--hairline) solid var(--border-faint)",
        opacity: dimmed ? 0.7 : 1,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Caption-style section label rendered as the first child of a
 * `CardSection`. Mirrors the GroupLabel pattern Ready used in PR-D3
 * — lifted to shared so all bodies don't redefine it.
 */
export function CardSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-caption" style={{ color: "var(--fg-3)" }}>
      {children}
    </div>
  );
}
