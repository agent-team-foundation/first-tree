import { type Agent, AVATAR_COLOR_TOKENS, type AvatarColorToken, type UpdateAgent } from "@first-tree/shared";
import { Pencil } from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { deleteAgentAvatar, uploadAgentAvatar } from "../../api/agents.js";
import { resolveAvatarHue } from "../../components/chat/chat-row-avatar.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";
import { Section } from "../../components/ui/section.js";
import { ConfigRow } from "./flat-section.js";

/**
 * Appearance — manager-configurable avatar color + image.
 *
 * Color writes go through PATCH /agents/:uuid (`avatarColorToken`).
 * Image writes go through dedicated PUT/DELETE /agents/:uuid/avatar so the
 * raw bytes don't have to share a JSON envelope. The dialog applies image
 * mutations eagerly (no Save click needed) but defers the color change to
 * the Save button so the user can preview before committing.
 *
 * Render priority: image → color override + initial → hashed color + initial.
 */

const AVATAR_TARGET_SIZE = 256;
const ACCEPTED_INPUT_TYPES = "image/png,image/jpeg,image/webp";

export type AppearanceSectionProps = {
  agent: Agent;
  canEdit?: boolean;
  onSave: (patch: UpdateAgent) => Promise<void>;
  /** Re-fetch the agent after a mutation that bypasses the standard PATCH. */
  onRefresh?: () => Promise<void> | void;
};

function initial(s: string): string {
  return s.trim()[0]?.toUpperCase() ?? "?";
}

function AvatarPreview({ agent, size }: { agent: Agent; size: number }) {
  if (agent.avatarImageUrl) {
    return (
      <img
        src={agent.avatarImageUrl}
        alt={agent.displayName}
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", display: "block" }}
      />
    );
  }
  // dynamic: scales with avatar size; no fixed token applies
  const initialFontSize = Math.round(size * 0.42);
  return (
    <span
      aria-hidden="true"
      className="font-bold"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        background: resolveAvatarHue(agent.avatarColorToken, agent.uuid),
        color: "var(--fg-on-vivid)",
        fontSize: initialFontSize,
        lineHeight: 1,
        letterSpacing: "-0.02em",
        userSelect: "none",
      }}
    >
      {initial(agent.displayName)}
    </span>
  );
}

export function AppearanceSection({ agent, canEdit = true, onSave, onRefresh }: AppearanceSectionProps) {
  const [open, setOpen] = useState(false);
  const colorLabel =
    typeof agent.avatarColorToken === "string" && agent.avatarColorToken.length > 0 ? agent.avatarColorToken : "auto";

  const action =
    canEdit && agent.status === "active" ? (
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="h-3 w-3" /> Edit
      </Button>
    ) : null;

  return (
    <Section title="Appearance" action={action}>
      <ConfigRow
        label="Avatar"
        value={
          <span className="inline-flex items-center gap-3">
            <AvatarPreview agent={agent} size={40} />
            <span className="mono text-caption" style={{ color: "var(--fg-3)" }}>
              {agent.avatarImageUrl ? "custom image" : `color ${colorLabel}`}
            </span>
          </span>
        }
      />
      <ConfigRow label="Image" value={agent.avatarImageUrl ? "custom" : "none"} />
      <ConfigRow label="Color" value={<span className="font-mono">{colorLabel}</span>} />

      {canEdit && (
        <AppearanceEditDialog agent={agent} open={open} onOpenChange={setOpen} onSave={onSave} onRefresh={onRefresh} />
      )}
    </Section>
  );
}

type DialogProps = {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: UpdateAgent) => Promise<void>;
  onRefresh?: () => Promise<void> | void;
};

/**
 * Resize an uploaded image to a square `AVATAR_TARGET_SIZE`×`AVATAR_TARGET_SIZE`
 * WEBP via an offscreen canvas. We center-crop to a square first so portrait
 * / landscape sources land sensibly. Returns the resulting `Blob` ready for
 * upload. Throws when the source can't be decoded.
 */
async function resizeToSquareWebp(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Unable to decode the selected image."));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = Math.max(0, Math.round((img.naturalWidth - side) / 2));
    const sy = Math.max(0, Math.round((img.naturalHeight - side) / 2));

    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_TARGET_SIZE;
    canvas.height = AVATAR_TARGET_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context is unavailable in this browser.");
    ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_TARGET_SIZE, AVATAR_TARGET_SIZE);

    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/webp", 0.85));
    if (!blob) throw new Error("Failed to encode resized image to WEBP.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function AppearanceEditDialog({ agent, open, onOpenChange, onSave, onRefresh }: DialogProps) {
  const initialColor: AvatarColorToken | null = AVATAR_COLOR_TOKENS.find((t) => t === agent.avatarColorToken) ?? null;
  const [picked, setPicked] = useState<AvatarColorToken | null>(initialColor);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setPicked(initialColor);
      setError(null);
    }
  }, [open, initialColor]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSave({ avatarColorToken: picked });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file twice still fires `change`.
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const blob = await resizeToSquareWebp(file);
      await uploadAgentAvatar(agent.uuid, blob);
      await onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function onRemoveImage() {
    setError(null);
    setUploading(true);
    try {
      await deleteAgentAvatar(agent.uuid);
      await onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  const previewAgent: Agent = { ...agent, avatarColorToken: picked };
  const hasImage = !!agent.avatarImageUrl;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Appearance</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center gap-4">
            <AvatarPreview agent={previewAgent} size={64} />
            <AvatarPreview agent={previewAgent} size={32} />
            <span className="text-caption text-muted-foreground">Preview at 64 / 32 px</span>
          </div>

          <div className="space-y-2">
            <Label>Image</Label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_INPUT_TYPES}
                onChange={onFileChange}
                style={{ display: "none" }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || saving}
              >
                {uploading ? "Uploading…" : hasImage ? "Replace image" : "Upload image"}
              </Button>
              {hasImage && (
                <Button type="button" variant="ghost" size="sm" onClick={onRemoveImage} disabled={uploading || saving}>
                  Remove image
                </Button>
              )}
            </div>
            <p className="text-caption text-muted-foreground">
              PNG / JPEG / WEBP. The browser crops to a square and resizes to 256 × 256 WEBP before upload. An image
              takes precedence over the color below.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              <Swatch
                label="Auto"
                selected={picked === null}
                onClick={() => setPicked(null)}
                background={resolveAvatarHue(null, agent.uuid)}
                isAuto
              />
              {AVATAR_COLOR_TOKENS.map((token) => (
                <Swatch
                  key={token}
                  label={token}
                  selected={picked === token}
                  onClick={() => setPicked(token)}
                  background={`var(--avatar-${token})`}
                />
              ))}
            </div>
            <p className="text-caption text-muted-foreground">
              "Auto" falls back to a hash of the agent's id, matching the legacy default. The color is used as the
              background under the initial when no image is set.
            </p>
          </div>

          {error && <p className="text-body text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving || uploading}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || uploading}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Swatch({
  label,
  selected,
  onClick,
  background,
  isAuto,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  background: string;
  isAuto?: boolean;
}) {
  const size = 32;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={label}
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: "50%",
        background,
        border: selected ? "var(--hairline-bold) solid var(--fg)" : "var(--hairline) solid var(--border)",
        cursor: "pointer",
        padding: 0,
        outline: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {isAuto && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 4,
            borderRadius: "50%",
            background: "var(--bg-raised)",
            color: "var(--fg-3)",
            fontSize: 10,
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          A
        </span>
      )}
    </button>
  );
}
