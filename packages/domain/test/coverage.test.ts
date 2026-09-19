import { describe, expect, it } from "vitest";
import {
  COVERAGE_MATRIX,
  checkCoverage,
  REQUIRED_IDS,
} from "./coverage-matrix.js";

describe("coverage matrix", () => {
  it("covers every §12.11 row and §14.5 criterion 2-13", () => {
    const report = checkCoverage(COVERAGE_MATRIX, REQUIRED_IDS);
    expect(report.missing).toEqual([]);
    expect(report.uncovered).toEqual([]);
    expect(report.blankTestRef).toEqual([]);
    expect(report.unknownTestRef).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails when a required row is missing", () => {
    const firstId = REQUIRED_IDS[0] ?? "";
    const mutated = COVERAGE_MATRIX.filter((entry) => entry.id !== firstId);
    expect(checkCoverage(mutated, REQUIRED_IDS).ok).toBe(false);
  });

  it("fails when a row is UNCOVERED", () => {
    const mutated = COVERAGE_MATRIX.map((entry, index) =>
      index === 0 ? { ...entry, status: "UNCOVERED" as const } : entry,
    );
    expect(checkCoverage(mutated, REQUIRED_IDS).ok).toBe(false);
  });

  it("fails when a testRef is unknown", () => {
    const mutated = COVERAGE_MATRIX.map((entry, index) =>
      index === 0 ? { ...entry, testRef: "nope.test.ts" } : entry,
    );
    expect(checkCoverage(mutated, REQUIRED_IDS).ok).toBe(false);
  });
});
