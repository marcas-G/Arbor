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

describe("phase result records", () => {
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

  it("has exactly one PASS entry per P5 exit criterion 1-11", () => {
    const criteria = parseCriteria(read("planning/results/P5.result.md"));
    expect(
      criteria.map((criterion) => criterion.number).sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 11 }, (_, index) => index + 1));
    expect(criteria.every((criterion) => criterion.status)).toBe(true);
  });

  it("reflects P0–P5 completion", () => {
    const readme = read("planning/README.md");
    for (const phase of ["P0", "P1", "P2", "P3", "P4", "P5"]) {
      expect(readme).toMatch(
        new RegExp(`\\|\\s*${phase}\\s*\\|[^|]*\\|[^|]*complete`, "i"),
      );
    }
    expect(readme).not.toMatch(/\|\s*P1\s*\|[^|]*\|[^|]*blocked/i);
  });
});

const tableCriteria = (result: string) => {
  const start = result.indexOf("## Exit criteria matrix");
  const body = start === -1 ? result : result.slice(start);
  const end = body.indexOf("\n## ", 1);
  const section = end === -1 ? body : body.slice(0, end);
  return section
    .split("\n")
    .map((line) => /^\|\s*(?:EC-)?(\d+)\s*\|/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number.parseInt(m[1] ?? "0", 10));
};

describe("P6–P12 result records", () => {
  const expected: ReadonlyArray<[string, number]> = [
    ["P6", 11],
    ["P7", 11],
    ["P8", 11],
    ["P9", 11],
    ["P10", 11],
    ["P11", 11],
    ["P12", 14],
  ];
  for (const [phase, count] of expected) {
    it(`${phase} result record is COMPLETE with ${count} criteria`, () => {
      const result = read(`planning/results/${phase}.result.md`);
      expect(result).toMatch(/COMPLETE/);
      const criteria = tableCriteria(result);
      expect([...criteria].sort((a, b) => a - b)).toEqual(
        Array.from({ length: count }, (_, index) => index + 1),
      );
    });
  }

  it("reflects P6–P12 completion in the planning index", () => {
    const readme = read("planning/README.md");
    for (const phase of ["P6", "P7", "P8", "P9", "P10", "P11", "P12"]) {
      expect(readme).toMatch(
        new RegExp(`\\|\\s*${phase}\\s*\\|[^|]*\\|[^|]*complete`, "i"),
      );
    }
  });

  it("no gap file is OPEN", () => {
    const gaps = read("planning/gaps/README.md");
    expect(gaps).not.toMatch(/\|\s*OPEN\s*\|/);
  });
});
