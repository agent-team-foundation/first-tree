import type { CSSProperties } from "react";
import { useState } from "react";
import { useImageSrc } from "../../lib/use-image-src.js";
import { ImageLightbox, type LightboxImage } from "../ui/image-lightbox.js";

const STANDALONE_IMG_STYLE = {
  maxWidth: "min(25rem, 100%)",
  maxHeight: 360,
  borderRadius: "var(--radius-panel)",
  cursor: "zoom-in",
  display: "block",
} satisfies CSSProperties;

const GALLERY_IMG_STYLE = {
  height: 172,
  width: "auto",
  maxWidth: "min(28.75rem, 100%)",
  objectFit: "cover",
  borderRadius: "var(--radius-panel)",
  cursor: "zoom-in",
  display: "block",
} satisfies CSSProperties;

function ImageFromRef({
  content,
  variant,
  onOpen,
}: {
  content: ReferencedImage;
  variant: "standalone" | "gallery";
  onOpen: () => void;
}) {
  const state = useImageSrc(content.imageId);

  if (state.kind === "hit") {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open image ${content.filename}`}
        className="block border-none bg-transparent p-0"
        style={{ marginTop: variant === "standalone" ? 4 : 0, maxWidth: "100%", minWidth: 0 }}
      >
        <img
          src={state.src}
          alt={content.filename}
          style={variant === "standalone" ? STANDALONE_IMG_STYLE : GALLERY_IMG_STYLE}
        />
      </button>
    );
  }
  if (state.kind === "miss") {
    return (
      <span className="text-label" style={{ color: "var(--fg-3)", fontStyle: "italic" }}>
        [Image "{content.filename}" failed to load]
      </span>
    );
  }
  return (
    <span className="text-label" style={{ color: "var(--fg-4)" }}>
      …
    </span>
  );
}

export type ReferencedImage = {
  imageId: string;
  filename: string;
};

/**
 * Shared referenced-image presentation for timeline messages and tracked
 * request takeovers. A single ref uses the larger standalone treatment; a
 * batch uses the existing equal-height gallery and one shared lightbox.
 */
export function ImageRefGallery({
  images,
  hasLeadingContent = false,
}: {
  images: readonly ReferencedImage[];
  hasLeadingContent?: boolean;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const lightboxImages: LightboxImage[] = images.map((image) => ({
    imageId: image.imageId,
    filename: image.filename,
  }));
  const only = images.length === 1 ? images[0] : undefined;

  if (images.length === 0) return null;
  return (
    <>
      {only ? (
        <ImageFromRef content={only} variant="standalone" onOpen={() => setOpenIndex(0)} />
      ) : (
        <div className="flex flex-wrap items-start" style={{ gap: 6, marginTop: hasLeadingContent ? 2 : 0 }}>
          {images.map((image, index) => (
            <ImageFromRef key={image.imageId} content={image} variant="gallery" onOpen={() => setOpenIndex(index)} />
          ))}
        </div>
      )}
      <ImageLightbox images={lightboxImages} index={openIndex} onIndexChange={setOpenIndex} />
    </>
  );
}
