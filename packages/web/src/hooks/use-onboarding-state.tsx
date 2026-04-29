import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/auth-context.js";
import { ONBOARDING_BANNER_DISMISSED_KEY, ONBOARDING_JOIN_PATH_KEY } from "../utils/onboarding-flags.js";

type JoinPath = "solo" | "invite";
type WizardStep = "connect" | "create_agent" | "completed" | null;

type OnboardingContextValue = {
  /** Modal is open. Only changes via `openModal` / `closeModal` — no auto-open. */
  modalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
  /** Banner is shown — true iff onboarding incomplete AND user hasn't dismissed. */
  bannerVisible: boolean;
  /** Persistently mark the banner as dismissed. */
  dismissBanner: () => void;
  joinPath: JoinPath | null;
  step: WizardStep;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/**
 * Onboarding state provider. Two surfaces share this context:
 *
 *   - <OnboardingBanner /> — top-of-layout dismissible reminder; shown to
 *     users whose wizard step is not "completed" and who haven't dismissed.
 *   - <OnboardingModal />  — opened only by explicit user action (banner
 *     button, EmptyState "Resume setup"). Never auto-pops.
 *
 * Auto-popup was retired: it covered the workspace before the user could
 * see anything, was wrong for invite users (who joined an existing team
 * and might not need to install a CLI at all), and removed user agency.
 * The banner is the equivalent gentle entry point.
 */
export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { wizardStep, isAuthenticated } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(ONBOARDING_BANNER_DISMISSED_KEY) === "1";
  });
  const [joinPath, setJoinPath] = useState<JoinPath | null>(() => {
    const v = typeof window !== "undefined" ? window.sessionStorage.getItem(ONBOARDING_JOIN_PATH_KEY) : null;
    return v === "solo" || v === "invite" ? v : null;
  });

  // When wizard reaches completed, clean up persistent flags so a future
  // "incomplete" state (e.g. user deletes their client) gets a fresh banner.
  useEffect(() => {
    if (wizardStep === "completed") {
      setModalOpen(false);
      window.sessionStorage.removeItem(ONBOARDING_JOIN_PATH_KEY);
      window.localStorage.removeItem(ONBOARDING_BANNER_DISMISSED_KEY);
      setJoinPath(null);
      setBannerDismissed(false);
    }
  }, [wizardStep]);

  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => setModalOpen(false), []);
  const dismissBanner = useCallback(() => {
    window.localStorage.setItem(ONBOARDING_BANNER_DISMISSED_KEY, "1");
    setBannerDismissed(true);
  }, []);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      modalOpen,
      openModal,
      closeModal,
      bannerVisible: isAuthenticated && wizardStep !== null && wizardStep !== "completed" && !bannerDismissed,
      dismissBanner,
      joinPath,
      step: wizardStep,
    }),
    [modalOpen, openModal, closeModal, isAuthenticated, wizardStep, bannerDismissed, dismissBanner, joinPath],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboardingState(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    // Not inside a provider — most likely a public route. Return permanently-
    // closed defaults so callers don't have to null-check.
    return {
      modalOpen: false,
      openModal: () => {},
      closeModal: () => {},
      bannerVisible: false,
      dismissBanner: () => {},
      joinPath: null,
      step: null,
    };
  }
  return ctx;
}
