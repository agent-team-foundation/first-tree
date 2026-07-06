import { createContext } from "react";

/**
 * The set of agents that currently have a live (un-ended) turn in the open
 * chat's timeline — i.e. a mounted WorkingTurn (session events since their last
 * `turn_end`). Provided by `ChatView` (which owns the timeline) and consumed by
 * every chat-scoped status surface — the roster (`AgentStatusPanel`), the
 * compose status bar, and the agent hovercard — so they reconcile the composite
 * against the visible turn from ONE source (`reconcileLiveTurn`) and can never
 * disagree with each other or with the timeline.
 *
 * A context rather than prop-drilling because the hovercard mounts from many
 * scattered entry points (roster rows, message avatars, message names); a
 * shared context makes every current and future entry point agree by
 * construction. Default = empty set, so any consumer rendered outside a
 * provider (tests, previews) simply renders the composite unchanged.
 */
export const LiveTurnAgentsContext = createContext<ReadonlySet<string>>(new Set());
