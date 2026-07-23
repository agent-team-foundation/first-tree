import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("mobile PWA manifest", () => {
  it("keeps installed-app identity stable while launching the canonical Work route", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../../public/manifest.webmanifest", import.meta.url), "utf8"),
    ) as { id?: string; start_url?: string };

    expect(manifest.id).toBe("/m/now");
    expect(manifest.start_url).toBe("/m/work");
  });
});
