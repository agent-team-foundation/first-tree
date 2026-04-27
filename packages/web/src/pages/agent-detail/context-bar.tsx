/**
 * Sticky context bar for the agent detail page. Renders the fixed
 * "Runs on <runtime> @ <computer>" strap so the operator always knows which
 * runtime + binding the page is editing once they've scrolled past the top
 * header (which surfaces the same facts plus model/sessions tiles).
 *
 * Model is intentionally NOT shown here — it is already present in the always-
 * visible top header tiles, so duplicating it adds noise without information.
 *
 * The bar sits **inside** the scrollable main column directly under the page
 * header, so the breadcrumb+title stays at the top (only this bar sticks).
 *
 * Visibility is driven by the parent (see `AgentDetailPage`): an
 * IntersectionObserver on a sentinel at the bottom of the top header toggles
 * `visible`, avoiding first-screen duplication.
 */

export type ContextBarProps = {
  runtimeLabel: string;
  computerLabel: string | null;
  /**
   * When false, the bar is not rendered at all. Defaults to true so callers
   * that don't want visibility control get the always-on behaviour.
   */
  visible?: boolean;
};

export function ContextBar({ runtimeLabel, computerLabel, visible = true }: ContextBarProps) {
  if (!visible) return null;
  return (
    <div
      className="sticky z-20 flex items-center justify-between gap-3 backdrop-blur"
      style={{
        top: 0,
        padding: "var(--sp-1_75) var(--sp-5)",
        background: "color-mix(in oklch, var(--bg-raised) 94%, transparent)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div className="mono text-caption flex items-center gap-2" style={{ color: "var(--fg-3)" }}>
        <span>
          Runs on <span style={{ color: "var(--fg-2)" }}>{runtimeLabel}</span>
        </span>
        {computerLabel && (
          <>
            <span style={{ color: "var(--fg-4)" }} aria-hidden>
              @
            </span>
            <span style={{ color: "var(--fg-2)" }}>{computerLabel}</span>
          </>
        )}
      </div>
    </div>
  );
}
