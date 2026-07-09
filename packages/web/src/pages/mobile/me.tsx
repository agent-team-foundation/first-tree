import { ExternalLink, HelpCircle, LogOut, MonitorCog, Palette } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { Avatar } from "../../components/avatar.js";
import { TeamSwitcher } from "../../components/team-switcher.js";
import { Button } from "../../components/ui/button.js";
import { ThemeToggle } from "../../components/ui/theme-toggle.js";
import { MobilePage, MobileSection } from "./components.js";

export function MobileMePage() {
  const { user, teamDisplayName, role, logout } = useAuth();
  const displayName = user?.displayName ?? "Signed-in user";
  const username = user?.username ?? "";
  const avatarSrc = user?.avatarUrl ?? null;

  return (
    <MobilePage className="flex flex-col" padded>
      <div className="flex items-center" style={{ gap: "var(--sp-3)", marginBottom: "var(--sp-5)" }}>
        <Avatar src={avatarSrc} name={displayName} seed={user?.id ?? displayName} size={48} />
        <div className="min-w-0" style={{ flex: 1 }}>
          <p className="text-title truncate" style={{ color: "var(--fg)", margin: 0 }}>
            {displayName}
          </p>
          {username ? (
            <p className="mono text-caption truncate" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}>
              @{username}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
        <MobileSection title="Team">
          <MobilePanel>
            <div className="flex items-center" style={{ gap: "var(--sp-3)" }}>
              <div className="min-w-0" style={{ flex: 1 }}>
                <p className="text-subtitle truncate" style={{ color: "var(--fg)", margin: 0 }}>
                  {teamDisplayName ?? "Current team"}
                </p>
                <p className="text-body" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}>
                  {role === "admin" ? "Admin" : "Member"}
                </p>
              </div>
              <TeamSwitcher variant="compact" redirectHomeOnSwitch={false} />
            </div>
          </MobilePanel>
        </MobileSection>

        <MobileSection title="Preferences">
          <MobilePanel>
            <MobileSettingRow
              icon={<Palette aria-hidden className="h-4 w-4" />}
              title="Theme"
              detail="Use the same preference across mobile and desktop."
              action={<ThemeToggle />}
            />
          </MobilePanel>
        </MobileSection>

        <MobileSection title="More">
          <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
            <MobileLinkRow
              to="/settings/computers"
              icon={<MonitorCog aria-hidden className="h-4 w-4" />}
              title="Desktop settings"
              detail="Computers, resources, GitHub, and setup stay on desktop."
            />
            <MobileExternalRow
              href="https://first-tree.ai/support"
              icon={<HelpCircle aria-hidden className="h-4 w-4" />}
              title="Support"
              detail="Open help and product support."
            />
          </div>
        </MobileSection>

        <Button type="button" variant="outline" className="min-h-11 justify-start" onClick={logout}>
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </MobilePage>
  );
}

function MobilePanel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "var(--sp-3)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-dialog)",
        background: "var(--bg-raised)",
      }}
    >
      {children}
    </div>
  );
}

function MobileSettingRow({
  icon,
  title,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center" style={{ gap: "var(--sp-3)", minHeight: "var(--sp-11)" }}>
      <span className="shrink-0" style={{ color: "var(--fg-3)" }}>
        {icon}
      </span>
      <div className="min-w-0" style={{ flex: 1 }}>
        <p className="text-subtitle" style={{ color: "var(--fg)", margin: 0 }}>
          {title}
        </p>
        <p className="text-body" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}>
          {detail}
        </p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

function MobileLinkRow({
  to,
  icon,
  title,
  detail,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <Link
      to={to}
      className="flex items-center transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        minHeight: "var(--sp-16)",
        gap: "var(--sp-3)",
        padding: "var(--sp-3)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-dialog)",
        background: "var(--bg-raised)",
        color: "var(--fg)",
        textDecoration: "none",
      }}
    >
      <span className="shrink-0" style={{ color: "var(--fg-3)" }}>
        {icon}
      </span>
      <div className="min-w-0" style={{ flex: 1 }}>
        <p className="text-subtitle" style={{ margin: 0 }}>
          {title}
        </p>
        <p className="text-body" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}>
          {detail}
        </p>
      </div>
    </Link>
  );
}

function MobileExternalRow({
  href,
  icon,
  title,
  detail,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <a
      href={href}
      className="flex items-center transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        minHeight: "var(--sp-16)",
        gap: "var(--sp-3)",
        padding: "var(--sp-3)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-dialog)",
        background: "var(--bg-raised)",
        color: "var(--fg)",
        textDecoration: "none",
      }}
    >
      <span className="shrink-0" style={{ color: "var(--fg-3)" }}>
        {icon}
      </span>
      <div className="min-w-0" style={{ flex: 1 }}>
        <p className="text-subtitle" style={{ margin: 0 }}>
          {title}
        </p>
        <p className="text-body" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}>
          {detail}
        </p>
      </div>
      <ExternalLink aria-hidden className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--fg-4)" }} />
    </a>
  );
}
