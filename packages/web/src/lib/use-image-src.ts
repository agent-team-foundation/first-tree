import { useEffect, useState } from "react";
import { fetchAttachmentBase64 } from "../api/attachments.js";
import { getImage, putImage } from "../api/image-store.js";

/**
 * Resolve a chat image reference to a renderable `data:` URL.
 *
 * The per-browser IndexedDB cache is consulted first (the sender's own sends,
 * and any already-rendered thumbnail, warm it); on a miss the bytes are fetched
 * from the org attachment store and the cache is warmed for next time. The
 * returned bytes are full-resolution — the same URL a thumbnail and the
 * lightbox both use, so opening the lightbox on an already-visible image
 * resolves from the warm cache (a fast IndexedDB read, no network refetch).
 *
 * Shared by the inline thumbnail ({@link ImageFromRef}) and the lightbox so the
 * two never drift on caching / fetch behaviour.
 */
export type ImageSrcState = { kind: "loading" } | { kind: "hit"; src: string } | { kind: "miss" };

export function useImageSrc(imageId: string | undefined): ImageSrcState {
  const [state, setState] = useState<ImageSrcState>({ kind: "loading" });

  useEffect(() => {
    if (!imageId) {
      setState({ kind: "miss" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      const hit = await getImage(imageId);
      if (cancelled) return;
      if (hit) {
        setState({ kind: "hit", src: `data:${hit.mimeType};base64,${hit.base64}` });
        return;
      }
      try {
        const fetched = await fetchAttachmentBase64(imageId);
        if (cancelled) return;
        // Warm the cache for subsequent renders; best-effort.
        putImage({ imageId, base64: fetched.base64, mimeType: fetched.mimeType }).catch(() => {});
        setState({ kind: "hit", src: `data:${fetched.mimeType};base64,${fetched.base64}` });
      } catch {
        if (!cancelled) setState({ kind: "miss" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imageId]);

  return state;
}
