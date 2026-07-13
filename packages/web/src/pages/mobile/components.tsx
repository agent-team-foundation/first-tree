import { Activity, CircleUserRound, MessageSquareText, UsersRound } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { NavLink } from "react-router";
import { cn } from "../../lib/utils.js";
import type { MobileChatSignal, MobileChatSignalTone } from "./data.js";

type MobileTopBarProps = {
  title: string;
  right?: ReactNode;
};

export type MobileCardTier = "priorityFeed" | "feed" | "list" | "panel";

const BASE_CARD_STYLE = {
  border: "var(--hairline) solid var(--border)",
  borderRadius: "var(--radius-dialog)",
  background: "var(--bg-raised)",
} as const;

export function mobileCardStyle(tier: MobileCardTier): CSSProperties {
  switch (tier) {
    case "priorityFeed":
      return {
        ...BASE_CARD_STYLE,
        minHeight: "var(--sp-45)",
        padding: "var(--sp-4)",
      };
    case "feed":
      return {
        ...BASE_CARD_STYLE,
        minHeight: "var(--sp-35)",
        padding: "var(--sp-4)",
      };
    case "list":
      return {
        ...BASE_CARD_STYLE,
        minHeight: "calc(var(--sp-16) + var(--sp-6))",
        padding: "var(--sp-3_5)",
      };
    case "panel":
      return {
        ...BASE_CARD_STYLE,
        minHeight: "var(--sp-16)",
        padding: "var(--sp-3)",
      };
  }
}

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
      <div aria-hidden />
      <div className="text-center text-mobile-title truncate" style={{ color: "var(--fg)" }}>
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
      className={cn("h-full overflow-y-auto overscroll-y-contain", className)}
      style={{
        padding: padded ? "var(--sp-4) var(--sp-4) var(--sp-6)" : undefined,
      }}
    >
      {children}
    </div>
  );
}

export function MobileSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
      <div className="flex items-center" style={{ gap: "var(--sp-2)" }}>
        <h2 className="text-mobile-subtitle" style={{ color: "var(--fg)", margin: 0 }}>
          {title}
        </h2>
        {count !== undefined ? (
          <span className="mono text-mobile-caption" style={{ color: "var(--fg-4)" }}>
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
      <p className="text-mobile-subtitle" style={{ margin: 0, color: "var(--fg)" }}>
        {title}
      </p>
      {detail ? (
        <p className="text-mobile-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}

export function MobileSignalChip({ signal, label = signal.label }: { signal: MobileChatSignal; label?: string }) {
  const color = toneColor(signal.tone);
  return (
    <span
      className="mono inline-flex min-w-0 max-w-full items-center text-mobile-caption"
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
      <span className="truncate" data-mobile-signal-label>
        {label}
      </span>
    </span>
  );
}

export function MobileSegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex items-center" style={{ gap: "var(--sp-1)" }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
            className={cn(
              "text-mobile-caption cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              !active && "hover:bg-[var(--bg-hover)]",
            )}
            style={{
              padding: "var(--sp-1) var(--sp-2)",
              border: 0,
              borderRadius: "var(--radius-chip)",
              background: active ? "var(--bg-active)" : "transparent",
              color: active ? "var(--fg)" : "var(--fg-3)",
              cursor: active ? "default" : "pointer",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function MobileBottomTabs({ attentionCount, unreadCount }: { attentionCount: number; unreadCount: number }) {
  const tabs = [
    { to: "/m/now", label: "Now", icon: Activity, badge: attentionCount },
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
              <span className="text-mobile-label">{tab.label}</span>
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
      className="mono absolute text-mobile-caption"
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
      return "var(--fg-needs-you-strong)";
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
