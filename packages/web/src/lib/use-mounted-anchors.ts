import { useEffect, useState } from "react";

export type TimelineAnchorKind = "working" | "failed" | "reason";

/**
 * Which `data-*-agent` attribute carries each status's timeline anchor.
 * Mirrors the anchors emitted by chat-view (ErrorRow / WorkingTurn) — see
 * `scrollToAgentTimeline`.
 */
const ANCHOR_ATTR = {
  working: "data-working-agent",
  failed: "data-error-agent",
  reason: "data-status-reason-agent",
} as const;

/** Stable key for the mounted-anchor set. */
export function anchorKey(kind: TimelineAnchorKind, agentId: string): string {
  return `${kind}:${agentId}`;
}

/**
 * Whether an agent's status can jump to the timeline right now — i.e. its
 * anchor is in the mounted set. Compose-rail jump affordances gate on this so
 * none can become a clickable no-op. Pure & exported for tests.
 */
export function isJumpable(mounted: ReadonlySet<string>, kind: TimelineAnchorKind, agentId: string): boolean {
  return mounted.has(anchorKey(kind, agentId));
}

function scanAnchors(): Set<string> {
  const next = new Set<string>();
  for (const [main, attr] of Object.entries(ANCHOR_ATTR)) {
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      const id = el.getAttribute(attr);
      if (id) next.add(`${main}:${id}`);
    }
  }
  return next;
}

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Set of `${kind}:${agentId}` for every timeline anchor currently mounted in
 * the DOM (working / failed / status reason). The compose activity rail gates its "jump to
 * timeline" affordance on this so a row is only clickable when its target is
 * actually present — no silent no-op.
 *
 * It's computed in an effect (never a render-time DOM read) and refreshed via a
 * MutationObserver, deduped so an unchanged set doesn't re-render. The scan is
 * DOM-driven on purpose: anchors come from multiple center-timeline row types
 * and a query keyed per-agent, so observing what's mounted is simpler and more
 * accurate than re-deriving from each source.
 *
 * A gate is still needed because the chat timeline loads bounded message and
 * event windows, so older evidence may not be mounted.
 */
export function useMountedAnchors(): ReadonlySet<string> {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let raf = 0;
    const apply = () => {
      const next = scanAnchors();
      setKeys((prev) => (sameKeys(prev, next) ? prev : next));
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    };
    apply();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  return keys;
}
