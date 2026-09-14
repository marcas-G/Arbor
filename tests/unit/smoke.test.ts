import { describe, expect, it } from "vitest";
import { arborVersion } from "../../src/entrypoints/version.js";

describe("smoke", () => {
  it("test harness executes and version constant is importable", () => {
    expect(arborVersion).toBe("0.1.0");
  });
});
