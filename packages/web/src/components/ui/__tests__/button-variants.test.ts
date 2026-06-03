import { describe, expect, it } from "vitest";
import { cn } from "../../../lib/utils.js";
import { buttonVariants } from "../button.js";

/**
 * Regression guard for the "dark-on-dark Save button" bug.
 *
 * The design system's typography scale (text-label / text-body / …) ships as
 * Tailwind v4 @theme font-size utilities. tailwind-merge's *default* config
 * misclassifies those custom names as text-COLOR utilities, so a class string
 * carrying both a color (text-primary-foreground) and a size (text-label, added
 * by Button size="sm"/"xs") would have its color silently dropped — leaving small
 * filled buttons inheriting --fg (dark text) on a dark bg. `cn()` registers the
 * scale in the font-size group to keep the two in separate conflict groups.
 *
 * If someone reverts `cn` back to a bare twMerge, these assertions fail.
 */
describe("cn — custom typography scale does not eat text colors", () => {
  it("keeps the text color when a custom font-size class follows it", () => {
    const out = cn("text-primary-foreground", "text-label");
    expect(out).toContain("text-primary-foreground");
    expect(out).toContain("text-label");
  });

  it("still resolves two competing custom font-sizes to the last one", () => {
    const out = cn("text-body", "text-label");
    expect(out).toContain("text-label");
    expect(out).not.toContain("text-body");
  });
});

describe("buttonVariants — filled variants keep their text color at every size", () => {
  // Every filled variant pairs a bg with an explicit on-color; small sizes append
  // a custom font-size class (text-label) that must not strip that on-color.
  const filled: Array<[string, string]> = [
    ["default", "text-primary-foreground"],
    ["destructive", "text-destructive-foreground"],
    ["secondary", "text-secondary-foreground"],
  ];

  for (const [variant, expectedColor] of filled) {
    for (const size of ["sm", "xs", "default"] as const) {
      it(`${variant} @ ${size} retains ${expectedColor}`, () => {
        const out = buttonVariants({ variant: variant as never, size });
        expect(out).toContain(expectedColor);
      });
    }
  }

  it("cta @ sm retains its on-vivid text color", () => {
    const out = buttonVariants({ variant: "cta", size: "sm" });
    expect(out).toContain("text-[color:var(--fg-on-vivid)]");
  });
});
