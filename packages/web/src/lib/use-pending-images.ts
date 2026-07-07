import { MAX_ATTACHMENT_BYTES } from "@first-tree/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export type PendingImage = {
  id: string;
  file: File;
  /** Object-URL for the thumbnail; revoked on remove / clear / send / unmount. */
  previewUrl: string;
};

export type UsePendingImages = {
  pendingImages: PendingImage[];
  addImages: (files: File[]) => void;
  removeImage: (id: string) => void;
  /** Revoke every staged preview and empty the list (call after a send). */
  clearImages: () => void;
};

/**
 * Stages images for an outbound message — the shared backbone of both the
 * in-chat composer and the new-chat draft so they enforce identical image
 * rules (`image/*` only, up to the shared `MAX_ATTACHMENT_BYTES` cap — the same
 * byte limit the attachment upload route enforces) and the same object-URL
 * lifecycle.
 *
 * The host owns the actual upload (read → IndexedDB → `sendFileMessageBatch`);
 * this hook only validates and holds the `File` + a revocable preview URL.
 *
 *   - `onError` surfaces a validation failure (oversized image) to the
 *     host's own error channel.
 *   - `onChange` fires after any successful add/remove so the host can
 *     dismiss a now-stale error ("user is fixing it").
 *
 * Callbacks are read through a ref so `addImages` / `removeImage` /
 * `clearImages` keep stable identities regardless of what the caller
 * passes inline.
 */
export function usePendingImages(
  opts: { onError?: (message: string) => void; onChange?: () => void } = {},
): UsePendingImages {
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  // Mirror the latest staged list so the unmount cleanup can revoke any
  // previews the user never sent or removed (e.g. they staged images then
  // navigated away). Without this, those object-URLs leak until page unload.
  const imagesRef = useRef(pendingImages);
  useEffect(() => {
    imagesRef.current = pendingImages;
  }, [pendingImages]);
  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  const addImages = useCallback((files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    // Gate on the shared attachment byte cap: it's the binding limit for our
    // path — an image the composer accepts is one the attachment upload route
    // will store, and chat images reach the agent as on-disk files read via its
    // Read tool (see the claude-code handler), not as raw base64 image blocks,
    // so the raw-byte storage cap governs rather than any model image-block limit.
    const oversized = imageFiles.find((f) => f.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      optsRef.current.onError?.(
        `Image too large (${(oversized.size / 1024 / 1024).toFixed(1)}MB). Maximum ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB per image.`,
      );
      return;
    }

    const newImages: PendingImage[] = imageFiles.map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    setPendingImages((prev) => [...prev, ...newImages]);
    optsRef.current.onChange?.();
  }, []);

  const removeImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
    optsRef.current.onChange?.();
  }, []);

  const clearImages = useCallback(() => {
    setPendingImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.previewUrl);
      return [];
    });
  }, []);

  return { pendingImages, addImages, removeImage, clearImages };
}
