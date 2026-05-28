import { coverageConfigDefaults } from "vitest/config";
import type { CoverageOptions } from "vitest/node";

type UnitCoverageConfigOptions = {
  exclude?: string[];
};

const DEFAULT_COVERAGE_EXCLUDE = [
  ...coverageConfigDefaults.exclude,
  "src/**/*.{test,spec}.{ts,tsx}",
  "src/**/__tests__/**",
  "tests/**",
  "dist/**",
  "coverage/**",
  "**/*.d.ts",
  "**/*.config.{ts,tsx,js,mjs,cjs}",
  "vitest.config.{ts,js,mjs,cjs}",
];

export function unitCoverageConfig(options: UnitCoverageConfigOptions = {}): CoverageOptions<"v8"> {
  return {
    provider: "v8",
    all: true,
    include: ["src/**/*.{ts,tsx}"],
    reportsDirectory: "coverage",
    reporter: ["text", "html", "lcov", "json-summary"],
    exclude: [...DEFAULT_COVERAGE_EXCLUDE, ...(options.exclude ?? [])],
  };
}
