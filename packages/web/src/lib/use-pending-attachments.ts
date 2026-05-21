import {
  ATTACHMENT_LIMITS,
  DENIED_ATTACHMENT_EXTENSIONS,
  deriveAttachmentKind,
  fileExtension,
} from "@agent-team-foundation/first-tree-hub-shared";
import { useCallback, useEffect, useRef, useState } from "react";

export type PendingAttachment = {
  id: string;
  file: File;
  kind: "image" | "file";
  /** Object-URL thumbnail for images only; undefined for other files. Revoked on remove/clear. */
  previewUrl?: string;
};

export type UsePendingAttachments = {
  pendingAttachments: PendingAttachment[];
  addFiles: (files: File[]) => void;
  removeAttachment: (id: string) => void;
  /** Revoke every staged preview and empty the list (call after a send). */
  clearAttachments: () => void;
};

/**
 * Stages files (any type) for an outbound message — the generalized successor
 * of `usePendingImages`. Enforces the shared attachment limits client-side
 * (size, count, per-message total, executable/extension deny) so the user gets
 * instant feedback; the server re-validates authoritatively on upload. Images
 * get a revocable object-URL for a thumbnail; other files render as a card.
 *
 * Callbacks are read through a ref so the returned functions keep stable
 * identities regardless of inline closures the caller passes.
 */
export function usePendingAttachments(
  opts: { onError?: (message: string) => void; onChange?: () => void } = {},
): UsePendingAttachments {
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);

  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;

    setPendingAttachments((prev) => {
      const accepted: PendingAttachment[] = [];
      let count = prev.length;
      let total = prev.reduce((sum, a) => sum + a.file.size, 0);

      for (const file of files) {
        const ext = fileExtension(file.name);
        if (DENIED_ATTACHMENT_EXTENSIONS.has(ext)) {
          optsRef.current.onError?.(`File type "${ext}" is not allowed.`);
          continue;
        }
        if (file.size > ATTACHMENT_LIMITS.maxFileBytes) {
          optsRef.current.onError?.(
            `"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)}MB; max ${ATTACHMENT_LIMITS.maxFileBytes / 1024 / 1024}MB).`,
          );
          continue;
        }
        if (count + 1 > ATTACHMENT_LIMITS.maxMessageCount) {
          optsRef.current.onError?.(`Too many attachments (max ${ATTACHMENT_LIMITS.maxMessageCount}).`);
          break;
        }
        if (total + file.size > ATTACHMENT_LIMITS.maxMessageBytes) {
          optsRef.current.onError?.(
            `Attachments exceed the ${ATTACHMENT_LIMITS.maxMessageBytes / 1024 / 1024}MB per-message limit.`,
          );
          break;
        }
        const kind = deriveAttachmentKind(file.type);
        accepted.push({
          id: crypto.randomUUID(),
          file,
          kind,
          previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
        });
        count += 1;
        total += file.size;
      }

      if (accepted.length === 0) return prev;
      optsRef.current.onChange?.();
      return [...prev, ...accepted];
    });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => {
      const found = prev.find((a) => a.id === id);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
    optsRef.current.onChange?.();
  }, []);

  const clearAttachments = useCallback(() => {
    setPendingAttachments((prev) => {
      for (const a of prev) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      return [];
    });
  }, []);

  return { pendingAttachments, addFiles, removeAttachment, clearAttachments };
}
