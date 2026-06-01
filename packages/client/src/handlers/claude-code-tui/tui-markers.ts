/**
 * Magic strings the Claude Code TUI prints, centralised so future cosmetic
 * drift in the TUI is a single-point change. Each glyph (`❯`, `⏺`, `⎿`, `✻`)
 * is followed by a U+00A0 NBSP rather than ASCII space, so regexes use
 * `[\s ]` to match either.
 *
 * Verified against the claude binary observed during the tmux-runtime PoC
 * (see `experiments/tmux-claude-runtime/FINDINGS.md`).
 */

/** Pane shows this while a turn is in flight. Disappearance signals turn-end candidacy. */
export const WORKING_MARKER = "esc to interrupt";

/** Pane shows this while the AskUserQuestion selection menu is open. */
export const ASKUSER_MENU_FOOTER = "Enter to select";

/** Pane shows this after a successful `claude --dangerously-skip-permissions` start. */
export const READY_MARKER = "bypass permissions on";

/** Lines the user (or paste-buffer injection) put on screen. */
export const USER_RE = /^❯[\s ]/;

/** Lines the assistant emitted as visible reply text. */
export const ASSISTANT_RE = /^⏺[\s ]/;

/** Footer line claude prints below the latest assistant text — `✻ Churned for Ns`. */
export const FOOTER_RE = /^✻[\s ]/;

/** Tool-call box header inside the visible reply, e.g. `⏺ Bash(date +%s)`. */
export const TOOL_BOX_HEADER_RE = /^⏺[\s ]+[A-Za-z][A-Za-z0-9_-]*\([^)]*\)\s*$/;

/** Continuation line inside a tool-call box, e.g. `  ⎿ Result text`. */
export const TOOL_BOX_CONT_RE = /^\s+⎿\s/;

/** Tool name claude renders for the AskUser tool. */
export const ASKUSER_TOOL_NAME = "AskUserQuestion";

/** All tmux sessions we own start with this prefix; orphan sweep filters by it. */
export const TMUX_SESSION_PREFIX = "ftth-";

/** Sentinel claude writes to the transcript when a tool_use was cancelled via Escape. */
export const TOOL_INTERRUPT_SENTINEL = "[Request interrupted by user for tool use]";
