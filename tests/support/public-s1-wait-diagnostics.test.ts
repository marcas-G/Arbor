import { describe, expect, it } from "vitest";
import { isPrematureCurrentWorkVerificationWait } from "../capability/real-provider/public-s1-wait-diagnostics.js";

const base = {
  workId: "wrk_current",
  workRevision: 3,
  completionClaimRequested: false,
  proofExists: false,
  verificationExists: false,
};

describe("real public S1 Wait diagnostics", () => {
  it("flags only an untriggerable wait on this Work's own future Verification", () => {
    expect(
      isPrematureCurrentWorkVerificationWait({
        ...base,
        wait: {
          disposition: "Yielded",
          waitSpec: {
            mode: "Any",
            conditions: [
              {
                _tag: "VerificationChanged",
                workId: "wrk_current",
                targetWorkRevision: 3,
              },
            ],
          },
        },
      }),
    ).toBe(true);
    expect(
      isPrematureCurrentWorkVerificationWait({
        ...base,
        wait: {
          disposition: "Yielded",
          waitSpec: {
            mode: "Any",
            conditions: [
              {
                _tag: "VerificationChanged",
                workId: "wrk_current",
                targetWorkRevision: 4,
              },
            ],
          },
        },
      }),
    ).toBe(true);
  });

  it("does not flag real approval/dependency waits or mixed external conditions", () => {
    const approvalWait = {
      disposition: "Yielded",
      waitSpec: {
        mode: "Any",
        conditions: [{ _tag: "ApprovalChanged", approvalId: "approval_exact" }],
      },
    };
    const mixedWait = {
      disposition: "Yielded",
      waitSpec: {
        mode: "Any",
        conditions: [
          {
            _tag: "VerificationChanged",
            workId: "wrk_current",
            targetWorkRevision: 3,
          },
          { _tag: "DependencyChanged", dependencyId: "dep_external" },
        ],
      },
    };
    expect(
      isPrematureCurrentWorkVerificationWait({ ...base, wait: approvalWait }),
    ).toBe(false);
    expect(
      isPrematureCurrentWorkVerificationWait({ ...base, wait: mixedWait }),
    ).toBe(false);
    expect(
      isPrematureCurrentWorkVerificationWait({
        ...base,
        wait: {
          disposition: "Yielded",
          waitSpec: {
            mode: "Any",
            conditions: [
              { _tag: "DependencyChanged", dependencyId: "dep_external" },
            ],
          },
        },
      }),
    ).toBe(false);
  });

  it("does not flag a different Work or a Verification already in progress", () => {
    const wait = {
      disposition: "Yielded",
      waitSpec: {
        mode: "Any",
        conditions: [
          {
            _tag: "VerificationChanged",
            workId: "wrk_other",
            targetWorkRevision: 3,
          },
        ],
      },
    };
    expect(isPrematureCurrentWorkVerificationWait({ ...base, wait })).toBe(
      false,
    );
    expect(
      isPrematureCurrentWorkVerificationWait({
        ...base,
        wait,
        verificationExists: true,
      }),
    ).toBe(false);
    expect(
      isPrematureCurrentWorkVerificationWait({
        ...base,
        wait,
        completionClaimRequested: true,
      }),
    ).toBe(false);
    expect(
      isPrematureCurrentWorkVerificationWait({
        ...base,
        wait,
        proofExists: true,
      }),
    ).toBe(false);
  });
});
