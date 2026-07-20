import type { ToastInput } from "../components/ui/toast.js";

type AddToast = (toast: ToastInput) => void;
type RetryLogout = () => undefined | boolean | Promise<boolean>;

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
