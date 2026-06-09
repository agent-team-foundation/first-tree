import type { Agent } from "@first-tree/shared";
import { canManageAgentDetail } from "./access.js";

export type TabDef = { key: string; label: string; path: string };

// IA labels only. Routing `path` and the `key` (draft / deep-link mapping) are
// kept stable so existing URLs and SECTION_TO_TAB keep resolving.
const TAB_LABELS: Record<string, string> = {
  profile: "Profile",
  runtime: "Environment",
  prompt: "Instructions",
  capabilities: "Tools & skills",
  usage: "Usage",
};

/**
 * Single source of truth for WHICH tabs exist for an agent (key + path),
 * independent of label/order. `buildTabs` adds the display label on top, and the
 * agent switcher uses this to know whether a target agent supports the current
 * tab — so the two can never drift on tab availability.
 */
export function tabKeysFor(canEditConfig: boolean, isHuman: boolean): { key: string; path: string }[] {
  const tabs: { key: string; path: string }[] = [{ key: "profile", path: "profile" }];
  if (canEditConfig) {
    tabs.push(
      { key: "runtime", path: "runtime" },
      { key: "prompt", path: "prompt" },
      { key: "capabilities", path: "capabilities" },
    );
  } else if (!isHuman) {
    tabs.push({ key: "capabilities", path: "capabilities" });
  }
  // Usage is an observation surface, kept last; human-type agents have no token usage.
  if (!isHuman) {
    tabs.push({ key: "usage", path: "usage" });
  }
  return tabs;
}

export function buildTabs(canEditConfig: boolean, isHuman: boolean): TabDef[] {
  return tabKeysFor(canEditConfig, isHuman).map((t) => ({ ...t, label: TAB_LABELS[t.key] ?? t.key }));
}

/** Mirror of the shell's `canEditConfig` derivation, for any agent (e.g. switcher targets). */
export function canEditConfigFor(agent: Agent, memberId: string | null, role: string | null): boolean {
  return agent.type !== "human" && canManageAgentDetail(agent, memberId, role);
}

/**
 * Which tab PATH to open when switching to `agent`: keep the current tab when the
 * target supports it, else fall back to profile. (Some tabs render blank rather
 * than redirect for unsupported agents, so we resolve this up front.)
 */
export function resolveTabPath(
  agent: Agent,
  memberId: string | null,
  role: string | null,
  currentPath: string,
): string {
  const paths = tabKeysFor(canEditConfigFor(agent, memberId, role), agent.type === "human").map((t) => t.path);
  return paths.includes(currentPath) ? currentPath : "profile";
}
