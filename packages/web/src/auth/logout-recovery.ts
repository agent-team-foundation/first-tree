import type { ToastInput } from "../components/ui/toast.js";

type AddToast = (toast: ToastInput) => void;
export type RetryLogout = () => undefined | boolean | Promise<boolean>;
export const LOGOUT_INCOMPLETE_EVENT = "auth:logout-incomplete";

export function publishLogoutIncomplete(retry: RetryLogout): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LOGOUT_INCOMPLETE_EVENT, { detail: { retry } }));
  }
}

export function showLogoutIncompleteToast(addToast: AddToast, retry: RetryLogout): void {
  addToast({
    title: "Sign out incomplete",
    description: "Close other First Tree tabs and retry to finish clearing local data.",
    action: {
      label: "Retry",
      onClick: () => {
        void Promise.resolve(retry())
          .then((completed) => {
            if (completed !== true) showLogoutIncompleteToast(addToast, retry);
          })
          .catch(() => showLogoutIncompleteToast(addToast, retry));
      },
    },
    durationMs: null,
  });
}
