import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateRealJourneyEvidenceRoot } from "./public-real-journey-support.js";

const temporaryRoots: Array<string> = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

const makeRoots = () => {
  const worktree = mkdtempSync(
    join(tmpdir(), `arbor-evidence-root-${randomUUID()}-`),
  );
  temporaryRoots.push(worktree);
  const results = join(worktree, ".test-results");
  mkdirSync(results);
  const run = join(results, "private-run");
  mkdirSync(run);
  const outside = join(worktree, "outside");
  mkdirSync(outside);
  return { worktree, results, run, outside };
};

describe("real public evidence root confinement", () => {
  it("accepts the isolated worktree .test-results base", () => {
    const roots = makeRoots();
    expect(
      validateRealJourneyEvidenceRoot(roots.results, roots.worktree),
    ).toEqual({
      ready: true,
      path: resolve(roots.results),
    });
  });

  it("accepts an existing descendant run directory", () => {
    const roots = makeRoots();
    expect(validateRealJourneyEvidenceRoot(roots.run, roots.worktree)).toEqual({
      ready: true,
      path: resolve(roots.run),
    });
  });

  it("rejects an existing directory outside .test-results", () => {
    const roots = makeRoots();
    expect(
      validateRealJourneyEvidenceRoot(roots.outside, roots.worktree),
    ).toMatchObject({
      ready: false,
    });
  });

  it("rejects a symlink or directory reparse point escaping .test-results", () => {
    const roots = makeRoots();
    const alias = join(roots.results, "external-alias");
    try {
      symlinkSync(
        roots.outside,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      // Some Windows hosts disallow creating junctions in the current test token.
      return;
    }
    expect(
      validateRealJourneyEvidenceRoot(alias, roots.worktree),
    ).toMatchObject({
      ready: false,
    });
  });
});
