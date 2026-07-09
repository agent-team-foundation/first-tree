import { describe, expect, it, vi } from "vitest";
import { identiconCells, identiconSvg } from "../identicon.js";

/**
 * Pin the identicon's pure contract: same seed → same pattern (so an avatar is
 * stable across renders, the server, and reloads), horizontal mirror symmetry
 * (the GitHub "block face" look), and a well-formed SVG whose rect count tracks
 * the painted cells. A regression here silently reshuffles every avatar.
 */

function countTrue(cells: boolean[][]): number {
  return cells.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
}

describe("identiconCells — deterministic symmetric grid", () => {
  it("is deterministic for a given seed and grid size", () => {
    expect(identiconCells("agent-7f3a91")).toEqual(identiconCells("agent-7f3a91"));
    expect(identiconCells("agent-7f3a91", 7)).toEqual(identiconCells("agent-7f3a91", 7));
  });

  it("returns a gridSize × gridSize matrix (default 5)", () => {
    const cells = identiconCells("alice");
    expect(cells).toHaveLength(5);
    for (const row of cells) expect(row).toHaveLength(5);

    const big = identiconCells("alice", 7);
    expect(big).toHaveLength(7);
    for (const row of big) expect(row).toHaveLength(7);
  });

  it("is left/right mirror symmetric", () => {
    for (const seed of ["alice", "bob", "first-tree", "", "Δβ-org"]) {
      const cells = identiconCells(seed);
      for (const row of cells) {
        for (let x = 0; x < row.length; x++) {
          expect(row[x]).toBe(row[row.length - 1 - x]);
        }
      }
    }
  });

  it("varies across seeds (not a constant pattern)", () => {
    const patterns = new Set(
      ["alice", "bob", "charlie", "diana", "mallory", "zeta"].map((s) => JSON.stringify(identiconCells(s))),
    );
    expect(patterns.size).toBeGreaterThan(1);
  });

  it("handles the empty seed without throwing", () => {
    expect(() => identiconCells("")).not.toThrow();
    expect(identiconCells("")).toHaveLength(5);
  });

  it("skips sparse generated rows defensively", () => {
    const fromSpy = vi.spyOn(Array, "from").mockReturnValueOnce([undefined, [false, false]]);

    try {
      expect(identiconSvg("sparse-grid", { gridSize: 2 })).toContain("<svg");
    } finally {
      fromSpy.mockRestore();
    }
  });
});

describe("identiconSvg — SVG serialization", () => {
  it("emits a normalized-viewBox svg with currentColor fill by default", () => {
    const svg = identiconSvg("alice");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 100 100"');
    expect(svg).toContain('fill="currentColor"');
  });

  it("emits one <rect> per painted cell (no background by default)", () => {
    const seed = "first-tree";
    const rectCount = (identiconSvg(seed).match(/<rect/g) ?? []).length;
    expect(rectCount).toBe(countTrue(identiconCells(seed)));
  });

  it("adds a background rect and honors an explicit color", () => {
    const seed = "first-tree";
    const svg = identiconSvg(seed, { color: "#ff0000", background: "#f0f0f0" });
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('fill="#f0f0f0"');
    const rectCount = (svg.match(/<rect/g) ?? []).length;
    expect(rectCount).toBe(countTrue(identiconCells(seed)) + 1);
  });

  it("sets svg width/height only when size is given", () => {
    const openTag = (svg: string): string => svg.slice(0, svg.indexOf(">"));
    expect(openTag(identiconSvg("alice"))).not.toContain("width=");
    expect(openTag(identiconSvg("alice", { size: 64 }))).toContain('width="64"');
  });
});
