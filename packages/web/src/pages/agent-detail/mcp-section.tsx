import type { McpServer } from "@agent-team-foundation/first-tree-hub-shared";
import { Plus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { ListRow } from "./list-row.js";
import type { DraftListItem } from "./use-config-draft.js";

/**
 * Redesign §5.6 — MCP Servers list. Add/Edit Dialog submits into the page
 * draft; actual persistence is deferred to the bottom Save Bar.
 */

export type McpSectionProps = {
  items: Array<DraftListItem<McpServer>>;
  otherNames: (exceptKey: string | null) => ReadonlySet<string>;
  onAdd: (value: McpServer) => void;
  onUpdate: (key: string, value: McpServer) => void;
  onDelete: (key: string) => void;
  onUndoDelete: (key: string) => void;
  disabled?: boolean;
};

export function McpSection(props: McpSectionProps) {
  const [dialog, setDialog] = useState<{ mode: "add" } | { mode: "edit"; key: string; initial: McpServer } | null>(
    null,
  );
  const activeCount = props.items.filter((i) => i.status !== "deleted").length;

  return (
    <section
      style={{
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: 6,
      }}
    >
      <header
        className="flex items-center justify-between"
        style={{ padding: "var(--sp-2_5) var(--sp-3_5)", borderBottom: "var(--hairline) solid var(--border-faint)" }}
      >
        <h3 className="text-body font-semibold" style={{ color: "var(--fg)" }}>
          MCP Servers ({activeCount})
        </h3>
        {!props.disabled && (
          <Button size="xs" variant="outline" onClick={() => setDialog({ mode: "add" })}>
            <Plus className="h-3 w-3" /> Add
          </Button>
        )}
      </header>
      <div className="px-4 py-3 space-y-2">
        {props.items.length === 0 ? (
          <p className="text-body text-muted-foreground">No MCP servers. Add one to extend the agent's tools.</p>
        ) : (
          props.items.map((item) => (
            <ListRow
              key={item.key}
              status={item.status}
              onEdit={() => setDialog({ mode: "edit", key: item.key, initial: item.value })}
              onDelete={() => props.onDelete(item.key)}
              onUndo={() => props.onUndoDelete(item.key)}
              disabled={props.disabled}
            >
              <span className="text-caption rounded bg-muted px-1.5 py-0.5 font-mono">{item.value.transport}</span>
              <span className="font-medium font-mono">{item.value.name}</span>
              <span className="text-caption text-muted-foreground truncate">{describeMcp(item.value)}</span>
            </ListRow>
          ))
        )}
      </div>

      {dialog && (
        <McpDialog
          open={!!dialog}
          onOpenChange={(open) => !open && setDialog(null)}
          initial={dialog.mode === "edit" ? dialog.initial : null}
          forbiddenNames={props.otherNames(dialog.mode === "edit" ? dialog.key : null)}
          onSubmit={(value) => {
            if (dialog.mode === "edit") props.onUpdate(dialog.key, value);
            else props.onAdd(value);
            setDialog(null);
          }}
        />
      )}
    </section>
  );
}

function describeMcp(m: McpServer): string {
  if (m.transport === "stdio") {
    const args = m.args?.length ? ` ${m.args.join(" ")}` : "";
    return `${m.command}${args}`;
  }
  return m.url;
}

type McpDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: McpServer | null;
  forbiddenNames: ReadonlySet<string>;
  onSubmit: (value: McpServer) => void;
};

function McpDialog({ open, onOpenChange, initial, forbiddenNames, onSubmit }: McpDialogProps) {
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">(initial?.transport ?? "stdio");
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.transport === "stdio" ? initial.command : "");
  const [argsText, setArgsText] = useState(
    initial?.transport === "stdio" && initial.args ? initial.args.join(" ") : "",
  );
  const [url, setUrl] = useState(
    initial && (initial.transport === "http" || initial.transport === "sse") ? initial.url : "",
  );
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTransport(initial?.transport ?? "stdio");
    setName(initial?.name ?? "");
    setCommand(initial?.transport === "stdio" ? initial.command : "");
    setArgsText(initial?.transport === "stdio" && initial.args ? initial.args.join(" ") : "");
    setUrl(initial && (initial.transport === "http" || initial.transport === "sse") ? initial.url : "");
    setErr(null);
  }, [open, initial]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.match(/^[a-z0-9][a-z0-9_-]{0,63}$/i)) {
      setErr("Name must start alphanumeric and contain only a-z0-9_-.");
      return;
    }
    if (forbiddenNames.has(name.toLowerCase())) {
      setErr(`Another MCP server is already named "${name}".`);
      return;
    }
    let value: McpServer;
    if (transport === "stdio") {
      if (!command.trim()) {
        setErr("stdio transport requires a command.");
        return;
      }
      const args = argsText
        .trim()
        .split(/\s+/)
        .filter((s) => s.length > 0);
      value = { name, transport: "stdio", command: command.trim(), ...(args.length ? { args } : {}) };
    } else {
      const parsed = url.trim();
      try {
        new URL(parsed);
      } catch {
        setErr("URL is not valid.");
        return;
      }
      value = { name, transport, url: parsed };
    }
    onSubmit(value);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit MCP server" : "Add MCP server"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="mcp-transport">Transport</Label>
            <select
              id="mcp-transport"
              value={transport}
              onChange={(e) => setTransport(e.target.value as "stdio" | "http" | "sse")}
              className="flex h-9 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-1 text-body shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="stdio">stdio (local subprocess)</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="playwright"
              className="font-mono"
            />
          </div>
          {transport === "stdio" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="mcp-command">Command</Label>
                <Input
                  id="mcp-command"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="/usr/local/bin/playwright-mcp"
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-args">Args (space-separated, optional)</Label>
                <Input
                  id="mcp-args"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder="--port 3000"
                  className="font-mono"
                />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="mcp-url">URL</Label>
              <Input
                id="mcp-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://internal.api/mcp"
                className="font-mono"
              />
            </div>
          )}
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
