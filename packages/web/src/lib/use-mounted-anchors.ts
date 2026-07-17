import type { AgentMainStatus } from "@first-tree/shared";
import { useEffect, useState } from "react";

/**
 * Which `data-*-agent` attribute carries each status's timeline anchor.
 * Mirrors the anchors emitted by chat-view (ErrorRow / WorkingTurn) — see
 * `scrollToAgentTimeline`.
 */
const ANCHOR_ATTR = {
  working: "data-working-agent",
  failed: "data-error-agent",
} as const;

/** Stable key for the mounted-anchor set. */
export function anchorKey(main: AgentMainStatus, agentId: string): string {
  return `${main}:${agentId}`;
}

/**
 * Whether an agent's status can jump to the timeline right now — i.e. its
 * anchor is in the mounted set. Compose-rail jump affordances gate on this so
 * none can become a clickable no-op. Pure & exported for tests.
 */
export function isJumpable(mounted: ReadonlySet<string>, main: AgentMainStatus, agentId: string): boolean {
  return mounted.has(anchorKey(main, agentId));
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
 * Set of `${main}:${agentId}` for every timeline anchor currently mounted in
 * the DOM (working / failed). The compose activity rail gates its "jump to
 * timeline" affordance on this so a row is only clickable when its target is
 * actually present — no silent no-op.
 *
 * It's computed in an effect (never a render-time DOM read) and refreshed via a
 * MutationObserver, deduped so an unchanged set doesn't re-render. The scan is
 * DOM-driven on purpose: anchors come from multiple center-timeline row types
 * and a query keyed per-agent, so observing what's mounted is simpler and more
 * accurate than re-deriving from each source.
 *
 * ⚠️ Why a gate is needed at all: the chat timeline loads only the latest 50
 * messages (no pagination) and only the primary agent's session events, so a
 * non-primary agent's working/error anchor may not be
 * mounted. Full jump coverage (older messages / all agents) is a follow-up that
 * depends on message pagination + multi-agent event loading — out of scope here.
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
