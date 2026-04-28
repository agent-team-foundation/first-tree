import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/auth-context.js";

const AUTO_OPEN_KEY = "onboarding:autoOpen";
const JOIN_PATH_KEY = "onboarding:joinPath";

type JoinPath = "solo" | "invite";
type WizardStep = "connect" | "create_agent" | "completed" | null;

type OnboardingContextValue = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  joinPath: JoinPath | null;
  step: WizardStep;
  shouldShowResumeCTA: boolean;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/**
 * Drives the onboarding modal's open state. Mount the provider once near
 * the top of the auth-required tree so EmptyState's [Resume setup] CTA
 * and the modal share a single state instance.
 *
 * Auto-open semantics: opens itself ONCE, immediately after OAuth
 * completion, by consuming a transient sessionStorage flag the
 * OAuth-complete page sets. After dismiss, modal stays closed in this
 * and all subsequent sessions until manually re-opened.
 *
 * Once `wizard.step === "completed"`, the flags are cleaned up so
 * stale state doesn't carry across an unrelated next sign-in.
 */
export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { wizardStep, isAuthenticated } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [joinPath, setJoinPath] = useState<JoinPath | null>(() => {
    const v = typeof window !== "undefined" ? window.sessionStorage.getItem(JOIN_PATH_KEY) : null;
    return v === "solo" || v === "invite" ? v : null;
  });

  // Auto-open once after OAuth completion.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (wizardStep === null || wizardStep === "completed") return;
    const flag = window.sessionStorage.getItem(AUTO_OPEN_KEY);
    if (flag === "1") {
      setIsOpen(true);
      window.sessionStorage.removeItem(AUTO_OPEN_KEY);
    }
  }, [isAuthenticated, wizardStep]);

  // Wizard completed → close modal + clean up flags.
  useEffect(() => {
    if (wizardStep === "completed") {
      setIsOpen(false);
      window.sessionStorage.removeItem(AUTO_OPEN_KEY);
      window.sessionStorage.removeItem(JOIN_PATH_KEY);
      setJoinPath(null);
    }
  }, [wizardStep]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      isOpen,
      open,
      close,
      joinPath,
      step: wizardStep,
      shouldShowResumeCTA: isAuthenticated && wizardStep !== null && wizardStep !== "completed" && !isOpen,
    }),
    [isOpen, open, close, joinPath, wizardStep, isAuthenticated],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboardingState(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    // Not inside a provider — most likely a public route. Return a
    // permanently-closed default so callers don't have to null-check.
    return {
      isOpen: false,
      open: () => {},
      close: () => {},
      joinPath: null,
      step: null,
      shouldShowResumeCTA: false,
    };
  }
  return ctx;
}
