import { describe, expect, it } from "vitest";
import {
  isPathWithinPrefix,
  normalizeProjectPath,
  type ProjectPath,
} from "../../src/domain/project-path.js";

const ok = (s: string): ProjectPath => normalizeProjectPath(s) as ProjectPath;

describe("normalizeProjectPath", () => {
  it.each([".", "src", "src/runtime", "src/runtime/file.ts"])("accepts %s", (input) => {
    const r = normalizeProjectPath(input);
    expect(r).toMatchObject({ kind: "ok" });
  });
  it("canonical root is '.'", () => {
    expect(ok(".").value).toBe(".");
  });
  it("normalizes separators, collapses duplicates, drops . segments", () => {
    expect(normalizeProjectPath("src\\runtime//x/./y")).toMatchObject({
      kind: "ok",
      value: "src/runtime/x/y",
    });
  });
  it("rejects absolute", () => {
    expect(normalizeProjectPath("/etc")).toMatchObject({ kind: "err", reason: "absolute" });
  });
  it("rejects drive prefix", () => {
    expect(normalizeProjectPath("C:\\x")).toMatchObject({ kind: "err", reason: "absolute" });
  });
  it("rejects ..", () => {
    expect(normalizeProjectPath("a/../b")).toMatchObject({ kind: "err", reason: "parent-segment" });
  });
  it("rejects empty", () => {
    expect(normalizeProjectPath("")).toMatchObject({ kind: "err", reason: "empty" });
    expect(normalizeProjectPath("   ")).toMatchObject({ kind: "err", reason: "empty" });
  });
});

describe("isPathWithinPrefix (segment semantics)", () => {
  it("root prefix matches everything", () => {
    expect(isPathWithinPrefix(ok("."), ok("src/a.ts"))).toBe(true);
  });
  it("matches self and descendants", () => {
    expect(isPathWithinPrefix(ok("src/runtime"), ok("src/runtime"))).toBe(true);
    expect(isPathWithinPrefix(ok("src/runtime"), ok("src/runtime/x.ts"))).toBe(true);
  });
  it("does not match string-prefix siblings (src/runtime2)", () => {
    expect(isPathWithinPrefix(ok("src/runtime"), ok("src/runtime2"))).toBe(false);
  });
  it("shorter target does not contain longer prefix", () => {
    expect(isPathWithinPrefix(ok("src/runtime"), ok("src"))).toBe(false);
  });
});
