import type { ResourceRow } from "@first-tree/shared";
import type { ReactNode } from "react";
import { Badge } from "../../components/ui/badge.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Markdown } from "../../components/ui/markdown.js";

/**
 * Read-only detail view for a single team resource. Opened from the eye icon on
 * each row — visible to every member (not just admins), since it mutates
 * nothing. Renders straight from the row's `payload`; no extra fetch.
 *
 * prompt / skill bodies render as Markdown (the list only shows a one-line
 * summary); repo shows a clickable URL; mcp shows its transport/command config.
 * Per the design system, read-only content is plain labeled text — not wrapped
 * in a filled/bordered card (card chrome = interactivity).
 */

// Safe reads off the `unknown` resource payload (mirrors resource-editors.tsx).
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
function entries(payload: unknown, key: string): [string, string][] {
  if (payload && typeof payload === "object" && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (v && typeof v === "object") {
      return Object.entries(v).map(([k, val]) => [k, typeof val === "string" ? val : JSON.stringify(val)]);
    }
  }
  return [];
}

function Detail({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="m-0 text-label" style={{ color: "var(--fg-3)" }}>
        {label}
      </p>
      <div className={mono ? "text-body mono" : "text-body"} style={{ color: "var(--fg)", overflowWrap: "anywhere" }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Long skill / prompt bodies are authored as standalone documents, so their
 * markdown often opens with an H1 the size of a page title. Inside a dialog that
 * dwarfs the dialog's own title and wrecks the hierarchy. Clamp every heading
 * down to the dense in-app scale (h1 → subtitle, the rest → body) so the body
 * reads as content nested under the dialog title, not as a competing page.
 */
const PROSE_COMPACT = [
  "prose-headings:font-semibold",
  "prose-h1:text-subtitle prose-h1:mt-0",
  "prose-h2:text-body prose-h3:text-body prose-h4:text-body",
  "prose-h3:text-[color:var(--fg-2)] prose-h4:text-[color:var(--fg-2)]",
].join(" ");

function BodyDetail({ body }: { body: string }) {
  return body.trim() ? (
    <Markdown className={PROSE_COMPACT}>{body}</Markdown>
  ) : (
    <p className="m-0 text-body" style={{ color: "var(--fg-4)" }}>
      Empty.
    </p>
  );
}

// Whether this resource type carries a long markdown body that warrants its own
// scrollable region; repo / mcp are short field lists rendered in the header.
function bodyOf(resource: ResourceRow): string | null {
  if (resource.type === "skill" || resource.type === "prompt") {
    return str(resource.payload, "body");
  }
  return null;
}

function MetaFields({ resource }: { resource: ResourceRow }) {
  const p = resource.payload;
  if (resource.type === "repo") {
    const url = str(p, "url");
    const branch = str(p, "defaultBranch");
    return (
      <>
        {url ? (
          <Detail label="Repository URL" mono>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
              style={{ color: "var(--primary)" }}
            >
              {url}
            </a>
          </Detail>
        ) : null}
        <Detail label="Default branch" mono>
          {branch || "Repository default"}
        </Detail>
      </>
    );
  }
  if (resource.type === "mcp") {
    const transport = str(p, "transport");
    const command = str(p, "command");
    const args = strList(p, "args");
    const url = str(p, "url");
    return (
      <>
        <Detail label="Server id" mono>
          {str(p, "name") || resource.name}
        </Detail>
        <Detail label="Transport" mono>
          {transport || "stdio"}
        </Detail>
        {command ? (
          <Detail label="Command" mono>
            {command}
          </Detail>
        ) : null}
        {args.length ? (
          <Detail label="Args" mono>
            <div className="flex flex-col" style={{ gap: "var(--sp-0_5)" }}>
              {args.map((a, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional, read-only
                <span key={i}>{a}</span>
              ))}
            </div>
          </Detail>
        ) : null}
        {url ? (
          <Detail label="URL" mono>
            {url}
          </Detail>
        ) : null}
      </>
    );
  }
  // prompt / skill
  const description = str(p, "description");
  const namespace = str(p, "namespace");
  const meta = entries(p, "metadata");
  return (
    <>
      {resource.type === "skill" ? (
        <Detail label="Skill id" mono>
          {str(p, "name") || resource.name}
        </Detail>
      ) : null}
      {namespace ? (
        <Detail label="Namespace" mono>
          {namespace}
        </Detail>
      ) : null}
      {description ? <Detail label="Description">{description}</Detail> : null}
      {meta.length ? (
        <Detail label="Metadata" mono>
          <div className="flex flex-col" style={{ gap: "var(--sp-0_5)" }}>
            {meta.map(([k, v]) => (
              <span key={k}>
                {k}: {v}
              </span>
            ))}
          </div>
        </Detail>
      ) : null}
    </>
  );
}

export function ResourcePreviewDialog({ resource, onClose }: { resource: ResourceRow; onClose: () => void }) {
  const body = bodyOf(resource);
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      {/* Widen past the default max-w-lg and turn the content into a flex column
          capped at the viewport: the metadata header stays fixed while only the
          Body region below scrolls. Drop the base grid/padding/gap so each zone
          owns its own padding. */}
      <DialogContent
        aria-describedby={undefined}
        className="flex max-w-2xl flex-col gap-0 p-0"
        style={{ maxHeight: "80vh" }}
      >
        {/* When there's no Body region (repo / mcp), the metadata zone itself
            becomes the scroll container so a tall field list — e.g. an mcp with
            many Args rows — can't overflow the 80vh cap off-viewport. With a
            Body present, this stays a fixed header and the Body scrolls instead. */}
        <div className={body === null ? "min-h-0 flex-1 space-y-4 overflow-y-auto p-6" : "space-y-4 p-6"}>
          <DialogHeader>
            <DialogTitle className="text-title">{resource.name}</DialogTitle>
          </DialogHeader>
          <div>
            <Badge variant={resource.defaultEnabled === "recommended" ? "secondary" : "outline"}>
              {resource.defaultEnabled}
            </Badge>
          </div>
          <MetaFields resource={resource} />
        </div>
        {body !== null ? (
          <div
            className="min-h-0 flex-1 space-y-1 overflow-y-auto p-6 pt-4"
            style={{ borderTop: "var(--hairline) solid var(--border-faint)" }}
          >
            <p className="m-0 text-label" style={{ color: "var(--fg-3)" }}>
              Body
            </p>
            <BodyDetail body={body} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
