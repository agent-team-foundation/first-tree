import type { CreateTeamResource, ResourceRow, ResourceType } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import {
  createTeamResource,
  previewOrgResourceImpact,
  previewResourceImpact,
  updateResource,
} from "../../api/resources.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Popover } from "../../components/ui/popover.js";
import { Select, type SelectOption } from "../../components/ui/select.js";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "../../components/ui/sheet.js";
import { Textarea } from "../../components/ui/textarea.js";

// ─────────────────────────────────────────────────────────────────────────
// Shared types + constants
// ─────────────────────────────────────────────────────────────────────────

export const RESOURCE_TYPES: ResourceType[] = ["repo", "prompt", "skill", "mcp"];
const DEFAULT_MODES = ["available", "recommended"] as const;
const TRANSPORTS = ["stdio", "http", "sse"] as const;
type DefaultMode = (typeof DEFAULT_MODES)[number];
type Transport = (typeof TRANSPORTS)[number];

// Narrow a raw Select value back to its union without an `as` assertion — the
// control only emits provided option values, so the fallback never runs.
const asDefaultMode = (v: string): DefaultMode => DEFAULT_MODES.find((d) => d === v) ?? "available";
const asTransport = (v: string): Transport => TRANSPORTS.find((t) => t === v) ?? "stdio";

const DEFAULT_OPTIONS: SelectOption[] = [
  { value: "available", label: "Available", hint: "Agents opt in" },
  { value: "recommended", label: "Recommended", hint: "On by default" },
];
const TRANSPORT_OPTIONS: SelectOption[] = TRANSPORTS.map((t) => ({ value: t, label: t }));
// Mirrors MCP_NAME_PATTERN (agent-runtime-config.ts). Validated explicitly in
// JS rather than via the HTML `pattern` attr — `pattern` is compiled with the
// regex `v` flag by browsers and doesn't reliably block this character class.
const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function typeLabelPlural(type: ResourceType): string {
  if (type === "repo") return "Repos";
  if (type === "prompt") return "Prompts";
  if (type === "skill") return "Skills";
  return "MCP";
}

function typeLabelSingular(type: ResourceType): string {
  if (type === "repo") return "Repo";
  if (type === "prompt") return "Prompt";
  if (type === "skill") return "Skill";
  return "MCP";
}

