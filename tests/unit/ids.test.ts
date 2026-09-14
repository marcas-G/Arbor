import { describe, expect, it } from "vitest";
import {
  asChangeId,
  asEffectiveResultId,
  asProjectId,
  asVerificationId,
  newChangeId,
  newEffectiveResultId,
  newVerificationId,
} from "../../src/domain/ids.js";

describe("branded ids", () => {
  it("as* accepts valid uuids", () => {
    expect(asProjectId(newChangeId() as never)).toBeDefined();
    expect(asVerificationId(newVerificationId())).toBeDefined();
    expect(asChangeId(newChangeId())).toBeDefined();
    expect(asEffectiveResultId(newEffectiveResultId())).toBeDefined();
  });

  it("as* rejects non-uuid", () => {
    for (const f of [asProjectId, asVerificationId, asChangeId, asEffectiveResultId]) {
      expect(f("not-a-uuid")).toBeUndefined();
      expect(f("")).toBeUndefined();
    }
  });

  it("each new* is unique", () => {
    expect(newChangeId()).not.toBe(newChangeId());
    expect(newVerificationId()).not.toBe(newVerificationId());
    expect(newEffectiveResultId()).not.toBe(newEffectiveResultId());
  });
});
