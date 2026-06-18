import { ENV_REDACTED_PLACEHOLDER, type EnvEntry } from "@first-tree/shared";
import { Eye, EyeOff, Lock, Plus } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Section } from "../../components/ui/section.js";
import { useToast } from "../../components/ui/toast.js";
import { ListRow } from "./list-row.js";
import { ResourceEmptyState } from "./resource-empty-state.js";
import { titleWithSemantics } from "./save-semantics.js";

/**
 * Redesign §5.6 — Environment Variables list. Every change saves IMMEDIATELY
 * (add / edit / delete each PATCH the full env array), like the rest of the page.
 * The dialog is the natural commit point — values are validated and an entry is
 * only formed on submit — so there is no per-keystroke save and no draft.
 *
 * Sensitive values never show plaintext once saved; an empty value in the edit
 * dialog means "keep the existing ciphertext" (stored as the `***` placeholder).
 * Deleting a non-secret offers a transient Undo via toast; a deleted secret
 * can't be undone (its ciphertext is gone), so the toast says so and the user
 * re-adds it with a fresh value.
 */

export type EnvSectionProps = {
  items: EnvEntry[];
  /** Persist the full next env array. `onSuccess` fires after the server confirms; `onError` on failure. */
  onSave: (nextEnv: EnvEntry[], opts?: { onSuccess?: () => void; onError?: () => void }) => void;
  /** The agent is inactive (suspended) — hide edit affordances. */
  disabled?: boolean;
  /** A config save is in flight — serialize edits and show the dialog's submit as pending. */
  saving?: boolean;
  /** Last save failure / conflict message, surfaced inside the open dialog. */
  saveError?: string | null;
  /** Flash "Saved" next to the title after a successful immediate write. */
  saved?: boolean;
};

type DialogState = { mode: "add" } | { mode: "edit"; initial: EnvEntry } | null;

