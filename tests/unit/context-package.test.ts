import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ContextPackageSchema } from "../../src/domain/context-package.js";

const valid = () => ({
  projectId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  contract: {
    intent: "i",
    responsibility: "r",
    deliverables: "d",
    inheritedConstraints: [],
  },
  resources: { writable: ["."] },
  worktreeRoot: "/home/x/arbor-home/projects/p/worktrees/root",
  effective: { storeCommitSha: "a".repeat(40) },
});

describe("ContextPackage (D-034)", () => {
  it("round-trips a full valid package", () => {
    const v = valid();
    const d = Schema.decodeUnknownSync(ContextPackageSchema)(v);
    expect(
      Schema.decodeUnknownSync(ContextPackageSchema)(Schema.encodeSync(ContextPackageSchema)(d)),
    ).toEqual(d);
  });

  it("rejects non-canonical writable prefix", () => {
    const v = { ...valid(), resources: { writable: ["src/*"] } };
    expect(() => Schema.decodeUnknownSync(ContextPackageSchema)(v)).toThrow();
  });

  it("rejects missing effective block", () => {
    const v = valid() as Record<string, unknown>;
    delete v.effective;
    expect(() => Schema.decodeUnknownSync(ContextPackageSchema)(v)).toThrow();
  });
});
