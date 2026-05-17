import { deriveRepoLocalPath, type GitRepo } from "@agent-team-foundation/first-tree-hub-shared";
import { Plus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "../../components/ui/panel.js";
import { ListRow } from "./list-row.js";
import type { DraftListItem } from "./use-config-draft.js";

/**
 * Redesign §5.6 — Git Repositories list. Clone progress / mirror state are
 * deliberately hidden (implementation concerns, not product).
 */

export type GitSectionProps = {
  items: Array<DraftListItem<GitRepo>>;
  otherPaths: (exceptKey: string | null) => ReadonlySet<string>;
  onAdd: (value: GitRepo) => void;
  onUpdate: (key: string, value: GitRepo) => void;
  onDelete: (key: string) => void;
  onUndoDelete: (key: string) => void;
  disabled?: boolean;
};

export function GitSection(props: GitSectionProps) {
  const [dialog, setDialog] = useState<{ mode: "add" } | { mode: "edit"; key: string; initial: GitRepo } | null>(null);
  const activeCount = props.items.filter((i) => i.status !== "deleted").length;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Git repositories ({activeCount})</PanelTitle>
        {!props.disabled && (
          <Button size="xs" variant="outline" onClick={() => setDialog({ mode: "add" })}>
            <Plus className="h-3 w-3" /> Add
          </Button>
        )}
      </PanelHeader>
      <PanelBody className="space-y-2">
        {props.items.length === 0 ? (
          <p className="text-body text-muted-foreground">No Git repositories.</p>
        ) : (
          props.items.map((item) => {
            const path = item.value.localPath ?? deriveRepoLocalPath(item.value.url);
            return (
              <ListRow
                key={item.key}
                status={item.status}
                onEdit={() => setDialog({ mode: "edit", key: item.key, initial: item.value })}
                onDelete={() => props.onDelete(item.key)}
                onUndo={() => props.onUndoDelete(item.key)}
                disabled={props.disabled}
              >
                {/* URL is the primary long token (GitHub URLs run 60-120
                    chars); flex-1 + min-w-0 + truncate keeps it contained
                    inside the row instead of pushing past the page canvas. */}
                <span className="font-mono text-caption truncate min-w-0 flex-1" title={item.value.url}>
                  {item.value.url}
                </span>
                {item.value.ref && (
                  <span className="text-caption text-muted-foreground shrink-0">@ {item.value.ref}</span>
                )}
                <span
                  className="text-caption text-muted-foreground truncate min-w-0 max-w-xs"
                  title={`→ ${path || "./"}`}
                >
                  → {path || "./"}
                </span>
              </ListRow>
            );
          })
        )}
      </PanelBody>
      {dialog && (
        <GitDialog
          open={!!dialog}
          onOpenChange={(open) => !open && setDialog(null)}
          initial={dialog.mode === "edit" ? dialog.initial : null}
          forbiddenPaths={props.otherPaths(dialog.mode === "edit" ? dialog.key : null)}
          onSubmit={(value) => {
            if (dialog.mode === "edit") props.onUpdate(dialog.key, value);
            else props.onAdd(value);
            setDialog(null);
          }}
        />
      )}
    </Panel>
  );
}

type GitDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: GitRepo | null;
  forbiddenPaths: ReadonlySet<string>;
  onSubmit: (value: GitRepo) => void;
};

function GitDialog({ open, onOpenChange, initial, forbiddenPaths, onSubmit }: GitDialogProps) {
  const [url, setUrl] = useState(initial?.url ?? "");
  const [ref, setRef] = useState(initial?.ref ?? "");
  const [localPath, setLocalPath] = useState(initial?.localPath ?? "");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl(initial?.url ?? "");
    setRef(initial?.ref ?? "");
    setLocalPath(initial?.localPath ?? "");
    setErr(null);
  }, [open, initial]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setErr("URL is required.");
      return;
    }
    const path = localPath.trim() || deriveRepoLocalPath(trimmedUrl);
    if (path && forbiddenPaths.has(path)) {
      setErr(`Another repo already occupies local path "${path}".`);
      return;
    }
    const value: GitRepo = {
      url: trimmedUrl,
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      ...(localPath.trim() ? { localPath: localPath.trim() } : {}),
    };
    onSubmit(value);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit Git repository" : "Add Git repository"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="git-url">URL</Label>
            <Input
              id="git-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="git@github.com:org/repo.git"
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="git-ref">Ref (branch / tag / sha, optional)</Label>
            <Input
              id="git-ref"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="main"
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="git-path">Local path (optional)</Label>
            <Input
              id="git-path"
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder={deriveRepoLocalPath(url) || "repo-name"}
              className="font-mono"
            />
            <p className="text-caption text-muted-foreground">
              Relative to the session working directory. Leave empty to derive from the URL.
            </p>
          </div>
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
