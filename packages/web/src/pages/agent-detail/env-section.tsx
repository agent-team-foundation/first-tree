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
 * Delete offers a transient Undo via toast; restoring a deleted secret requires
 * re-entering its value (the ciphertext is gone — the placeholder is not the
 * real value).
 */

export type EnvSectionProps = {
  items: EnvEntry[];
  /** Persist the full next env array. `onSuccess` fires only after the server confirms. */
  onSave: (nextEnv: EnvEntry[], opts?: { onSuccess?: () => void }) => void;
  /** Disabled while a save is in flight or the agent is inactive. */
  disabled?: boolean;
  /** Flash "Saved" next to the title after a successful immediate write. */
  saved?: boolean;
};

type DialogState =
  | { mode: "add" }
  | { mode: "edit"; initial: EnvEntry }
  // Re-entry of a just-deleted secret (its ciphertext is unrecoverable).
  | { mode: "restore"; initial: EnvEntry }
  | null;

export function EnvSection({ items, onSave, disabled, saved }: EnvSectionProps) {
  const { addToast } = useToast();
  const [dialog, setDialog] = useState<DialogState>(null);
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
        addToast({
          title: `Removed ${entry.key}`,
          description: entry.sensitive ? "This was a secret — restoring needs its value re-entered." : undefined,
          action: {
            label: "Undo",
            onClick: () => {
              if (entry.sensitive) {
                // Ciphertext is gone; reopen the dialog so the value is re-entered.
                setDialog({ mode: "restore", initial: { key: entry.key, value: "", sensitive: true } });
              } else {
                onSave([...itemsRef.current, entry]);
              }
            },
          },
        });
      },
    });
  };

  const handleSubmit = (value: EnvEntry) => {
    if (!dialog) return;
    if (dialog.mode === "edit") {
      onSave(items.map((e) => (e.key === dialog.initial.key ? value : e)));
    } else {
      // add + restore both append (a restored entry is not in the list).
      onSave([...itemsRef.current, value]);
    }
    setDialog(null);
  };

  const action = !disabled ? (
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
                disabled={disabled}
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
          title={dialog.mode === "restore" ? "Re-enter secret value" : undefined}
          // Restore must take a fresh value (the ciphertext is gone); edit of a
          // persisted secret may leave it empty to keep the existing ciphertext.
          allowKeepExisting={dialog.mode === "edit" && canKeepExistingSensitiveValue(dialog.initial)}
          forbiddenKeys={keysExcept(dialog.mode === "edit" ? dialog.initial.key : null)}
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
  title?: string;
  allowKeepExisting: boolean;
  forbiddenKeys: ReadonlySet<string>;
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

function EnvDialog({ open, onOpenChange, initial, title, allowKeepExisting, forbiddenKeys, onSubmit }: EnvDialogProps) {
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title ?? (initial ? "Edit environment variable" : "Add environment variable")}</DialogTitle>
          <DialogDescription>Saved immediately when you submit.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="env-key">Key</Label>
            <Input
              id="env-key"
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              placeholder="OPENAI_API_KEY"
              className="font-mono"
              disabled={!!initial}
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
            />
          </div>
          <label className="flex items-center gap-2 text-body">
            <input
              type="checkbox"
              checked={sensitive}
              onChange={(e) => setSensitive(e.target.checked)}
              className="h-4 w-4"
              disabled={!!initial && initial.sensitive}
            />
            Mark as sensitive (encrypted at rest, never displayed again)
          </label>
          <p className="text-caption text-muted-foreground">
            Sensitive values cannot be viewed after saving. If you need to verify, save a new value.
          </p>
          {err && <p className="text-body text-destructive">{err}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">{initial ? "Done" : "Add"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