// Safe reads off the `unknown` resource payload (for edit prefill).
function str(payload: unknown, key: string): string {
  if (payload && typeof payload === "object" && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return "";
}
function strList(payload: unknown, key: string): string[] {
  if (payload && typeof payload === "object" && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}
function record(payload: unknown, key: string): [string, string][] {
  if (payload && typeof payload === "object" && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (v && typeof v === "object") {
      return Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string");
    }
  }
  return [];
}
// Entries whose value is NOT a string — the string-only KeyValueField can't
// display these, so we preserve them untouched across an edit instead of
// dropping them (skill `metadata` is z.record(string, unknown)).
function nonStringRecord(payload: unknown, key: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (payload && typeof payload === "object" && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) if (typeof val !== "string") out[k] = val;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Editor open-state (owned by the page)
// ─────────────────────────────────────────────────────────────────────────

export type EditorState =
  | { mode: "create"; type: ResourceType }
  | { mode: "edit"; type: ResourceType; resource: ResourceRow };

// ─────────────────────────────────────────────────────────────────────────
// Add-resource menu — single, type-first entry (admin only)
// ─────────────────────────────────────────────────────────────────────────

export function AddResourceMenu({ onPick }: { onPick: (type: ResourceType) => void }) {
  return (
    <Popover
      align="end"
      trigger={({ open, toggle }) => (
        <Button size="sm" aria-expanded={open} onClick={toggle}>
          <Plus className="h-4 w-4" /> Add resource
        </Button>
      )}
    >
      {({ close }) => (
        <div style={{ padding: "var(--sp-1)", minWidth: "var(--sp-45)" }}>
          {RESOURCE_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className="flex w-full items-center text-left text-body transition-colors hover:bg-[var(--bg-hover)]"
              style={{
                gap: "var(--sp-2)",
                padding: "var(--sp-1_5) var(--sp-2)",
                borderRadius: "var(--radius-chip)",
                border: 0,
                background: "transparent",
                color: "var(--fg)",
                cursor: "pointer",
              }}
              onClick={() => {
                onPick(type);
                close();
              }}
            >
              {typeLabelSingular(type)}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Editor dispatcher — routes each type to its own form + surface
// ─────────────────────────────────────────────────────────────────────────

export function ResourceEditor({ state, onClose }: { state: EditorState; onClose: () => void }) {
  const queryClient = useQueryClient();
  const save = useResourceSave(state, () => {
    queryClient.invalidateQueries({ queryKey: ["team-resources"] });
    onClose();
  });

  if (state.type === "repo") return <RepoEditor state={state} save={save} onClose={onClose} />;
  if (state.type === "mcp") return <McpEditor state={state} save={save} onClose={onClose} />;
  if (state.type === "prompt") return <PromptEditor state={state} save={save} onClose={onClose} />;
  return <SkillEditor state={state} save={save} onClose={onClose} />;
}

// ─────────────────────────────────────────────────────────────────────────
// Save / preview hook — shared by every editor
// ─────────────────────────────────────────────────────────────────────────

type SaveApi = {
  submit: (payload: CreateTeamResource) => void;
  preview: (payload: CreateTeamResource) => void;
  saving: boolean;
  error: string | null;
  impact: string | null;
};

function useResourceSave(state: EditorState, onDone: () => void): SaveApi {
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: createTeamResource,
    onSuccess: onDone,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const updateMut = useMutation({
    mutationFn: (payload: CreateTeamResource) =>
      updateResource(state.mode === "edit" ? state.resource.id : "", {
        name: payload.name,
        defaultEnabled: payload.defaultEnabled,
        payload: payload.payload,
      }),
    onSuccess: onDone,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const previewMut = useMutation({
    // Edit must use the per-resource impact endpoint — the org endpoint only
    // simulates a brand-new recommended resource and under-reports changes to
    // an existing (e.g. available, already-bound) one.
    mutationFn: (payload: CreateTeamResource) => {
      const body = { type: payload.type, defaultEnabled: payload.defaultEnabled, payload: payload.payload };
      return state.mode === "edit" ? previewResourceImpact(state.resource.id, body) : previewOrgResourceImpact(body);
    },
    onSuccess: (r) =>
      setImpact(`${r.affectedAgentCount} agents affected, ${r.promptOverflowAgentCount} prompt overflows`),
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return {
    submit: (payload) => {
      setError(null);
      if (state.mode === "edit") updateMut.mutate(payload);
      else createMut.mutate(payload);
    },
    preview: (payload) => previewMut.mutate(payload),
    saving: createMut.isPending || updateMut.isPending,
    error,
    impact,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Shared field primitives
// ─────────────────────────────────────────────────────────────────────────

function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  required?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.hint ? (
        <p className="text-label" style={{ color: "var(--fg-3)", margin: 0 }}>
          {props.hint}
        </p>
      ) : null}
      <Input
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        className={props.mono ? "mono" : undefined}
        required={props.required}
      />
    </div>
  );
}

function FieldShell({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function DefaultModeField({ value, onChange }: { value: DefaultMode; onChange: (v: DefaultMode) => void }) {
  return (
    <FieldShell id="resource-default" label="Default">
      <Select
        id="resource-default"
        aria-label="Default mode"
        value={value}
        onChange={(v) => onChange(asDefaultMode(v))}
        options={DEFAULT_OPTIONS}
      />
    </FieldShell>
  );
}

/** Repeatable single-string rows (MCP stdio args). */
function StringListField({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        {values.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional rows, no stable id
          <div key={i} className="flex items-center" style={{ gap: "var(--sp-2)" }}>
            <Input
              value={v}
              className="mono"
              placeholder={placeholder}
              onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Remove ${label} row`}
              onClick={() => onChange(values.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="xs" onClick={() => onChange([...values, ""])}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Repeatable key/value rows (MCP headers, skill metadata). */
function KeyValueField({
  label,
  pairs,
  onChange,
}: {
  label: string;
  pairs: [string, string][];
  onChange: (next: [string, string][]) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        {pairs.map(([k, v], i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional rows, no stable id
          <div key={i} className="flex items-center" style={{ gap: "var(--sp-2)" }}>
            <Input
              value={k}
              className="mono"
              placeholder="key"
              onChange={(e) => onChange(pairs.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))}
            />
            <Input
              value={v}
              className="mono"
              placeholder="value"
              onChange={(e) => onChange(pairs.map((p, j) => (j === i ? [p[0], e.target.value] : p)))}
            />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Remove ${label} row`}
              onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="xs" onClick={() => onChange([...pairs, ["", ""]])}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      </div>
    </div>
  );
}

function pairsToRecord(pairs: [string, string][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) if (k.trim()) out[k.trim()] = v;
  return out;
}

// Shared footer (Cancel · Preview · Save) — reused by Dialog + Sheet editors.
function EditorFooter({
  save,
  payload,
  saveLabel,
  onCancel,
  localError,
}: {
  save: SaveApi;
  payload: () => CreateTeamResource;
  saveLabel: string;
  onCancel: () => void;
  /** Client-side validation message (blocks submit before the API call). */
  localError?: string | null;
}) {
  return (
    <>
      {save.impact ? (
        <p className="text-caption" style={{ color: "var(--fg-3)" }}>
          {save.impact}
        </p>
      ) : null}
      {localError || save.error ? (
        <p className="text-body" style={{ color: "var(--state-error)" }}>
          {localError ?? save.error}
        </p>
      ) : null}
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="button" variant="outline" onClick={() => save.preview(payload())}>
        Preview
      </Button>
      <Button type="submit" disabled={save.saving}>
        {saveLabel}
      </Button>
    </>
  );
}

type EditorProps = { state: EditorState; save: SaveApi; onClose: () => void };

function titleFor(state: EditorState): string {
  const verb = state.mode === "edit" ? "Edit" : "New";
  return `${verb} ${typeLabelSingular(state.type).toLowerCase()}`;
}

// ─────────────────────────────────────────────────────────────────────────
// repo / mcp — modal (Dialog)
// ─────────────────────────────────────────────────────────────────────────

function RepoEditor({ state, save, onClose }: EditorProps) {
  const init = state.mode === "edit" ? state.resource : null;
  const [name, setName] = useState(init?.name ?? "");
  const [url, setUrl] = useState(str(init?.payload, "url"));
  const [defaultBranch, setDefaultBranch] = useState(str(init?.payload, "defaultBranch"));
  const [mode, setMode] = useState<DefaultMode>(asDefaultMode(init?.defaultEnabled ?? "available"));

  const payload = (): CreateTeamResource => ({
    type: "repo",
    name: name.trim() || url.trim(),
    defaultEnabled: mode,
    payload: { url: url.trim(), ...(defaultBranch.trim() ? { defaultBranch: defaultBranch.trim() } : {}) },
  });

  return (
    <ModalEditor state={state} save={save} onClose={onClose} payload={payload}>
      <Field id="repo-name" label="Name" value={name} onChange={setName} placeholder="Resource name" />
      <Field
        id="repo-url"
        label="Repository URL"
        value={url}
        onChange={setUrl}
        placeholder="git@github.com:org/repo.git"
        mono
        required
      />
      <Field
        id="repo-branch"
        label="Default branch"
        hint="Optional — leave blank to use the repo default."
        value={defaultBranch}
        onChange={setDefaultBranch}
        placeholder="main"
        mono
      />
      <DefaultModeField value={mode} onChange={setMode} />
    </ModalEditor>
  );
}

function McpEditor({ state, save, onClose }: EditorProps) {
  const init = state.mode === "edit" ? state.resource : null;
  const initTransport = asTransport(str(init?.payload, "transport") || "stdio");
  // The editable field is the MCP server id (`payload.name`), NOT the outer
  // resource display name — they can differ (e.g. "Team tools" / "team-tools").
  // Prefill from payload.name so a migrated resource shows a valid id.
  const [name, setName] = useState(str(init?.payload, "name") || init?.name || "");
  const [transport, setTransport] = useState<Transport>(initTransport);
  const [command, setCommand] = useState(str(init?.payload, "command"));
  const [args, setArgs] = useState<string[]>(strList(init?.payload, "args"));
  const [url, setUrl] = useState(str(init?.payload, "url"));
  const [mode, setMode] = useState<DefaultMode>(asDefaultMode(init?.defaultEnabled ?? "available"));

  // The MCP server name is an identifier, validated server-side against
  // MCP_NAME_PATTERN; it doubles as both the resource name and payload.name.
  const payload = (): CreateTeamResource => {
    const serverName = name.trim() || "mcp";
    // Preserve the original display name on edit (the editor only exposes the
    // server id); on create the two start equal.
    const outerName = init ? init.name : serverName;
    if (transport === "stdio") {
      const cleanArgs = args.map((a) => a.trim()).filter(Boolean);
      return {
        type: "mcp",
        name: outerName,
        defaultEnabled: mode,
        payload: {
          name: serverName,
          transport: "stdio",
          command: command.trim(),
          ...(cleanArgs.length ? { args: cleanArgs } : {}),
        },
      };
    }
    // http / sse share a shape but each schema member pins a literal transport,
    // so branch to keep `transport` a single literal (no `as` needed). The
    // no-secret MCP schema deliberately omits headers (they can carry secrets),
    // so this editor doesn't collect them.
    if (transport === "http") {
      return {
        type: "mcp",
        name: outerName,
        defaultEnabled: mode,
        payload: { name: serverName, transport: "http", url: url.trim() },
      };
    }
    return {
      type: "mcp",
      name: outerName,
      defaultEnabled: mode,
      payload: { name: serverName, transport: "sse", url: url.trim() },
    };
  };

  // Block submit on an invalid server id, with a clear message (the server
  // would otherwise reject it with a raw regex error).
  const validate = (): string | null =>
    MCP_NAME_RE.test(name.trim() || "mcp") ? null : "Name must be letters, digits, _ or - (e.g. github), max 64 chars.";

  return (
    <ModalEditor state={state} save={save} onClose={onClose} payload={payload} validate={validate}>
      <Field
        id="mcp-name"
        label="Name"
        hint="Server id — letters, digits, _ or - (e.g. github)."
        value={name}
        onChange={setName}
        placeholder="github"
        mono
        required
      />
      <FieldShell id="mcp-transport" label="Transport">
        <Select
          id="mcp-transport"
          aria-label="MCP transport"
          value={transport}
          onChange={(v) => setTransport(asTransport(v))}
          options={TRANSPORT_OPTIONS}
          mono
        />
      </FieldShell>
      {transport === "stdio" ? (
        <>
          <Field
            id="mcp-command"
            label="Command"
            value={command}
            onChange={setCommand}
            placeholder="npx"
            mono
            required
          />
          <StringListField label="Args" values={args} onChange={setArgs} placeholder="--flag" />
        </>
      ) : (
        <Field
          id="mcp-url"
          label="URL"
          value={url}
          onChange={setUrl}
          placeholder="https://mcp.example.com/sse"
          mono
          required
        />
      )}
      <DefaultModeField value={mode} onChange={setMode} />
    </ModalEditor>
  );
}

function ModalEditor({
  state,
  save,
  onClose,
  payload,
  validate,
  children,
}: EditorProps & { payload: () => CreateTeamResource; validate?: () => string | null; children: ReactNode }) {
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = validate?.() ?? null;
    setLocalError(v);
    if (v) return;
    save.submit(payload());
  };
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{titleFor(state)}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {children}
          <DialogFooter>
            <EditorFooter
              save={save}
              payload={payload}
              saveLabel={state.mode === "edit" ? "Save" : "Create"}
              onCancel={onClose}
              localError={localError}
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// prompt / skill — side sheet (room for the markdown body)
// ─────────────────────────────────────────────────────────────────────────

function PromptEditor({ state, save, onClose }: EditorProps) {
  const init = state.mode === "edit" ? state.resource : null;
  const [name, setName] = useState(init?.name ?? "");
  const [description, setDescription] = useState(str(init?.payload, "description"));
  const [body, setBody] = useState(str(init?.payload, "body"));
  const [mode, setMode] = useState<DefaultMode>(asDefaultMode(init?.defaultEnabled ?? "available"));

  const payload = (): CreateTeamResource => ({
    type: "prompt",
    name: name.trim() || "Prompt",
    defaultEnabled: mode,
    payload: { body, ...(description.trim() ? { description: description.trim() } : {}) },
  });

  return (
    <SheetEditor state={state} save={save} onClose={onClose} payload={payload}>
      <Field id="prompt-name" label="Name" value={name} onChange={setName} placeholder="Prompt name" />
      <Field
        id="prompt-desc"
        label="Description"
        value={description}
        onChange={setDescription}
        placeholder="Short description"
      />
      <BodyField id="prompt-body" value={body} onChange={setBody} />
      <DefaultModeField value={mode} onChange={setMode} />
    </SheetEditor>
  );
}

function SkillEditor({ state, save, onClose }: EditorProps) {
  const init = state.mode === "edit" ? state.resource : null;
  // Editable field is the skill id (`payload.name`); prefill from it so an edit
  // round-trips the real skill name, not a divergent display name.
  const [name, setName] = useState(str(init?.payload, "name") || init?.name || "");
  const [namespace, setNamespace] = useState(str(init?.payload, "namespace"));
  const [description, setDescription] = useState(str(init?.payload, "description"));
  const [body, setBody] = useState(str(init?.payload, "body"));
  const [metadata, setMetadata] = useState<[string, string][]>(record(init?.payload, "metadata"));
  const [mode, setMode] = useState<DefaultMode>(asDefaultMode(init?.defaultEnabled ?? "available"));
  // Non-string metadata values aren't editable in the key/value UI; keep them
  // so an edit doesn't silently drop them.
  const preservedMeta = nonStringRecord(init?.payload, "metadata");

  const payload = (): CreateTeamResource => {
    const skillName = name.trim() || "skill";
    const outerName = init ? init.name : skillName; // preserve display name on edit
    return {
      type: "skill",
      name: outerName,
      defaultEnabled: mode,
      payload: {
        name: skillName,
        ...(namespace.trim() ? { namespace: namespace.trim() } : {}),
        description: description.trim() || skillName,
        body,
        metadata: { ...preservedMeta, ...pairsToRecord(metadata) },
      },
    };
  };

  return (
    <SheetEditor state={state} save={save} onClose={onClose} payload={payload}>
      <Field id="skill-name" label="Name" value={name} onChange={setName} placeholder="release-notes" mono />
      <Field
        id="skill-namespace"
        label="Namespace"
        hint="Optional."
        value={namespace}
        onChange={setNamespace}
        placeholder="team"
        mono
      />
      <Field
        id="skill-desc"
        label="Description"
        value={description}
        onChange={setDescription}
        placeholder="What this skill does"
      />
      <BodyField id="skill-body" value={body} onChange={setBody} />
      <KeyValueField label="Metadata" pairs={metadata} onChange={setMetadata} />
      <DefaultModeField value={mode} onChange={setMode} />
    </SheetEditor>
  );
}

function BodyField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <FieldShell id={id} label="Body">
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-64 resize-y mono"
        placeholder="Markdown…"
      />
    </FieldShell>
  );
}

function SheetEditor({
  state,
  save,
  onClose,
  payload,
  validate,
  children,
}: EditorProps & { payload: () => CreateTeamResource; validate?: () => string | null; children: ReactNode }) {
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = validate?.() ?? null;
    setLocalError(v);
    if (v) return;
    save.submit(payload());
  };
  return (
    <Sheet open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>{titleFor(state)}</SheetTitle>
        </SheetHeader>
        {/* Footer lives inside the form so the submit button actually submits;
            the body scrolls, the footer stays pinned at the sheet bottom. */}
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto">{children}</div>
          <SheetFooter className="shrink-0" style={{ marginTop: "var(--sp-4)" }}>
            <EditorFooter
              save={save}
              payload={payload}
              saveLabel={state.mode === "edit" ? "Save" : "Create"}
              onCancel={onClose}
              localError={localError}
            />
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
