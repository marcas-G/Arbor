import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

const parseCriteria = (result: string) => {
  const blocks = result.split(/^### Criterion /m).slice(1);
  return blocks.map((block) => {
    const number = Number.parseInt(block.slice(0, 2), 10);
    return { number, status: /- status: PASS/.test(block) };
  });
};

describe("P0 result record", () => {
  it("has exactly one entry per §14.5 criterion 1-15", () => {
    const criteria = parseCriteria(read("planning/results/P0.result.md"));
    expect(
      criteria.map((criterion) => criterion.number).sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
    expect(criteria.every((criterion) => criterion.status)).toBe(true);
  });

  it("records no OPEN design gap", () => {
    const gaps = read("planning/gaps/README.md");
    const openRows = gaps
      .split("\n")
      .filter((line) => /^\|\s*(?:P1-)?DG-\d+.*\|\s*OPEN\s*\|/.test(line));
    expect(openRows).toEqual([]);
  });

  it("reflects P0–P4 completion", () => {
    const readme = read("planning/README.md");
    for (const phase of ["P0", "P1", "P2", "P3", "P4"]) {
      expect(readme).toMatch(
        new RegExp(`\\|\\s*${phase}\\s*\\|[^|]*\\|[^|]*complete`, "i"),
      );
    }
    expect(readme).not.toMatch(/\|\s*P1\s*\|[^|]*\|[^|]*blocked/i);
  });
});
