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

function BodyDetail({ body }: { body: string }) {
  return (
    <div className="space-y-1">
      <p className="m-0 text-label" style={{ color: "var(--fg-3)" }}>
        Body
      </p>
      {body.trim() ? (
        <Markdown>{body}</Markdown>
      ) : (
        <p className="m-0 text-body" style={{ color: "var(--fg-4)" }}>
          Empty.
        </p>
      )}
    </div>
  );
}

function PreviewFields({ resource }: { resource: ResourceRow }) {
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
      <BodyDetail body={str(p, "body")} />
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
  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{resource.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4" style={{ maxHeight: "70vh", overflowY: "auto" }}>
          <div>
            <Badge variant={resource.defaultEnabled === "recommended" ? "secondary" : "outline"}>
              {resource.defaultEnabled}
            </Badge>
          </div>
          <PreviewFields resource={resource} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
