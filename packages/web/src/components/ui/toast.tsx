import { X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * Minimal toast system — used for transient informational nudges (e.g.
 * "Setup hidden — resume any time in Settings → Setup"). Mount `<Toaster>`
 * once at the app root and call `useToast().addToast(...)` anywhere under
 * it. Auto-dismisses after `durationMs` (default 5s) unless the toast is
 * persistent (`durationMs: null`).
 *
 * Deliberately not a full-featured toast lib — single stack, no severity
 * variants, no queue limits. If those needs appear, swap in `sonner` or
 * the shadcn toast primitive.
 */

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type ToastInput = {
  title: string;
  description?: string;
  action?: ToastAction;
  /** Auto-dismiss after this many ms; `null` keeps it until manually closed. */
  durationMs?: number | null;
};

type Toast = ToastInput & { id: string };

type ToastContextValue = {
  addToast: (toast: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 5_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((input: ToastInput) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { ...input, id }]);
  }, []);

  const value: ToastContextValue = { addToast };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

export function useOptionalToast(): ToastContextValue {
  return useContext(ToastContext) ?? { addToast: () => undefined };
}

function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      // Bottom-right stack. Pointer-events isolated to children so the
      // outer container doesn't intercept clicks elsewhere on the page.
      style={{
        position: "fixed",
        bottom: "var(--sp-4)",
        right: "var(--sp-4)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
        pointerEvents: "none",
        maxWidth: 380,
      }}
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (toast.durationMs === null) return;
    const ms = toast.durationMs ?? DEFAULT_DURATION_MS;
    const timer = setTimeout(() => dismissRef.current(), ms);
    return () => clearTimeout(timer);
  }, [toast.durationMs]);

  return (
    <div
      role="status"
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--sp-2)",
        padding: "var(--sp-3) var(--sp-3_5)",
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-input)",
        boxShadow: "var(--shadow-md)",
        animation: "toast-slide-in 180ms ease-out",
      }}
    >
      <div className="flex-1 min-w-0" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)" }}>
        <p className="text-body font-medium" style={{ margin: 0, color: "var(--fg)" }}>
          {toast.title}
        </p>
        {toast.description ? (
          <p className="text-label" style={{ margin: 0, color: "var(--fg-3)" }}>
            {toast.description}
          </p>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
            className="text-label font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-raised)]"
            style={{
              alignSelf: "flex-start",
              marginTop: "var(--sp-1)",
              padding: 0,
              background: "transparent",
              border: "none",
              color: "var(--primary)",
              cursor: "pointer",
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-raised)]"
        style={{
          padding: "var(--sp-1)",
          background: "transparent",
          border: "none",
          borderRadius: "var(--radius-input)",
          cursor: "pointer",
          color: "var(--fg-4)",
          flexShrink: 0,
        }}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
