import { Check, Copy, Monitor } from "lucide-react";
import { useNavigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { useCopyFeedback } from "../../lib/use-copy-feedback.js";

function desktopSetupUrl(): string {
  if (typeof window === "undefined") return "/onboarding";
  const origin = window.location.origin;
  if (typeof origin !== "string" || !origin.startsWith("http")) return "/onboarding";
  return `${origin}/onboarding`;
}

export function MobileSetupHandoff() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const copyFeedback = useCopyFeedback();
  const setupUrl = desktopSetupUrl();

  const useAnotherAccount = (): void => {
    logout();
    navigate("/login", {
      replace: true,
      state: { from: { pathname: "/m/work", search: "", hash: "" } },
    });
  };

  return (
    <main
      className="grid min-h-dvh-screen place-items-center"
      style={{
        background: "var(--bg)",
        color: "var(--fg)",
        padding:
          "calc(var(--sp-6) + env(safe-area-inset-top)) var(--sp-4) calc(var(--sp-6) + env(safe-area-inset-bottom))",
      }}
    >
      <section className="flex w-full max-w-sm flex-col text-center" style={{ gap: "var(--sp-5)" }}>
        <span
          aria-hidden
          className="mx-auto inline-flex items-center justify-center rounded-[var(--radius-full)]"
          style={{
            width: "var(--sp-12)",
            height: "var(--sp-12)",
            background: "var(--bg-sunken)",
            color: "var(--fg-2)",
          }}
        >
          <Monitor className="h-5 w-5" />
        </span>

        <div>
          <h1 className="text-mobile-title" style={{ margin: 0 }}>
            Finish setup on desktop
          </h1>
          <p className="text-mobile-body" style={{ margin: "var(--sp-2) 0 0", color: "var(--fg-3)" }}>
            Finish the guided First Tree setup on a computer, then reopen the app here.
          </p>
        </div>

        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <Button type="button" onClick={() => void copyFeedback.copy(setupUrl)}>
            {copyFeedback.status === "copied" ? (
              <Check aria-hidden className="h-4 w-4" />
            ) : (
              <Copy aria-hidden className="h-4 w-4" />
            )}
            {copyFeedback.status === "copied"
              ? "Desktop setup link copied"
              : copyFeedback.status === "failed"
                ? "Copy failed"
                : "Copy desktop setup link"}
          </Button>
          <Button type="button" variant="ghost" onClick={useAnotherAccount}>
            Use another account
          </Button>
        </div>
      </section>
    </main>
  );
}
