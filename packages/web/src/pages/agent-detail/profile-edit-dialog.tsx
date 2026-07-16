import {
  AGENT_VISIBILITY,
  type Agent,
  AVATAR_COLOR_TOKENS,
  type AvatarColorToken,
  identiconCells,
  type UpdateAgent,
} from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { deleteAgentAvatar, listAgents, uploadAgentAvatar } from "../../api/agents.js";
import { useAuth } from "../../auth/auth-context.js";
import { AgentChip } from "../../components/agent-chip.js";
import { resolveAvatarHue } from "../../components/chat/chat-row-avatar.js";
import { Identicon } from "../../components/identicon.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Select, type SelectOption } from "../../components/ui/select.js";
import { AVATAR_HUE_COUNT, avatarHueColor, fgOnVividColor } from "../../lib/avatar-hues.js";
import { useAgentIdentityMap } from "../../lib/use-agent-name-map.js";
import { AvatarPreview } from "./appearance-section.js";
import { useJustSaved } from "./save-semantics.js";

/**
 * One "Edit profile" dialog merging the former Identity and Appearance dialogs.
 * Every field saves on its own commit (immediate-save, like the rest of the
 * agent-detail page) — there is no Save button:
 *   - Identity / visibility / fallback color → a partial PATCH /agents/:uuid per
 *     field (`onSave`): display name on blur / Enter, the rest on change. Saves
 *     serialize — controls + Done disable while one is in flight — so partial
 *     PATCHes never race and the dialog never closes mid-save; a rejected save
 *     surfaces inline. Done just commits any pending name, then closes.
 *   - Avatar image → eager PUT/DELETE /agents/:uuid/avatar on pick/remove
 *     (raw bytes don't share the JSON envelope); never closes the dialog.
 */

const AVATAR_TARGET_SIZE = 256;
const ACCEPTED_INPUT_TYPES = "image/png,image/jpeg,image/webp";
/** Grid resolution for baked pixel avatars; matches the <Identicon> default. */
const PIXEL_GRID = 5;
/** How many random pixel-avatar candidates to offer per shuffle. */
const PIXEL_CANDIDATES = 5;

const VISIBILITY_LABELS = {
  [AGENT_VISIBILITY.ORGANIZATION]: "Visible to your team",
  [AGENT_VISIBILITY.PRIVATE]: "Private to you",
} as const;

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

/**
 * Bake an identicon into a WEBP blob for the avatar-image pipeline. Inverted
 * palette to match <Identicon>: the hue fills the tile, near-white blocks on
 * top. Rendered full-bleed so the image path (which clips to a circle) only
 * trims hue-coloured corners, never a block. Integer geometry avoids seams.
 * Colours are resolved from the live CSS tokens (see avatar-hues), so the baked
 * image matches the previewed candidate and never drifts from index.css.
 */
async function bakeIdenticonWebp(seed: string, hueIdx: number): Promise<Blob> {
  const size = AVATAR_TARGET_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is unavailable in this browser.");
  ctx.fillStyle = avatarHueColor(hueIdx);
  ctx.fillRect(0, 0, size, size);
  const cells = identiconCells(seed, PIXEL_GRID);
  const block = Math.floor(size / (PIXEL_GRID + 1));
  const margin = Math.round((size - block * PIXEL_GRID) / 2);
  ctx.fillStyle = fgOnVividColor();
  for (let y = 0; y < PIXEL_GRID; y++) {
    const row = cells[y];
    if (!row) continue;
    for (let x = 0; x < PIXEL_GRID; x++) {
      if (!row[x]) continue;
      ctx.fillRect(margin + x * block, margin + y * block, block, block);
    }
  }
  const blob: Blob | null = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/webp", 0.85));
  if (!blob) throw new Error("Failed to encode the pixel avatar to WEBP.");
  return blob;
}

export type ProfileEditDialogProps = {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: UpdateAgent) => Promise<void>;
  /** Re-fetch the agent after an eager image mutation that bypasses PATCH. */
  onRefresh?: () => Promise<void> | void;
  /** Called after a successful identity+color save (drives the section "Saved" tag). */
  onSaved?: () => void;
};

