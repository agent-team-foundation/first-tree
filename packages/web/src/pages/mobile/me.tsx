import type { MeMembership, OrgBrief } from "@first-tree/shared";
import { ChevronRight, ExternalLink, HelpCircle, Loader2, LogOut, Palette, Smartphone, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../auth/auth-context.js";
import { showLogoutIncompleteToast } from "../../auth/logout-recovery.js";
import { Avatar } from "../../components/avatar.js";
import { Button } from "../../components/ui/button.js";
import { ThemeToggle } from "../../components/ui/theme-toggle.js";
import { useOptionalToast } from "../../components/ui/toast.js";
import { captureBrowserStorageScope } from "../../lib/browser-storage-scope.js";
import { DISCORD_INVITE_URL } from "../../lib/community.js";
import { MobilePage, MobileSection, mobileCardStyle } from "./components.js";
import { InstallGuideSheet } from "./install-guide-sheet.js";
import { isStandalone } from "./install-guide-state.js";
import { useInstallPrompt } from "./use-install-guide.js";

export function MobileMePage() {
  const { user, teamDisplayName, role, logout } = useAuth();
  const { addToast } = useOptionalToast();
  const displayName = user?.displayName ?? "Signed-in user";
  const username = user?.username ?? "";
  const avatarSrc = user?.avatarUrl ?? null;

  return (
    <MobilePage className="flex flex-col" padded>
      <div className="flex items-center" style={{ gap: "var(--sp-3)", marginBottom: "var(--sp-5)" }}>
        <Avatar src={avatarSrc} name={displayName} seed={user?.id ?? displayName} size={48} />
        <div className="min-w-0" style={{ flex: 1 }}>
          <p className="text-mobile-title truncate" style={{ color: "var(--fg)", margin: 0 }}>
            {displayName}
          </p>
          {username ? (
            <p
              className="mono text-mobile-caption truncate"
              style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}
            >
              @{username}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
        <MobileSection title="Team">
          <MobilePanel>
            <MobileTeamSwitcher fallbackTeamName={teamDisplayName ?? "Current team"} fallbackRole={role} />
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

        <MobileInstallEntry />

        <MobileSection title="Support">
          <MobileExternalRow
            href={DISCORD_INVITE_URL}
            icon={<HelpCircle aria-hidden className="h-4 w-4" />}
            title="Community support"
            detail="Open the First Tree Discord."
          />
        </MobileSection>

        <Button
          type="button"
          variant="outline"
          className="min-h-11 justify-start"
          onClick={() => {
            const departingScope = captureBrowserStorageScope();
            let retryOperation: (() => Promise<"completed" | "incomplete" | "superseded">) | undefined;
            void Promise.resolve(logout({ scope: departingScope, onIncomplete: (retry) => (retryOperation = retry) }))
              .then((completed) => {
                if (completed === "incomplete" || completed === undefined) {
                  showLogoutIncompleteToast(
                    addToast,
                    retryOperation ?? (() => logout({ protectReplacementTokens: true, scope: departingScope })),
                  );
                }
              })
              .catch(() =>
                showLogoutIncompleteToast(
                  addToast,
                  retryOperation ?? (() => logout({ protectReplacementTokens: true, scope: departingScope })),
                ),
              );
          }}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </MobilePage>
  );
}

function MobileTeamSwitcher({
  fallbackTeamName,
  fallbackRole,
}: {
  fallbackTeamName: string;
  fallbackRole: string | null;
}) {
  const { memberships, currentMembership, organizationId, selectOrganization, switchingOrg, setSwitchingOrg } =
    useAuth();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  const switchTimerRef = useRef<number | null>(null);

  const currentOrg = useMemo<OrgBrief>(
    () => membershipToOrgBrief(currentMembership, organizationId, fallbackTeamName, fallbackRole),
    [currentMembership, fallbackRole, fallbackTeamName, organizationId],
  );
  const otherOrgs = useMemo(
    () =>
      memberships
        .filter((membership) => membership.organizationId !== currentOrg.id)
        .map((membership) => membershipToOrgBrief(membership)),
    [currentOrg.id, memberships],
  );

  useEffect(() => {
    if (!sheetOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sheetOpen]);

  useEffect(() => {
    return () => {
      if (switchTimerRef.current !== null) window.clearTimeout(switchTimerRef.current);
    };
  }, []);

  const closeSheet = () => {
    setSheetOpen(false);
    setSwitchError(null);
  };

  const handleSwitch = async (org: OrgBrief) => {
    if (org.id === organizationId || switchingOrg || busyOrgId) return;
    setSwitchError(null);
    setBusyOrgId(org.id);
    setSwitchingOrg(org);
    try {
      await selectOrganization(org.id);
      closeSheet();
      if (switchTimerRef.current !== null) window.clearTimeout(switchTimerRef.current);
      switchTimerRef.current = window.setTimeout(() => {
        switchTimerRef.current = null;
        setSwitchingOrg(null);
      }, 300);
    } catch (err) {
      setSwitchingOrg(null);
      setSwitchError(err instanceof Error ? err.message : "Couldn't switch - try again");
    } finally {
      setBusyOrgId(null);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        aria-label={`Change team, current: ${currentOrg.displayName}`}
        onClick={() => setSheetOpen(true)}
        className="flex w-full items-center text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        style={{
          gap: "var(--sp-3)",
          margin: "calc(var(--sp-2) * -1)",
          padding: "var(--sp-2)",
          border: 0,
          borderRadius: "var(--radius-input)",
          background: "transparent",
          color: "var(--fg)",
          cursor: "pointer",
        }}
      >
        <Avatar seed={currentOrg.id} name={currentOrg.displayName} size={36} />
        <div className="min-w-0" style={{ flex: 1 }}>
          <p className="text-mobile-subtitle truncate" style={{ color: "var(--fg)", margin: 0 }}>
            {currentOrg.displayName}
          </p>
          <p className="text-mobile-body" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}>
            {currentOrg.role === "admin" ? "Admin" : "Member"}
          </p>
        </div>
        <span className="text-mobile-caption shrink-0" style={{ color: "var(--fg-3)" }}>
          Change team
        </span>
        <ChevronRight aria-hidden className="h-4 w-4 shrink-0" style={{ color: "var(--fg-4)" }} />
      </button>

      {sheetOpen ? (
        <div className="fixed inset-0 z-50 flex items-end" data-mobile-team-sheet-root>
          <button
            type="button"
            aria-label="Close team switcher"
            className="absolute inset-0 bg-overlay-scrim"
            onClick={closeSheet}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-team-sheet-title"
            data-mobile-team-sheet="true"
            className="relative z-10 w-full overflow-hidden border-t shadow-[var(--shadow-md)]"
            style={{
              maxHeight: "82vh",
              borderColor: "var(--border)",
              borderRadius: "var(--radius-dialog) var(--radius-dialog) 0 0",
              background: "var(--bg-raised)",
              padding: "var(--sp-4) var(--sp-4) calc(var(--sp-4) + env(safe-area-inset-bottom))",
            }}
          >
            <div className="flex items-center" style={{ gap: "var(--sp-3)", marginBottom: "var(--sp-4)" }}>
              <div className="min-w-0" style={{ flex: 1 }}>
                <h2
                  id="mobile-team-sheet-title"
                  className="text-mobile-title"
                  style={{ color: "var(--fg)", margin: 0 }}
                >
                  Team
                </h2>
                <p className="text-mobile-body" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}>
                  Switch workspace context for this device.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={closeSheet}
                className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-input)] border transition-colors hover:bg-[var(--bg-hover)]"
                style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            </div>

            <div className="overflow-y-auto" style={{ maxHeight: "calc(82vh - var(--sp-20))" }}>
              <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
                <section className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
                  <p className="text-mobile-caption uppercase" style={{ color: "var(--fg-4)", margin: 0 }}>
                    Current team
                  </p>
                  <div
                    className="flex items-center border"
                    style={{
                      gap: "var(--sp-3)",
                      borderColor: "var(--border)",
                      borderRadius: "var(--radius-panel)",
                      padding: "var(--sp-3)",
                      background: "var(--bg)",
                    }}
                  >
                    <Avatar seed={currentOrg.id} name={currentOrg.displayName} size={36} />
                    <div className="min-w-0" style={{ flex: 1 }}>
                      <p className="text-mobile-subtitle truncate" style={{ color: "var(--fg)", margin: 0 }}>
                        {currentOrg.displayName}
                      </p>
                      <p className="text-mobile-body" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}>
                        {currentOrg.role === "admin" ? "Admin" : "Member"}
                      </p>
                    </div>
                  </div>
                </section>

                <section className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
                  <p className="text-mobile-caption uppercase" style={{ color: "var(--fg-4)", margin: 0 }}>
                    Switch team
                  </p>
                  {otherOrgs.length > 0 ? (
                    <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
                      {otherOrgs.map((org) => {
                        const busy = busyOrgId === org.id || switchingOrg?.id === org.id;
                        return (
                          <button
                            key={org.id}
                            type="button"
                            disabled={!!switchingOrg || !!busyOrgId}
                            aria-busy={busy}
                            onClick={() => void handleSwitch(org)}
                            className="flex min-h-12 w-full items-center border text-left transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                            style={{
                              gap: "var(--sp-3)",
                              borderColor: "var(--border)",
                              borderRadius: "var(--radius-panel)",
                              padding: "var(--sp-3)",
                              background: "var(--bg)",
                              color: "var(--fg)",
                            }}
                          >
                            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center">
                              {busy ? (
                                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                              ) : (
                                <Avatar seed={org.id} name={org.displayName} size={36} />
                              )}
                            </span>
                            <span className="min-w-0" style={{ flex: 1 }}>
                              <span className="block truncate text-mobile-subtitle">{org.displayName}</span>
                              <span className="block text-mobile-body" style={{ color: "var(--fg-3)" }}>
                                {org.role === "admin" ? "Admin" : "Member"}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-mobile-body" style={{ color: "var(--fg-3)", margin: 0 }}>
                      You only belong to one team.
                    </p>
                  )}
                  {switchError ? (
                    <p className="text-mobile-body" style={{ color: "var(--state-error)", margin: 0 }}>
                      {switchError}
                    </p>
                  ) : null}
                </section>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

// Permanent "add to home screen" entry — always reachable even after the
// auto-guide is dismissed. Manual opens never count toward the auto-show cap.
function MobileInstallEntry() {
  const { mode, install } = useInstallPrompt();
  const standalone = useMemo(() => isStandalone(), []);
  const [open, setOpen] = useState(false);

  if (standalone || mode === null) return null;

  return (
    <>
      <MobileSection title="App">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center text-left transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            ...mobileCardStyle("panel"),
            gap: "var(--sp-3)",
            border: "var(--hairline) solid var(--border)",
            color: "var(--fg)",
            cursor: "pointer",
          }}
          data-mobile-card="panel"
        >
          <span className="shrink-0" style={{ color: "var(--fg-3)" }}>
            <Smartphone aria-hidden className="h-4 w-4" />
          </span>
          <div className="min-w-0" style={{ flex: 1 }}>
            <p className="text-mobile-subtitle" style={{ margin: 0 }}>
              Add to Home Screen
            </p>
            <p className="text-mobile-body" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}>
              Install First Tree as an app for instant, full-screen access.
            </p>
          </div>
          <ChevronRight aria-hidden className="h-4 w-4 shrink-0" style={{ color: "var(--fg-4)" }} />
        </button>
      </MobileSection>
      {open ? (
        <InstallGuideSheet
          mode={mode}
          onInstall={() => {
            void install().finally(() => setOpen(false));
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function membershipToOrgBrief(
  membership: MeMembership | null,
  organizationId?: string | null,
  fallbackName?: string,
  fallbackRole?: string | null,
): OrgBrief {
  const role = membership?.role ?? (fallbackRole === "admin" ? "admin" : "member");
  return {
    id: membership?.organizationId ?? organizationId ?? "current-team",
    name: membership?.organizationName ?? fallbackName ?? "Current team",
    displayName: membership?.organizationName ?? fallbackName ?? "Current team",
    role,
  };
}

function MobilePanel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        ...mobileCardStyle("panel"),
      }}
      data-mobile-card="panel"
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
        <p className="text-mobile-subtitle" style={{ color: "var(--fg)", margin: 0 }}>
          {title}
        </p>
        <p className="text-mobile-body" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}>
          {detail}
        </p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
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
        ...mobileCardStyle("panel"),
        gap: "var(--sp-3)",
        color: "var(--fg)",
        textDecoration: "none",
      }}
      data-mobile-card="panel"
    >
      <span className="shrink-0" style={{ color: "var(--fg-3)" }}>
        {icon}
      </span>
      <div className="min-w-0" style={{ flex: 1 }}>
        <p className="text-mobile-subtitle" style={{ margin: 0 }}>
          {title}
        </p>
        <p className="text-mobile-body" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}>
          {detail}
        </p>
      </div>
      <ExternalLink aria-hidden className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--fg-4)" }} />
    </a>
  );
}