export function EnvSection({ items, onSave, disabled, saving, saveError, saved }: EnvSectionProps) {
  const { addToast } = useToast();
  const [dialog, setDialog] = useState<DialogState>(null);
  // Edits are blocked while suspended, and serialized while a save is in flight
  // so a second edit can't race the config version.
  const busy = disabled || saving;
  // Per-row reveal of sensitive values. Only works for values that are still
  // plaintext in the cache (a just-added secret in the optimistic window before
  // the server response redacts it). Persisted sensitive values are stored as
  // ENV_REDACTED_PLACEHOLDER and cannot be revealed — we show a tooltip instead.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  // Latest items, read inside the Undo toast closure so a restore appends to the
  // current list rather than a snapshot captured at delete time.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const toggleReveal = (key: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const keysExcept = (exceptKey: string | null): ReadonlySet<string> =>
    new Set(items.filter((i) => i.key !== exceptKey).map((i) => i.key));

  const handleDelete = (entry: EnvEntry) => {
    const next = items.filter((e) => e.key !== entry.key);
    onSave(next, {
      onSuccess: () => {
        // A secret can't be restored — its ciphertext is gone — so offer honest
        // guidance instead of an Undo. A non-secret value IS recoverable, so its
        // Undo re-saves through the shell-level controller (works across tabs;
        // it doesn't touch this section's local state, which may be unmounted by
        // the time the toast is clicked).
        addToast({
          title: `Removed ${entry.key}`,
          description: entry.sensitive
            ? "It was a secret — its value can't be recovered. Re-add it to restore."
            : undefined,
          action: entry.sensitive ? undefined : { label: "Undo", onClick: () => onSave([...itemsRef.current, entry]) },
        });
      },
      // A row delete has no open dialog to host an inline error, so surface the
      // failure as a toast right here (the optimistic removal is rolled back).
      onError: () => {
        addToast({ title: `Couldn't remove ${entry.key}`, description: "The change wasn't saved — try again." });
      },
    });
  };

  const handleSubmit = (value: EnvEntry) => {
    if (!dialog) return;
    // edit replaces the row by key; add appends.
    const next =
      dialog.mode === "edit"
        ? items.map((e) => (e.key === dialog.initial.key ? value : e))
        : [...itemsRef.current, value];
    // Close only after the save confirms — a failed save (409 / network) keeps
    // the dialog open with the typed value intact, which matters most for
    // secrets (their ciphertext can't be recovered once lost).
    onSave(next, { onSuccess: () => setDialog(null) });
  };

  const action = !busy ? (
    <Button size="xs" variant="outline" onClick={() => setDialog({ mode: "add" })}>
      <Plus className="h-3.5 w-3.5" /> Add variable
    </Button>
  ) : null;

  return (
    <Section
      title={titleWithSemantics("Environment variables", saved)}
      count={items.length}
      description="Injected into this agent's runtime process. Sensitive values are encrypted and hidden after save."
      action={action}
    >
      <div>
        {items.length === 0 ? (
          <ResourceEmptyState>No environment variables configured.</ResourceEmptyState>
        ) : (
          items.map((item) => {
            const isSensitive = item.sensitive;
            const isPlaceholder = item.value === ENV_REDACTED_PLACEHOLDER;
            const canReveal = isSensitive && !isPlaceholder && !!item.value;
            const isRevealed = revealed.has(item.key);
            let rendered: ReactNode;
            if (!isSensitive) {
              rendered = item.value || <em>(empty)</em>;
            } else if (canReveal && isRevealed) {
              rendered = item.value;
            } else {
              rendered = "••••••";
            }
            return (
              <ListRow
                key={item.key}
                onEdit={() => setDialog({ mode: "edit", initial: item })}
                onDelete={() => handleDelete(item)}
                disabled={busy}
              >
                <span className="font-mono font-medium">{item.key}</span>
                <span className="font-mono text-caption text-muted-foreground truncate max-w-xs">{rendered}</span>
                {isSensitive && <Lock className="h-3 w-3 text-muted-foreground" aria-hidden />}
                {isSensitive && (
                  <button
                    type="button"
                    onClick={() => canReveal && toggleReveal(item.key)}
                    className="bg-transparent border-0 p-0 cursor-pointer inline-flex items-center text-muted-foreground rounded-[var(--radius-chip)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1"
                    title={
                      canReveal
                        ? isRevealed
                          ? "Hide value"
                          : "Reveal value"
                        : "Saved sensitive values can't be revealed. Edit to set a new value."
                    }
                    aria-label={isRevealed ? "Hide value" : "Reveal value"}
                    disabled={!canReveal}
                  >
                    {isRevealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                )}
              </ListRow>
            );
          })
        )}
      </div>
      {dialog && (
        <EnvDialog
          open={!!dialog}
          onOpenChange={(open) => !open && setDialog(null)}
          initial={dialog.mode === "add" ? null : dialog.initial}
          // Editing a persisted secret may leave the value empty to keep the
          // existing ciphertext; adding always requires a value.
          allowKeepExisting={dialog.mode === "edit" && canKeepExistingSensitiveValue(dialog.initial)}
          forbiddenKeys={keysExcept(dialog.mode === "edit" ? dialog.initial.key : null)}
          submitting={saving}
          saveError={saveError}
          onSubmit={handleSubmit}
        />
      )}
    </Section>
  );
}

type EnvDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: EnvEntry | null;
  allowKeepExisting: boolean;
  forbiddenKeys: ReadonlySet<string>;
  /** A save triggered by this dialog is in flight. */
  submitting?: boolean;
  /** Server-side save failure to show inside the dialog (the dialog stays open). */
  saveError?: string | null;
  onSubmit: (value: EnvEntry) => void;
};

export function canKeepExistingSensitiveValue(initial: EnvEntry): boolean {
  return initial.sensitive && initial.value === ENV_REDACTED_PLACEHOLDER;
}

