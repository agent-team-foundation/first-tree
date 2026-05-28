import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";

/**
 * Create or edit a Kael adapter binding. The form is intentionally
 * agent-agnostic — callers pass the resolved `agentId` (and an `agentLabel`
 * for the dialog title). The agent picker lives in BindingsPage.
 */

export type BotBindingDraft = {
  platform: "kael";
  status: "active" | "inactive";
  credentials?: Record<string, unknown>;
};

export type BindingFormSubmit =
  | { kind: "create"; draft: Required<BotBindingDraft> }
  | { kind: "update"; status: "active" | "inactive"; credentials?: Record<string, unknown> };

export type BindingFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit mode: pass the row id; create mode: null. */
  editingId: number | null;
  initialStatus?: "active" | "inactive";
  /** Title context — usually the agent display name. */
  agentLabel: string;
  pending: boolean;
  errorMessage: string | null;
  onSubmit: (payload: BindingFormSubmit) => void;
};

const EMPTY_FORM = {
  status: "active" as "active" | "inactive",
  kaelUserId: "",
  kaelProjectId: "",
};

export function BindingFormDialog(props: BindingFormProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [credError, setCredError] = useState("");

  useEffect(() => {
    if (props.open) {
      setForm({ ...EMPTY_FORM, status: props.initialStatus ?? "active" });
      setCredError("");
    }
  }, [props.open, props.initialStatus]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setCredError("");

    if (!props.editingId && (!form.kaelUserId || !form.kaelProjectId)) {
      setCredError("User ID and Project ID are required");
      return;
    }

    const credentials =
      form.kaelUserId && form.kaelProjectId
        ? { kaelUserId: form.kaelUserId, kaelProjectId: form.kaelProjectId }
        : undefined;

    if (props.editingId) {
      props.onSubmit({
        kind: "update",
        status: form.status,
        ...(credentials ? { credentials } : {}),
      });
      return;
    }

    if (!credentials) return;
    props.onSubmit({
      kind: "create",
      draft: {
        platform: "kael",
        status: form.status,
        credentials,
      },
    });
  }

  const title = props.editingId ? `Edit Kael binding · ${props.agentLabel}` : `Bind Kael → ${props.agentLabel}`;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="kael-user-id">User ID{props.editingId ? " — leave empty to keep existing" : ""}</Label>
            <Input
              id="kael-user-id"
              value={form.kaelUserId}
              onChange={(e) => setForm({ ...form, kaelUserId: e.target.value })}
              placeholder="user_xxxxxxxx"
              className="font-mono"
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="kael-project-id">
              Project ID{props.editingId ? " — leave empty to keep existing" : ""}
            </Label>
            <Input
              id="kael-project-id"
              value={form.kaelProjectId}
              onChange={(e) => setForm({ ...form, kaelProjectId: e.target.value })}
              placeholder="proj_xxxxxxxx"
              className="font-mono"
              autoComplete="off"
            />
          </div>
          {!props.editingId && (
            <p className="text-body" style={{ color: "var(--fg-3)" }}>
              Agent Token will be created automatically when you save.
            </p>
          )}
          {credError && (
            <p className="text-body" style={{ color: "var(--state-error)" }}>
              {credError}
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="binding-status">Status</Label>
            <select
              id="binding-status"
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as "active" | "inactive" })}
              className="flex h-9 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-1 text-body shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </div>

          {props.errorMessage && (
            <div className="text-body" style={{ color: "var(--state-error)" }}>
              {props.errorMessage}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)} disabled={props.pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={props.pending}>
              {props.pending ? "Saving…" : props.editingId ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
