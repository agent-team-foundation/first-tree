import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { CalendarCheck, CircleUserRound, MessageSquareText, UsersRound } from "lucide-react";
import { TeamSwitcher } from "../../components/team-switcher.js";
import { cn } from "../../lib/utils.js";
import type { MobileChatSignal, MobileChatSignalTone } from "./data.js";

type MobileTopBarProps = {
  title: string;
  right?: ReactNode;
};

export function MobileTopBar({ title, right }: MobileTopBarProps) {
  return (
    <header
      className="shrink-0 grid items-center"
      style={{
        gridTemplateColumns: "var(--sp-12) minmax(0, 1fr) var(--sp-12)",
        minHeight: "var(--sp-12)",
        padding: "env(safe-area-inset-top) var(--sp-3) 0",
        borderBottom: "var(--hairline) solid var(--border)",
        background: "var(--bg-raised)",
      }}
    >
      <div className="flex items-center justify-start" style={{ minWidth: 0 }}>
        <TeamSwitcher variant="compact" redirectHomeOnSwitch={false} />
      </div>
      <div className="text-center text-title truncate" style={{ color: "var(--fg)" }}>
        {title}
      </div>
      <div className="flex items-center justify-end">{right}</div>
    </header>
  );
}

export function MobilePage({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn("min-h-full overflow-y-auto", className)}
      style={{
        padding: padded ? "var(--sp-4) var(--sp-4) var(--sp-6)" : undefined,
      }}
    >
      {children}
    </div>
  );
}

export function MobileSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
      <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
        <h2 className="text-subtitle" style={{ color: "var(--fg)", margin: 0 }}>
          {title}
        </h2>
        {count !== undefined ? (
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            {count}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function MobileSystemState({
  title,
  detail,
  tone = "idle",
}: {
  title: string;
  detail?: string;
  tone?: MobileChatSignalTone;
}) {
  return (
    <div
      className="flex min-h-[var(--sp-35)] flex-col items-center justify-center text-center"
      style={{ gap: "var(--sp-1)", color: toneColor(tone), padding: "var(--sp-6) var(--sp-4)" }}
    >
      <p className="text-subtitle" style={{ margin: 0, color: "var(--fg)" }}>
        {title}
      </p>
      {detail ? (
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}

export function MobileSignalChip({ signal }: { signal: MobileChatSignal }) {
  const color = toneColor(signal.tone);
  return (
    <span
      className="mono inline-flex items-center text-caption"
      style={{
        gap: "var(--sp-1)",
        color,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          width: "var(--sp-1_5)",
          height: "var(--sp-1_5)",
          borderRadius: "var(--radius-full)",
          background: color,
          flexShrink: 0,
        }}
      />
      {signal.label}
    </span>
  );
}

export function MobileBottomTabs({ attentionCount, unreadCount }: { attentionCount: number; unreadCount: number }) {
  const tabs = [
    { to: "/m/today", label: "Today", icon: CalendarCheck, badge: attentionCount },
    { to: "/m/chat", label: "Chat", icon: MessageSquareText, badge: unreadCount },
    { to: "/m/team", label: "Team", icon: UsersRound, badge: 0 },
    { to: "/m/me", label: "Me", icon: CircleUserRound, badge: 0 },
  ] as const;

  return (
    <nav
      aria-label="Mobile"
      className="shrink-0 grid"
      style={{
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        minHeight: "calc(var(--mobile-tabbar-height) + env(safe-area-inset-bottom))",
        padding: "var(--sp-1) var(--sp-2) env(safe-area-inset-bottom)",
        borderTop: "var(--hairline) solid var(--border)",
        background: "var(--bg-raised)",
      }}
    >
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) =>
            cn("relative flex min-h-[var(--sp-11)] flex-col items-center justify-center", !isActive && "opacity-70")
          }
          style={({ isActive }) => ({
            gap: "var(--sp-0_5)",
            color: isActive ? "var(--fg)" : "var(--fg-3)",
            textDecoration: "none",
          })}
        >
          {({ isActive }) => (
            <>
              <tab.icon aria-hidden size={18} strokeWidth={isActive ? 2.2 : 1.8} />
              <span className="text-label">{tab.label}</span>
              {tab.badge > 0 ? <MobileTabBadge count={tab.badge} /> : null}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function MobileTabBadge({ count }: { count: number }) {
  return (
    <span
      className="mono absolute text-caption"
      style={{
        top: "var(--sp-1)",
        right: "calc(50% - var(--sp-6))",
        minWidth: "var(--sp-3_5)",
        height: "var(--sp-3_5)",
        padding: "0 var(--sp-1)",
        borderRadius: "var(--radius-full)",
        background: "var(--state-needs-you)",
        color: "var(--fg-on-vivid)",
        lineHeight: "var(--sp-3_5)",
        textAlign: "center",
      }}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

function toneColor(tone: MobileChatSignalTone): string {
  switch (tone) {
    case "needs-you":
      return "var(--state-needs-you)";
    case "error":
      return "var(--state-error)";
    case "unread":
      return "var(--state-unread)";
    case "working":
      return "var(--state-working)";
    case "idle":
      return "var(--fg-3)";
  }
}
