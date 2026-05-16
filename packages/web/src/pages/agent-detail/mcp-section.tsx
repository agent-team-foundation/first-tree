import type { McpServer } from "@agent-team-foundation/first-tree-hub-shared";
import { Plus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { DenseBadge } from "../../components/ui/dense-badge.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { ConfigSection } from "./flat-section.js";
import { ListRow } from "./list-row.js";
import type { DraftListItem } from "./use-config-draft.js";

/**
 * Redesign §5.6 — MCP Servers list. Add/Edit Dialog submits into the page
 * draft; actual persistence is deferred to the bottom Save Bar.
 */

/** Runtime health of a single MCP tool entry. */
export type McpToolHealth = "working" | "error" | "unknown";

export type McpSectionProps = {
  items: Array<DraftListItem<McpServer>>;
  otherNames: (exceptKey: string | null) => ReadonlySet<string>;
  /**
   * Optional per-tool runtime-health lookup. Takes the MCP server name (case
   * sensitive) and returns its status. Leave undefined until a real runtime
   * health source is wired; the row will omit the health badge.
   */
  toolHealth?: (name: string) => McpToolHealth;
  onAdd: (value: McpServer) => void;
  onUpdate: (key: string, value: McpServer) => void;
  onDelete: (key: string) => void;
  onUndoDelete: (key: string) => void;
  disabled?: boolean;
};

function toolHealthBadgeTone(h: McpToolHealth): "accent" | "error" | "outline" {
  if (h === "working") return "accent";
  if (h === "error") return "error";
  return "outline";
}

export function McpSection(props: McpSectionProps) {
  const [dialog, setDialog] = useState<{ mode: "add" } | { mode: "edit"; key: string; initial: McpServer } | null>(
    null,
  );
  const activeCount = props.items.filter((i) => i.status !== "deleted").length;

  const action = !props.disabled ? (
    <Button size="xs" variant="outline" onClick={() => setDialog({ mode: "add" })}>
      <Plus className="h-3 w-3" /> Add
    </Button>
  ) : null;

  return (
    <ConfigSection eyebrow="tools" title="MCP servers" count={activeCount} action={action}>
      <div>
        {props.items.length === 0 ? (
          <p className="text-body text-muted-foreground" style={{ padding: "var(--sp-3) 0" }}>
            No MCP servers. Add one to extend the agent's tools.
          </p>
        ) : (
          props.items.map((item) => {
            const health: McpToolHealth | null = props.toolHealth
              ? item.status === "deleted"
                ? "unknown"
                : props.toolHealth(item.value.name)
              : null;
            return (
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
                {health && <DenseBadge tone={toolHealthBadgeTone(health)}>{health}</DenseBadge>}
                <span className="text-caption text-muted-foreground truncate">{describeMcp(item.value)}</span>
              </ListRow>
            );
          })
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
    </ConfigSection>
  );
}

function describeMcp(m: McpServer): string {
  if (m.transport === "stdio") {
    const args = m.args?.length
      ? ` ${m.args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`
      : "";
    return `${m.command}${args}`;
  }
  return m.url;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function formatMcpArgsInput(args: readonly string[] | undefined): string {
  return args?.length ? JSON.stringify(args, null, 2) : "";
}

export function parseMcpArgsText(text: string): ParseResult<string[] | undefined> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "Args must be a JSON array of strings." };
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    return { ok: false, error: "Args must be a JSON array of strings." };
  }
  return { ok: true, value: parsed };
}

export function formatMcpHeadersInput(headers: Record<string, string> | undefined): string {
  return headers && Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : "";
}

export function parseMcpHeadersText(text: string): ParseResult<Record<string, string> | undefined> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "Headers must be a JSON object with string values." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Headers must be a JSON object with string values." };
  }
  const entries = Object.entries(parsed);
  if (entries.some(([key, value]) => !key || typeof value !== "string")) {
    return { ok: false, error: "Headers must be a JSON object with string values." };
  }
  return { ok: true, value: entries.length > 0 ? Object.fromEntries(entries) : undefined };
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
    formatMcpArgsInput(initial?.transport === "stdio" ? initial.args : undefined),
  );
  const [url, setUrl] = useState(
    initial && (initial.transport === "http" || initial.transport === "sse") ? initial.url : "",
  );
  const [headersText, setHeadersText] = useState(
    formatMcpHeadersInput(
      initial && (initial.transport === "http" || initial.transport === "sse") ? initial.headers : undefined,
    ),
  );
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTransport(initial?.transport ?? "stdio");
    setName(initial?.name ?? "");
    setCommand(initial?.transport === "stdio" ? initial.command : "");
    setArgsText(formatMcpArgsInput(initial?.transport === "stdio" ? initial.args : undefined));
    setUrl(initial && (initial.transport === "http" || initial.transport === "sse") ? initial.url : "");
    setHeadersText(
      formatMcpHeadersInput(
        initial && (initial.transport === "http" || initial.transport === "sse") ? initial.headers : undefined,
      ),
    );
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
      const argsResult = parseMcpArgsText(argsText);
      if (!argsResult.ok) {
        setErr(argsResult.error);
        return;
      }
      value = {
        name,
        transport: "stdio",
        command: command.trim(),
        ...(argsResult.value ? { args: argsResult.value } : {}),
      };
    } else {
      const parsed = url.trim();
      try {
        new URL(parsed);
      } catch {
        setErr("URL is not valid.");
        return;
      }
      const headersResult = parseMcpHeadersText(headersText);
      if (!headersResult.ok) {
        setErr(headersResult.error);
        return;
      }
      value = { name, transport, url: parsed, ...(headersResult.value ? { headers: headersResult.value } : {}) };
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
                <Label htmlFor="mcp-args">Args (JSON array, optional)</Label>
                <p className="text-caption text-muted-foreground">
                  Each arg as a separate JSON string. Use this when an arg contains spaces or quotes.
                </p>
                <textarea
                  id="mcp-args"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder={'["--port", "3000"]'}
                  className="flex min-h-24 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-2 text-body font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            </>
          ) : (
            <>
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
              <div className="space-y-2">
                <Label htmlFor="mcp-headers">Headers (JSON object, optional)</Label>
                <p className="text-caption text-muted-foreground">
                  JSON object of request headers, for example auth headers required by the MCP server.
                </p>
                <textarea
                  id="mcp-headers"
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  placeholder={'{"Authorization": "Bearer ..."}'}
                  className="flex min-h-24 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-2 text-body font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            </>
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
