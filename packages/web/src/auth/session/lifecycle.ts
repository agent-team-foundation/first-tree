import type { ContentDatabaseRegistry } from "./content-barrier.js";
import { closeCoordinatorConnections } from "./coordinator.js";

type LifecycleEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type SessionLifecycleOptions = Readonly<{
  registry: ContentDatabaseRegistry;
  windowTarget?: LifecycleEventTarget;
  documentTarget?: LifecycleEventTarget & Readonly<{ visibilityState?: DocumentVisibilityState }>;
  onVeil?: () => void;
  onLegacyStorageScrub?: () => void;
  onLifecycleError?: (error: unknown) => void;
}>;

/**
 * Installs synchronous close/invalidation hooks. It never reveals UI; callers reconcile fresh
 * coordinator/server/view authority before removing their static veil.
 */
export function installSessionLifecycleHooks(options: SessionLifecycleOptions): () => void {
  const windowTarget = options.windowTarget ?? (typeof window === "undefined" ? undefined : window);
  const documentTarget = options.documentTarget ?? (typeof document === "undefined" ? undefined : document);

  const runSafetyHook = (callback: (() => void) | undefined): void => {
    try {
      callback?.();
    } catch (error) {
      options.onLifecycleError?.(error);
    }
  };
  const scrubAndVeil = (): void => {
    runSafetyHook(options.onVeil);
    runSafetyHook(options.onLegacyStorageScrub);
  };
  const onVisibilityChange = (): void => {
    if (documentTarget?.visibilityState !== "hidden") return;
    scrubAndVeil();
    options.registry.cancelPendingOpens();
    options.registry.closeAllHandles();
  };
  const onSuspend = (): void => {
    scrubAndVeil();
    options.registry.invalidateAllOperations();
    closeCoordinatorConnections();
  };

  windowTarget?.addEventListener("pagehide", onSuspend, { capture: true });
  documentTarget?.addEventListener("freeze", onSuspend, { capture: true });
  documentTarget?.addEventListener("visibilitychange", onVisibilityChange, { capture: true });

  return () => {
    windowTarget?.removeEventListener("pagehide", onSuspend, { capture: true });
    documentTarget?.removeEventListener("freeze", onSuspend, { capture: true });
    documentTarget?.removeEventListener("visibilitychange", onVisibilityChange, { capture: true });
  };
}
