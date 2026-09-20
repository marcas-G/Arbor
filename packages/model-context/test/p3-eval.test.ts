import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  type EvalSuite,
  P3_EVAL_SUITES,
  programCaseRunner,
  runSuite,
} from "../src/index.js";

describe("P3 behavioral-eval harness", () => {
  it("runs the P3 program suites deterministically", async () => {
    for (const suite of P3_EVAL_SUITES) {
      const report = await Effect.runPromise(
        runSuite(suite, programCaseRunner),
      );
      expect(report.passed).toBe(true);
      expect(report.manifestHashes.length).toBe(suite.programRefs.length);
    }
  });

  it("fails a suite when a program revision regresses", async () => {
    const suite: EvalSuite = {
      suiteId: "regressed",
      programRefs: [
        { programId: "base-agent-protocol", revision: 99, hash: "deadbeef" },
      ],
      cases: [
        {
          caseId: "c1",
          program: {
            programId: "base-agent-protocol",
            revision: 99,
            hash: "deadbeef",
          },
          expect: "x",
        },
      ],
      acceptance: { minPassRate: 1 },
    };
    const report = await Effect.runPromise(runSuite(suite, programCaseRunner));
    expect(report.passed).toBe(false);
  });

  it("fails a suite with no cases", async () => {
    const suite: EvalSuite = {
      suiteId: "empty",
      programRefs: [],
      cases: [],
      acceptance: { minPassRate: 1 },
    };
    const report = await Effect.runPromise(runSuite(suite, programCaseRunner));
    expect(report.passed).toBe(false);
  });
});
