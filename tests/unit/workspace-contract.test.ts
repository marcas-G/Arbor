import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  type WorkspaceContract,
  WorkspaceContractSchema,
} from "../../src/domain/workspace-contract.js";

const valid: unknown = {
  intent: "build arbor",
  responsibility: "own the runtime",
  deliverables: "working bootstrap",
  inheritedConstraints: [],
};

describe("WorkspaceContract (D-031 string shape)", () => {
  it("decodes valid value (Root: empty constraints)", () => {
    const c = Schema.decodeUnknownSync(WorkspaceContractSchema)(valid) as WorkspaceContract;
    expect(c.inheritedConstraints).toEqual([]);
  });

  it("round-trips through encode/decode", () => {
    const c = Schema.decodeUnknownSync(WorkspaceContractSchema)(valid);
    const json = Schema.encodeSync(WorkspaceContractSchema)(c);
    const back = Schema.decodeUnknownSync(WorkspaceContractSchema)(json);
    expect(back).toEqual(c);
  });

  it("rejects missing field", () => {
    expect(() => Schema.decodeUnknownSync(WorkspaceContractSchema)({ intent: "x" })).toThrow();
  });

  it("rejects wrong-typed constraints", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkspaceContractSchema)({
        ...valid,
        inheritedConstraints: "none",
      }),
    ).toThrow();
  });
});
