import { describe, expect, it } from "vitest";
import type { ContextFragment } from "../src/index.js";
import { contextBudget, planContext } from "../src/index.js";

const fragment = (
  ref: string,
  layer: ContextFragment["layer"],
  retention: ContextFragment["retention"],
  tokens: number,
): ContextFragment => ({
  ref,
  layer,
  retention,
  cacheClass: "Stable",
  tokens,
});

const budget = {
  modelWindow: 100,
  outputReserve: 20,
  protocolReserve: 10,
  toolReserve: 10,
};

describe("P3 context planning", () => {
  it("reserves output before input", () => {
    expect(contextBudget(budget)).toBe(60);
  });

  it("keeps pinned/protected and evicts optional in order", () => {
    const result = planContext(
      [
        fragment("c0", "C0", "Pinned", 20),
        fragment("c3", "C3", "Protected", 10),
        fragment("c5", "C5", "Evictable", 50),
        fragment("c6", "C6", "Compressible", 25),
      ],
      budget,
    );
    expect(result.unsatisfiable).toBe(false);
    // remaining after pinned+protected is 30: C6 (compressible) is more valuable
    // than C5 (evictable) and fits, so C5 is evicted.
    expect(result.selected.map((f) => f.ref)).toEqual(["c0", "c3", "c6"]);
    expect(result.evicted.map((f) => f.ref)).toEqual(["c5"]);
  });

  it("returns unsatisfiable instead of dropping hard control facts", () => {
    const result = planContext(
      [
        fragment("c0", "C0", "Pinned", 50),
        fragment("c1", "C1", "Protected", 20),
      ],
      budget,
    );
    expect(result.unsatisfiable).toBe(true);
    expect(result.selected).toHaveLength(0);
  });
});
