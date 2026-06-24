import { useEffect } from "react";
import { OfflineNotice, type OfflineNoticePhase } from "../components/chat/chat-offline-notice.js";

/**
 * DEV-only visual review for `ChatOfflineNotice` — the inline timeline notice
 * shown when you're awaiting a reply from an agent whose runtime is offline
 * (onboarding's "unanswered first chat" safety net, but general to any chat).
 *
 * The two phases of the production component are rendered directly via its
 * presentational `OfflineNotice`, inside a timeline-column mimic so placement
 * reads true. No backend / no auth — same DEV-only gating as the sibling
 * previews in `app.tsx`. Append `?theme=dark` to flip the theme.
 */
const VARIANTS: { name: string; subtitle: string; phase: OfflineNoticePhase }[] = [
  {
    name: "phase 1 · starting (grace window)",
    subtitle: "hopeful framing during a normal cold start — no action yet",
    phase: "starting",
  },
  {
    name: "phase 2 · offline (escalated)",
    subtitle: "agent overdue → leaving a task still works (it queues); reconnect to run it",
    phase: "offline",
  },
];

export function ChatOfflineNoticePreviewPage() {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const themeOverride = params.get("theme");
  useEffect(() => {
    if (themeOverride === "light" || themeOverride === "dark") {
      document.documentElement.classList.toggle("dark", themeOverride === "dark");
    }
  }, [themeOverride]);

  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", padding: "var(--sp-6)" }}>
      <div style={{ maxWidth: "clamp(40rem, 75%, 62rem)", margin: "0 auto" }}>
        <h1 className="text-title" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-1)" }}>
          ChatOfflineNotice — waiting on an offline agent
        </h1>
        <p className="text-body" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-6)" }}>
          DEV preview. Inline timeline notice (option A): when a reply is due from an agent whose runtime is offline, it
          surfaces where the reply would appear and routes to reconnect. Append <code>?theme=dark</code> to flip the
          theme.
        </p>
        <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
          {VARIANTS.map((v) => (
            <section key={v.phase} className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
              <div>
                <div className="text-label" style={{ color: "var(--fg-2)" }}>
                  {v.name}
                </div>
                <div className="text-caption" style={{ color: "var(--fg-4)" }}>
                  {v.subtitle}
                </div>
              </div>
              {/* Timeline-column mimic: a stand-in opening turn above so the
                  notice reads as sitting where the agent's reply would appear. */}
              <div
                style={{
                  padding: "var(--sp-2_5) var(--sp-6)",
                  background: "var(--bg)",
                  border: "var(--hairline) solid var(--border)",
                  borderRadius: "var(--radius-input)",
                }}
              >
                <div className="text-body" style={{ color: "var(--fg-2)", paddingBottom: "var(--sp-2)" }}>
                  First Tree · Welcome! Your agent will greet you here with a few first tasks to pick from.
                </div>
                <OfflineNotice phase={v.phase} agentName="gandy-assistant" onReconnect={() => undefined} />
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
