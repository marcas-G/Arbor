import { describe, expect, it } from "vitest";
import {
  f18ProcessCrashMarker,
  hasExpectedF18ProcessCrash,
  unexpectedF18DaemonErrors,
} from "./functional/support/f18-process-crash-oracle.js";

describe("F18 process crash oracle", () => {
  const markerInput = {
    boundary: "AfterSourceValidationBeforeClaim",
    projectId: "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
    eventSequence: 17,
    leaseGeneration: 0,
  } as const;
  const marker = f18ProcessCrashMarker(markerInput);

  it("requires the exact boundary, project, event sequence, lease generation, and exit code", () => {
    expect(marker).toBe(
      "F18_TEST_CRASH:AfterSourceValidationBeforeClaim:prj_018f2b3c-4d5e-7abc-8def-0123456789a1:17:0",
    );
    expect(
      hasExpectedF18ProcessCrash({
        exitCode: 86,
        daemonErrors: [`stderr prefix\n${marker}\nstderr suffix`],
        marker,
      }),
    ).toBe(true);

    for (const mismatch of [
      { ...markerInput, boundary: "AfterReconciliationLeaseClaimCommit" },
      { ...markerInput, projectId: "prj_other" },
      { ...markerInput, eventSequence: 18 },
      { ...markerInput, leaseGeneration: 1 },
    ]) {
      expect(
        hasExpectedF18ProcessCrash({
          exitCode: 86,
          daemonErrors: [f18ProcessCrashMarker(mismatch)],
          marker,
        }),
      ).toBe(false);
    }
    expect(
      hasExpectedF18ProcessCrash({
        exitCode: 0,
        daemonErrors: [marker],
        marker,
      }),
    ).toBe(false);
    expect(
      hasExpectedF18ProcessCrash({
        exitCode: 86,
        daemonErrors: ["F18_TEST_CRASH:AfterSourceValidationBeforeClaim"],
        marker,
      }),
    ).toBe(false);
  });

  it("filters only the exact expected marker and retains adjacent errors", () => {
    expect(
      unexpectedF18DaemonErrors(
        [`${marker}\nsecondary failure`, "F18_TEST_CRASH:wrong-boundary"],
        marker,
      ),
    ).toEqual(["secondary failure", "F18_TEST_CRASH:wrong-boundary"]);
  });
});
