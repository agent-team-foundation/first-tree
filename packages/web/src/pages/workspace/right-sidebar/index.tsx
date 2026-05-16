import { ChevronsLeft, ChevronsRight, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../../lib/utils.js";
import { AgentsSection } from "./agents-section.js";
import { GitHubSection } from "./github-section.js";

const COLLAPSE_STORAGE_KEY = "first-tree-hub:chat-right-sidebar:collapsed:v1";

function loadCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // localStorage may be unavailable (private mode); ignore quietly.
  }
}

/**
 * ChatRightSidebar — workspace right rail. Renders chat-scoped detail
 * panels (Agents, GitHub bindings) for the currently selected chat.
 *
 * Persists its collapsed state in `localStorage` rather than the URL so
 * a refresh keeps the user's preference without polluting deep-link
 * URLs (the URL already owns chat selection + doc-preview overlay).
 *
 * Returns `null` when no chat is selected — the rail is meaningless on
 * the draft/empty workspace state and an empty column would just
 * compress the main area.
 */
export function ChatRightSidebar({ selectedChatId }: { selectedChatId: string | null }) {
  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);

  useEffect(() => {
    saveCollapsed(collapsed);
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  if (!selectedChatId) return null;

  return (
    <aside
      aria-label="Chat details"
      className={cn("flex shrink-0 flex-col overflow-hidden transition-[width] duration-150")}
      style={{
        width: collapsed ? 44 : 320,
        background: "var(--bg-raised)",
        borderLeft: "var(--hairline) solid var(--border)",
      }}
    >
      <div
        className="flex shrink-0 items-center justify-between"
        style={{
          height: 52,
          padding: collapsed ? "0" : "0 var(--sp-2_5) 0 var(--sp-3)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      >
        {collapsed ? null : (
          <div className="text-subtitle" style={{ color: "var(--fg)" }}>
            Chat details
          </div>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand chat details" : "Collapse chat details"}
          aria-expanded={!collapsed}
          className={cn(
            "inline-flex items-center justify-center transition-colors hover:bg-[var(--bg-hover)]",
            collapsed && "mx-auto",
          )}
          style={{
            width: 30,
            height: 30,
            border: 0,
            background: "transparent",
            borderRadius: "var(--radius-input)",
            color: "var(--fg-2)",
            cursor: "pointer",
          }}
        >
          {collapsed ? <ChevronsLeft size={16} /> : <ChevronsRight size={16} />}
        </button>
      </div>

      {collapsed ? (
        <div className="flex flex-1 flex-col items-center" style={{ paddingTop: "var(--sp-2)", gap: "var(--sp-1)" }}>
          <button
            type="button"
            onClick={toggle}
            aria-label="Open Agents section"
            className="inline-flex items-center justify-center transition-colors hover:bg-[var(--bg-hover)]"
            style={{
              width: 32,
              height: 32,
              border: 0,
              background: "transparent",
              borderRadius: "var(--radius-input)",
              color: "var(--fg-2)",
              cursor: "pointer",
            }}
          >
            <Users size={16} />
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <AgentsSection chatId={selectedChatId} />
          <GitHubSection chatId={selectedChatId} />
        </div>
      )}
    </aside>
  );
}
