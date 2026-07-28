import { Check, Menu, Monitor, Share, SquarePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { trackEvent } from "../../analytics.js";
import { MobileInstallQr } from "../../components/mobile-install-promotion.js";
import { Button } from "../../components/ui/button.js";
import { readMobileInstallSource } from "../../lib/mobile-install.js";
import { isStandalone } from "./install-guide-state.js";
import { type InstallOutcome, useInstallPrompt } from "./use-install-guide.js";

const IOS_STEPS = [
  { label: "Tap Share in Safari", icon: Share },
  { label: "Choose Add to Home Screen", icon: SquarePlus },
  { label: "Open First Tree from your home screen", icon: Check },
] as const;

const ANDROID_STEPS = [
  { label: "Open your browser menu", icon: Menu },
  { label: "Choose Install app or Add to Home screen", icon: SquarePlus },
  { label: "Open First Tree from your home screen", icon: Check },
] as const;

export function MobileInstallPage() {
  const [searchParams] = useSearchParams();
  const source = readMobileInstallSource(searchParams.get("source"));
  const { platform, mode, install } = useInstallPrompt();
  const [installing, setInstalling] = useState(false);
  const [installOutcome, setInstallOutcome] = useState<InstallOutcome | null>(null);
  const [nativeUnavailable, setNativeUnavailable] = useState(false);
  const openedRef = useRef(false);

  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    trackEvent("mobile_install_page_opened", { source, platform });
  }, [platform, source]);

  if (isStandalone()) {
    return <Navigate to="/m/work" replace />;
  }

  const onInstall = async (): Promise<void> => {
    setInstalling(true);
    try {
      const outcome = await install();
      trackEvent("mobile_install_action", { source, platform, method: "native_prompt", outcome });
      setInstallOutcome(outcome);
      setNativeUnavailable(outcome === "unavailable");
    } catch {
      trackEvent("mobile_install_action", {
        source,
        platform,
        method: "native_prompt",
        outcome: "unavailable",
      });
      setInstallOutcome("unavailable");
      setNativeUnavailable(true);
    } finally {
      setInstalling(false);
    }
  };

  const isDesktop = platform === "other";
  const isNativeAndroid = platform === "android" && mode === "native" && !nativeUnavailable;
  const steps = platform === "ios" ? IOS_STEPS : ANDROID_STEPS;

  return (
    <main
      className="min-h-dvh-screen overflow-y-auto"
      style={{
        background: "var(--bg)",
        color: "var(--fg)",
        padding:
          "calc(var(--sp-5) + env(safe-area-inset-top)) var(--sp-4) calc(var(--sp-6) + env(safe-area-inset-bottom))",
      }}
    >
      <div className="mx-auto flex w-full max-w-md flex-col" style={{ gap: "var(--sp-6)" }}>
        <header className="flex flex-col items-center text-center" style={{ gap: "var(--sp-2)" }}>
          <img
            src="/icons/first-tree-pwa.svg"
            width={64}
            height={64}
            alt=""
            style={{ borderRadius: "var(--radius-panel)" }}
          />
          <div>
            <h1 className="text-headline" style={{ margin: 0 }}>
              {isDesktop ? "Open First Tree on your phone" : "Install First Tree"}
            </h1>
            <p className="text-body" style={{ margin: "var(--sp-2) 0 0", color: "var(--fg-3)" }}>
              {isDesktop
                ? "Scan this code with your phone camera."
                : "Keep your agent team one tap away, without the browser chrome."}
            </p>
          </div>
        </header>

        {isDesktop ? (
          <section className="flex flex-col items-center text-center" style={{ gap: "var(--sp-3)" }}>
            <MobileInstallQr source={source} className="h-56 w-56" />
            <p className="text-label" style={{ margin: 0, color: "var(--fg-3)" }}>
              The code contains only this public install link.
            </p>
          </section>
        ) : (
          <>
            {installOutcome === "accepted" ? (
              <section className="flex flex-col items-center text-center" style={{ gap: "var(--sp-3)" }}>
                <span
                  aria-hidden
                  className="inline-flex items-center justify-center rounded-[var(--radius-full)]"
                  style={{
                    width: "var(--sp-10)",
                    height: "var(--sp-10)",
                    background: "var(--brand-bg)",
                    color: "var(--brand)",
                  }}
                >
                  <Check className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-subtitle" style={{ margin: 0 }}>
                    First Tree is installed
                  </p>
                  <p className="text-label" style={{ margin: "var(--sp-1) 0 0", color: "var(--fg-3)" }}>
                    Open it from your home screen, then sign in once.
                  </p>
                </div>
              </section>
            ) : isNativeAndroid ? (
              <Button
                type="button"
                variant="cta"
                size="lg"
                className="w-full"
                disabled={installing}
                onClick={() => void onInstall()}
              >
                {installing ? "Opening installer…" : "Install First Tree"}
              </Button>
            ) : (
              <InstallSteps steps={steps} />
            )}

            {platform === "android" && (mode !== "native" || nativeUnavailable) ? (
              <p
                role={nativeUnavailable ? "status" : undefined}
                className="text-center text-label"
                style={{ margin: 0, color: "var(--fg-3)" }}
              >
                {nativeUnavailable
                  ? "The install prompt is not available yet. Use the browser menu above."
                  : "If your browser offers an install prompt, the install button will appear automatically."}
              </p>
            ) : null}

            <div
              className="flex items-start"
              style={{
                gap: "var(--sp-3)",
                paddingTop: "var(--sp-5)",
                borderTop: "var(--hairline) solid var(--border)",
              }}
            >
              <Monitor aria-hidden className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--fg-3)" }} />
              <div>
                <p className="text-subtitle" style={{ margin: 0 }}>
                  Sign in once after installation
                </p>
                <p className="text-label" style={{ margin: "var(--sp-1) 0 0", color: "var(--fg-3)" }}>
                  Use the same Google or GitHub account as on desktop. No setup is copied through the QR code.
                </p>
              </div>
            </div>

            <Button asChild variant="ghost" className="w-full">
              <Link to="/m/work">Continue in browser</Link>
            </Button>
          </>
        )}
      </div>
    </main>
  );
}

function InstallSteps({ steps }: { steps: ReadonlyArray<{ label: string; icon: typeof Share }> }) {
  return (
    <ol className="flex flex-col" style={{ gap: "var(--sp-1)", margin: 0, padding: 0, listStyle: "none" }}>
      {steps.map((step, index) => (
        <li
          key={step.label}
          className="flex items-center"
          style={{
            gap: "var(--sp-3)",
            padding: "var(--sp-3)",
            borderBottom: index === steps.length - 1 ? "none" : "var(--hairline) solid var(--border-faint)",
          }}
        >
          <span
            aria-hidden
            className="mono inline-flex shrink-0 items-center justify-center rounded-[var(--radius-full)] text-caption"
            style={{
              width: "var(--sp-7)",
              height: "var(--sp-7)",
              background: "var(--bg-sunken)",
              color: "var(--fg-3)",
            }}
          >
            {index + 1}
          </span>
          <step.icon aria-hidden className="h-4 w-4 shrink-0" style={{ color: "var(--fg-2)" }} />
          <span className="text-body">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}
