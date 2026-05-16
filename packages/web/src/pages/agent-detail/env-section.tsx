import { ENV_REDACTED_PLACEHOLDER, type EnvEntry } from "@agent-team-foundation/first-tree-hub-shared";
import { Eye, EyeOff, Lock, Plus } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { ConfigSection } from "./flat-section.js";
import { ListRow } from "./list-row.js";
import type { DraftListItem } from "./use-config-draft.js";

/**
 * Redesign §5.6 — Environment Variables list. Sensitive values never show
 * plaintext once saved; an empty value in the edit dialog means "keep the
 * existing ciphertext" (stored as `***` placeholder).
 */

export type EnvSectionProps = {
  items: Array<DraftListItem<EnvEntry>>;
  otherKeys: (exceptKey: string | null) => ReadonlySet<string>;
  onAdd: (value: EnvEntry) => void;
  onUpdate: (key: string, value: EnvEntry) => void;
  onDelete: (key: string) => void;
  onUndoDelete: (key: string) => void;
  disabled?: boolean;
};

export function EnvSection(props: EnvSectionProps) {
  const [dialog, setDialog] = useState<{ mode: "add" } | { mode: "edit"; key: string; initial: EnvEntry } | null>(null);
  // Per-row reveal of sensitive values. Only works for values that still live
  // in the draft as plaintext (newly added or explicitly re-entered). Persisted
  // sensitive values are stored as ENV_REDACTED_PLACEHOLDER and cannot be
  // revealed — we show a tooltip instead.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleReveal = (key: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const activeCount = props.items.filter((i) => i.status !== "deleted").length;

  const action = !props.disabled ? (
    <Button size="xs" variant="outline" onClick={() => setDialog({ mode: "add" })}>
      <Plus className="h-3 w-3" /> Add
    </Button>
  ) : null;

  return (
    <ConfigSection eyebrow="resources" title="Environment variables" count={activeCount} action={action}>
      <div>
        {props.items.length === 0 ? (
          <p className="text-body text-muted-foreground" style={{ padding: "var(--sp-3) 0" }}>
            No environment variables.
          </p>
        ) : (
          props.items.map((item) => {
            const isSensitive = item.value.sensitive;
            const isPlaceholder = item.value.value === ENV_REDACTED_PLACEHOLDER;
            const canReveal = isSensitive && !isPlaceholder && !!item.value.value;
            const isRevealed = revealed.has(item.key);
            let rendered: ReactNode;
            if (!isSensitive) {
              rendered = item.value.value || <em>(empty)</em>;
            } else if (canReveal && isRevealed) {
              rendered = item.value.value;
            } else {
              rendered = "••••••";
            }
            return (
              <ListRow
                key={item.key}
                status={item.status}
                onEdit={() => setDialog({ mode: "edit", key: item.key, initial: item.value })}
                onDelete={() => props.onDelete(item.key)}
                onUndo={() => props.onUndoDelete(item.key)}
                disabled={props.disabled}
              >
                <span className="font-mono font-medium">{item.value.key}</span>
                <span className="font-mono text-caption text-muted-foreground truncate max-w-xs">{rendered}</span>
                {isSensitive && <Lock className="h-3 w-3 text-muted-foreground" aria-hidden />}
                {isSensitive && (
                  <button
                    type="button"
                    onClick={() => canReveal && toggleReveal(item.key)}
                    className="bg-transparent border-0 cursor-pointer inline-flex items-center text-muted-foreground"
                    title={
                      canReveal
                        ? isRevealed
                          ? "Hide value"
                          : "Reveal value"
                        : "Saved sensitive values can't be revealed. Edit to set a new value."
                    }
                    aria-label={isRevealed ? "Hide value" : "Reveal value"}
                    disabled={!canReveal}
                    style={{ padding: 0, opacity: canReveal ? 1 : 0.4 }}
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
          initial={dialog.mode === "edit" ? dialog.initial : null}
          allowKeepExisting={
            dialog.mode === "edit" &&
            canKeepExistingSensitiveValue(dialog.initial, props.items.find((item) => item.key === dialog.key)?.status)
          }
          forbiddenKeys={props.otherKeys(dialog.mode === "edit" ? dialog.key : null)}
          onSubmit={(value) => {
            if (dialog.mode === "edit") props.onUpdate(dialog.key, value);
            else props.onAdd(value);
            setDialog(null);
          }}
        />
      )}
    </ConfigSection>
  );
}

type EnvDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: EnvEntry | null;
  allowKeepExisting: boolean;
  forbiddenKeys: ReadonlySet<string>;
  onSubmit: (value: EnvEntry) => void;
};

export function canKeepExistingSensitiveValue(
  initial: EnvEntry,
  status: DraftListItem<EnvEntry>["status"] | undefined,
) {
  return initial.sensitive && initial.value === ENV_REDACTED_PLACEHOLDER && status !== undefined && status !== "added";
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

function EnvDialog({ open, onOpenChange, initial, allowKeepExisting, forbiddenKeys, onSubmit }: EnvDialogProps) {
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
          <DialogTitle>{initial ? "Edit environment variable" : "Add environment variable"}</DialogTitle>
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