export function envDialogInitialValue(initial: EnvEntry | null, allowKeepExisting: boolean) {
  if (!initial) return "";
  if (allowKeepExisting) return "";
  return initial.value;
}

export function resolveEnvDialogValue(input: {
  value: string;
  sensitive: boolean;
  allowKeepExisting: boolean;
}): { ok: true; value: string } | { ok: false; error: string } {
  if (input.sensitive && input.allowKeepExisting && !input.value) {
    return { ok: true, value: ENV_REDACTED_PLACEHOLDER };
  }
  if (input.sensitive && !input.value) {
    return { ok: false, error: "Value is required for sensitive entries." };
  }
  return { ok: true, value: input.value };
}

function EnvDialog({
  open,
  onOpenChange,
  initial,
  allowKeepExisting,
  forbiddenKeys,
  submitting,
  saveError,
  onSubmit,
}: EnvDialogProps) {
  const [key, setKey] = useState(initial?.key ?? "");
  const [value, setValue] = useState(envDialogInitialValue(initial, allowKeepExisting));
  const [sensitive, setSensitive] = useState(initial?.sensitive ?? false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKey(initial?.key ?? "");
    setValue(envDialogInitialValue(initial, allowKeepExisting));
    setSensitive(initial?.sensitive ?? false);
    setErr(null);
  }, [open, initial, allowKeepExisting]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!key.match(/^[A-Z][A-Z0-9_]*$/)) {
      setErr("Key must match /^[A-Z][A-Z0-9_]*$/.");
      return;
    }
    if (forbiddenKeys.has(key)) {
      setErr(`Another entry already uses key "${key}".`);
      return;
    }
    const resolved = resolveEnvDialogValue({ value, sensitive, allowKeepExisting });
    if (!resolved.ok) {
      setErr(resolved.error);
      return;
    }
    if (!sensitive && !initial && !value) {
      setErr("Value is required for non-sensitive entries.");
      return;
    }
    onSubmit({ key, value: resolved.value, sensitive });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // While a save is in flight, ignore EVERY dismiss path — the Radix close
        // (X), Escape, outside click, and Cancel all funnel through here. Closing
        // would unmount the form and lose the typed value (unrecoverable for a
        // secret); the dialog only closes on a confirmed save (via onSuccess).
        if (submitting && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit environment variable" : "Add environment variable"}</DialogTitle>
          <DialogDescription>Saved immediately when you submit.</DialogDescription>
        </DialogHeader>
        {/* Every input disables while a save is in flight (`submitting`), so a value
            typed in the pending window can't be silently dropped when the earlier
            request resolves and closes the dialog. */}
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="env-key">Key</Label>
            <Input
              id="env-key"
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              placeholder="OPENAI_API_KEY"
              className="font-mono"
              disabled={!!initial || submitting}
            />
            {initial && <p className="text-caption text-muted-foreground">Key can't be renamed — delete and re-add.</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="env-value">Value</Label>
            <Input
              id="env-value"
              type={sensitive ? "password" : "text"}
              autoComplete="new-password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                allowKeepExisting ? "Leave empty to keep existing value" : sensitive ? "new secret" : "value"
              }
              className="font-mono"
              disabled={submitting}
            />
          </div>
          <label className="flex items-center gap-2 text-body">
            <input
              type="checkbox"
              checked={sensitive}
              onChange={(e) => setSensitive(e.target.checked)}
              className="h-4 w-4"
              disabled={(!!initial && initial.sensitive) || submitting}
            />
            Mark as sensitive (encrypted at rest, never displayed again)
          </label>
          <p className="text-caption text-muted-foreground">
            Sensitive values cannot be viewed after saving. If you need to verify, save a new value.
          </p>
          {err && <p className="text-body text-destructive">{err}</p>}
          {!err && saveError && <p className="text-body text-destructive">{saveError}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : initial ? "Done" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
