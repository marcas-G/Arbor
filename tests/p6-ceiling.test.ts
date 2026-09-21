import { describe, expect, it } from "vitest";
import { validateCapabilityCeiling } from "../packages/application/src/index.js";
import type { ResourceBoundary } from "../packages/domain/src/index.js";

const boundary = (paths: ReadonlyArray<string>): ResourceBoundary => ({
  basisResponsibilityRevision: 1 as never,
  addresses: paths.map((path) => ({ _tag: "FileTree" as const, path })),
});

describe("P6-006 capability-ceiling validate-only checks", () => {
  it("accepts a draft that stays inside the parent boundary", () => {
    expect(
      validateCapabilityCeiling({
        parentBoundary: boundary(["a", "b"]),
        draftBoundary: boundary(["a"]),
      }),
    ).toBeNull();
  });

  it("1 boundary subset: rejects a draft address the parent does not own", () => {
    const error = validateCapabilityCeiling({
      parentBoundary: boundary(["a"]),
      draftBoundary: boundary(["a", "zzz"]),
    });
    expect(error?._tag).toBe("AuthorityDenied");
    expect(JSON.stringify(error)).toContain("escapes parent boundary");
  });

  it("2 policy tightening: rejects relaxing a parent hard deny", () => {
    const error = validateCapabilityCeiling({
      parentBoundary: boundary(["a"]),
      draftBoundary: boundary(["a"]),
      parentPolicyHardDenies: ["shell:exec"],
      draftPolicyHardDenies: [],
    });
    expect(error?._tag).toBe("AuthorityDenied");
    expect(JSON.stringify(error)).toContain("hard deny");
  });

  it("3/4 no amplification: formation cannot carry grants at all", () => {
    const error = validateCapabilityCeiling({
      parentBoundary: boundary(["a"]),
      draftBoundary: boundary(["a"]),
      proposedGrants: [{ id: "g1" }],
    });
    expect(error?._tag).toBe("AuthorityDenied");
    expect(JSON.stringify(error)).toContain("amplify");
  });

  it("same-deny policy is accepted (equal is not a relaxation of child scope)", () => {
    expect(
      validateCapabilityCeiling({
        parentBoundary: boundary(["a"]),
        draftBoundary: boundary(["a"]),
        parentPolicyHardDenies: ["shell:exec"],
        draftPolicyHardDenies: ["shell:exec", "fs:write"],
      }),
    ).toBeNull();
  });
});