export function ProfileEditDialog({ agent, open, onOpenChange, onSave, onRefresh, onSaved }: ProfileEditDialogProps) {
  const { memberId, role, agentId } = useAuth();
  const resolveAgent = useAgentIdentityMap();
  const { justSaved, markSaved } = useJustSaved();

  const initialColor: AvatarColorToken | null = AVATAR_COLOR_TOKENS.find((t) => t === agent.avatarColorToken) ?? null;
  const [displayName, setDisplayName] = useState(agent.displayName);
  const [delegateMention, setDelegateMention] = useState(agent.delegateMention ?? "");
  const [visibility, setVisibility] = useState(agent.visibility);
  const [picked, setPicked] = useState<AvatarColorToken | null>(initialColor);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [pixelCandidates, setPixelCandidates] = useState<Array<{ seed: string; hueIdx: number }>>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const initializedFor = useRef<string | null>(null);
  // The display name we last issued a PATCH for — dedupes a blur + Done so the
  // same name change isn't saved twice.
  const savedNameRef = useRef(agent.displayName);
  // Synchronous in-flight guard: two quick clicks can fire before React re-renders
  // the disabled controls, so a ref (not lagging state) is what actually serializes
  // the partial PATCHes and prevents an older write landing after a newer one.
  const savingRef = useRef(false);
  // An in-flight display-name commit (or null). Done awaits THIS same commit
  // before closing, so a save a focused-input blur started still finishes — and
  // isn't fired a second time by the Done click.
  const pendingNameRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    if (!open) {
      initializedFor.current = null;
      return;
    }
    // Snapshot the form ONCE per (open, agent), not on every agent change. The
    // eager avatar upload/remove calls onRefresh, which swaps the agent prop
    // while the dialog is open — re-snapshotting here would silently wipe the
    // user's unsaved identity/color edits. The ref guards same-agent refreshes;
    // we still re-init on a fresh open or a switch to a different agent.
    if (initializedFor.current === agent.uuid) return;
    initializedFor.current = agent.uuid;
    setDisplayName(agent.displayName);
    savedNameRef.current = agent.displayName;
    setDelegateMention(agent.delegateMention ?? "");
    setVisibility(agent.visibility);
    setPicked(AVATAR_COLOR_TOKENS.find((t) => t === agent.avatarColorToken) ?? null);
    setSaveError(null);
    setNameError(null);
    setImageError(null);
    setPixelCandidates([]);
  }, [open, agent]);

  const isHuman = agent.type === "human";
  const canChangeVisibility = role === "admin" || agent.managerId === memberId;
  const canEditDelegate = isHuman && agent.uuid === agentId;
  const delegateIdentity = agent.delegateMention ? resolveAgent(agent.delegateMention) : null;
  // While any save (field PATCH or avatar upload) is in flight, every control and
  // Done disable — this serializes saves (no racing partial PATCHes) and keeps
  // the dialog open until the save settles (a rejected save always surfaces).
  const editsDisabled = saving || uploading;

  const assistantsQuery = useQuery({
    queryKey: ["agents-for-delegate", memberId],
    queryFn: async () => {
      const res = await listAgents({ limit: 100 });
      // Eligible delegates = your own active agents. Visibility is NOT a
      // filter: a private agent (your personal assistant) is the most natural
      // delegate, and the server already accepts it (validateDelegateMention
      // checks same-org only; webhook routing checks same-org + active). The
      // list endpoint returns your own private agents (agentVisibilityCondition
      // = org-visible OR managerId = you), so `managerId === memberId` is what
      // scopes this to agents you own.
      return res.items.filter((a) => a.type === "agent" && a.status === "active" && a.managerId === memberId);
    },
    enabled: open && canEditDelegate,
  });
  const delegateOptions: SelectOption[] = useMemo(
    () => [
      { value: "", label: "Remove delegate" },
      ...(assistantsQuery.data?.map((a) => ({
        value: a.uuid,
        label: a.displayName ? `${a.displayName} (@${a.name ?? a.uuid})` : a.name ? `@${a.name}` : a.uuid,
      })) ?? []),
    ],
    [assistantsQuery.data],
  );

  // Every field saves on its own commit (text on blur / Enter, selects + colour
  // on change) — consistent with the rest of the agent-detail page, which has no
  // Save button. Each save is a partial PATCH /agents/:uuid; the avatar image is
  // handled eagerly below, separately.
  async function saveField(patch: UpdateAgent): Promise<boolean> {
    // Serialize: ignore a new save while one is in flight, so overlapping partial
    // PATCHes can't race and leave the server with a stale value.
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaveError(null);
    setSaving(true);
    try {
      await onSave(patch);
      onSaved?.();
      markSaved();
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  // Display name is required, so it commits on blur / Enter (not per keystroke):
  // empty → inline error and no save; changed + valid → save. `savedNameRef`
  // dedupes so a blur immediately followed by Done doesn't fire the PATCH twice.
  async function commitName(): Promise<boolean> {
    const trimmed = displayName.trim();
    if (!trimmed) {
      setNameError("Display name is required.");
      return false;
    }
    setNameError(null);
    if (trimmed === savedNameRef.current) return true;
    // Track this commit so a racing Done click awaits the SAME save instead of
    // firing a second one. Advance the dedupe baseline only after the PATCH
    // succeeds (inside the chain, before it resolves) — a rejected save stays
    // retryable rather than being treated as already committed.
    const p = saveField({ displayName: trimmed }).then((ok) => {
      if (ok) savedNameRef.current = trimmed;
      return ok;
    });
    pendingNameRef.current = p;
    try {
      return await p;
    } finally {
      if (pendingNameRef.current === p) pendingNameRef.current = null;
    }
  }

  // Done commits a pending (valid, changed) name and waits for it before closing,
  // so a typed-but-not-yet-blurred name isn't lost; a rejected save keeps the
  // dialog open with its inline error.
  async function handleDone() {
    // A focused-input blur can start a name save just before this click. Await
    // THAT same in-flight commit (don't fire a second one); otherwise commit any
    // pending name here. Close only when the name actually persisted.
    const inflight = pendingNameRef.current;
    if (inflight) {
      if (await inflight) onOpenChange(false);
      return;
    }
    if (await commitName()) onOpenChange(false);
  }

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    setImageError(null);
    setUploading(true);
    // Pin the target uuid at click time so a mid-upload agent switch can't
    // retarget the write (the dialog would unmount, but the promise lives on).
    const uuid = agent.uuid;
    try {
      const blob = await resizeToSquareWebp(file);
      await uploadAgentAvatar(uuid, blob);
      await onRefresh?.();
    } catch (err) {
      setImageError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function onRemoveImage() {
    setImageError(null);
    setUploading(true);
    const uuid = agent.uuid;
    try {
      await deleteAgentAvatar(uuid);
      await onRefresh?.();
    } catch (err) {
      setImageError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  function rollPixelCandidates() {
    setImageError(null);
    setPixelCandidates(
      Array.from({ length: PIXEL_CANDIDATES }, () => ({
        seed: crypto.randomUUID(),
        hueIdx: Math.floor(Math.random() * AVATAR_HUE_COUNT),
      })),
    );
  }

  async function applyPixelAvatar(candidate: { seed: string; hueIdx: number }) {
    setImageError(null);
    setUploading(true);
    const uuid = agent.uuid;
    try {
      const blob = await bakeIdenticonWebp(candidate.seed, candidate.hueIdx);
      await uploadAgentAvatar(uuid, blob);
      await onRefresh?.();
      setPixelCandidates([]);
    } catch (err) {
      setImageError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  const previewAgent: Agent = { ...agent, avatarColorToken: picked };
  const hasImage = !!agent.avatarImageUrl;
  // The runtime/plan consequence must always be disclosed for a non-human
  // agent — org-visible means teammates can spend the OWNER's computer and
  // plan — but phrased for who actually pays: "your" only when the viewer owns
  // the agent, owner-relative wording when an admin edits another member's
  // agent. Human identities have no runtime, so they get the plain visibility
  // effect.
  const orgVisibleHelp = isHuman
    ? "Anyone on your team can @mention it and work with it."
    : agent.managerId === memberId
      ? "Anyone on your team can @mention it and start work with it — it runs on your computer and uses your plan."
      : "Anyone on your team can @mention it and start work with it — it runs on its owner's computer and uses their plan.";
  const visibilityHelp = canChangeVisibility
    ? visibility === AGENT_VISIBILITY.ORGANIZATION
      ? orgVisibleHelp
      : "Only this agent's owner can see and chat with it."
    : "Only the owner or an admin can change this agent's visibility.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void commitName();
          }}
          className="space-y-5"
        >
          {/* Identity */}
          <div className="space-y-2">
            <Label>Agent name</Label>
            <Input value={agent.name ? `@${agent.name}` : ""} disabled className="font-mono" />
            <p className="text-caption text-muted-foreground">
              Agent name is permanent after creation — used in @mentions and CLI commands.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-display">Display name</Label>
            <Input
              id="profile-display"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onBlur={() => void commitName()}
              disabled={editsDisabled}
              placeholder="How teammates see this agent"
              maxLength={200}
            />
            {nameError && <p className="text-caption text-destructive">{nameError}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-visibility">Visibility</Label>
            <Select
              id="profile-visibility"
              aria-label="Visibility"
              value={visibility}
              onChange={(v) => {
                if (savingRef.current) return;
                const next = v as typeof visibility;
                setVisibility(next);
                void saveField({ visibility: next });
              }}
              disabled={!canChangeVisibility || editsDisabled}
              options={[
                { value: AGENT_VISIBILITY.ORGANIZATION, label: VISIBILITY_LABELS[AGENT_VISIBILITY.ORGANIZATION] },
                { value: AGENT_VISIBILITY.PRIVATE, label: VISIBILITY_LABELS[AGENT_VISIBILITY.PRIVATE] },
              ]}
            />
            <p className="text-caption text-muted-foreground">{visibilityHelp}</p>
          </div>
          {isHuman && (
            <div className="space-y-2">
              <Label htmlFor="profile-delegate">Delegate Mention</Label>
              {canEditDelegate ? (
                <Select
                  id="profile-delegate"
                  aria-label="Delegate Mention"
                  value={delegateMention}
                  onChange={(v) => {
                    if (savingRef.current) return;
                    setDelegateMention(v);
                    void saveField({ delegateMention: v || null });
                  }}
                  options={delegateOptions}
                  searchable
                  disabled={editsDisabled}
                />
              ) : (
                <div className="flex h-9 w-full items-center rounded-[var(--radius-input)] border border-input bg-transparent px-3 text-body opacity-70">
                  {delegateIdentity ? (
                    <AgentChip name={delegateIdentity.name} displayName={delegateIdentity.displayName} />
                  ) : (
                    <span className="text-muted-foreground">No delegate</span>
                  )}
                </div>
              )}
              <p className="text-caption text-muted-foreground">
                {canEditDelegate
                  ? "Assistant that acts on behalf of this agent."
                  : "Only the member themselves can set their own delegate."}
              </p>
            </div>
          )}

          {/* Appearance */}
          <div className="space-y-2">
            <Label>Avatar</Label>
            <div className="flex items-center gap-3">
              <AvatarPreview agent={previewAgent} size={64} />
              <AvatarPreview agent={previewAgent} size={32} />
              <span className="text-caption text-muted-foreground">Large and compact surfaces</span>
            </div>
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
              PNG / JPEG / WEBP. Square images work best. An image takes precedence over the color below. Image changes
              save immediately.
            </p>
            {imageError && <p className="text-body text-destructive">{imageError}</p>}
          </div>
          {/* Pixel avatars are a non-human-agent identity. Human agents
              represent real people and use their GitHub avatar (resolved
              server-side via the backing user's avatar URL), so the
              pixel-avatar generator is hidden for them — offering it would let
              a baked identicon override the GitHub avatar. */}
          {!isHuman && (
            <div className="space-y-2">
              <Label>Pixel avatar</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={rollPixelCandidates}
                  disabled={uploading || saving}
                >
                  {pixelCandidates.length ? "Shuffle" : "Generate"}
                </Button>
                {pixelCandidates.map((candidate, index) => (
                  <button
                    key={candidate.seed}
                    type="button"
                    onClick={() => applyPixelAvatar(candidate)}
                    disabled={uploading || saving}
                    aria-label={`Use pixel avatar ${index + 1}`}
                    title="Use this pixel avatar"
                    className="rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1"
                    style={{
                      display: "inline-flex",
                      padding: 0,
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                    }}
                  >
                    <Identicon seed={candidate.seed} size={40} color={`var(--avatar-hue-${candidate.hueIdx})`} />
                  </button>
                ))}
              </div>
              <p className="text-caption text-muted-foreground">
                Generate five random pixel avatars and click one to use it. It saves as the avatar image immediately.
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              <Swatch
                label="Auto"
                selected={picked === null}
                onClick={() => {
                  if (savingRef.current) return;
                  setPicked(null);
                  void saveField({ avatarColorToken: null });
                }}
                background={resolveAvatarHue(null, agent.uuid)}
                isAuto
                disabled={editsDisabled}
              />
              {AVATAR_COLOR_TOKENS.map((token) => (
                <Swatch
                  key={token}
                  label={token}
                  selected={picked === token}
                  onClick={() => {
                    if (savingRef.current) return;
                    setPicked(token);
                    void saveField({ avatarColorToken: token });
                  }}
                  background={`var(--avatar-${token})`}
                  disabled={editsDisabled}
                />
              ))}
            </div>
            <p className="text-caption text-muted-foreground">
              Auto chooses a stable color for this agent. Used only when no image is set.
            </p>
          </div>

          {saveError && <p className="text-body text-destructive">{saveError}</p>}
          <DialogFooter>
            <span className="mr-auto self-center text-caption text-muted-foreground" aria-live="polite">
              {saving ? "Saving…" : justSaved ? "Saved" : null}
            </span>
            {/* preventDefault on mousedown keeps focus on a focused display-name
                input (so it doesn't blur), which means THIS click — not a racing
                blur-triggered save — owns the commit + close. Done then commits a
                pending name and closes only if it persisted; disabled while a save
                is in flight so the dialog never closes mid-PATCH. */}
            <Button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void handleDone()}
              disabled={editsDisabled}
            >
              Done
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
  disabled,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  background: string;
  isAuto?: boolean;
  disabled?: boolean;
}) {
  // Selection follows the OptionCard rule: the border stays the same faint
  // hairline in both states; selection is signalled by a filled neutral marker,
  // never a heavier/darker border. The marker is a small check BADGE in the
  // corner (not a centered glyph) so the "Auto" swatch keeps its centered "A"
  // identity even when it's the selected colour.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      title={label}
      className="relative inline-flex items-center justify-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1"
      style={{
        width: "var(--sp-8)",
        height: "var(--sp-8)",
        borderRadius: "var(--radius-full)",
        background,
        border: "var(--hairline) solid var(--border)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        padding: 0,
      }}
    >
      {isAuto ? (
        <span aria-hidden className="text-eyebrow" style={{ color: "var(--fg-on-vivid)" }}>
          A
        </span>
      ) : null}
      {selected ? (
        <span
          aria-hidden
          className="absolute inline-flex items-center justify-center"
          style={{
            right: -2,
            bottom: -2,
            width: "var(--sp-3_5)",
            height: "var(--sp-3_5)",
            borderRadius: "var(--radius-full)",
            background: "var(--fg)",
            color: "var(--bg-raised)",
            border: "var(--hairline) solid var(--bg-raised)",
          }}
        >
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      ) : null}
    </button>
  );
}
