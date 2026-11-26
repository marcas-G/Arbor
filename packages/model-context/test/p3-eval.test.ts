import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import {
  type EvalSuite,
  P3_EVAL_SUITES,
  programCaseRunner,
  runSuite,
} from "../src/index.js";

describe("P3 behavioral-eval harness", () => {
  it.effect("runs the P3 program suites deterministically", () =>
    Effect.gen(function* () {
      for (const suite of P3_EVAL_SUITES) {
        const report = yield* runSuite(suite, programCaseRunner);
        expect(report.passed).toBe(true);
        expect(report.manifestHashes.length).toBe(suite.programRefs.length);
      }
    }),
  );

  it.effect("fails a suite when a program revision regresses", () =>
    Effect.gen(function* () {
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
      const report = yield* runSuite(suite, programCaseRunner);
      expect(report.passed).toBe(false);
    }),
  );

  it.effect("fails a suite with no cases", () =>
    Effect.gen(function* () {
      const suite: EvalSuite = {
        suiteId: "empty",
        programRefs: [],
        cases: [],
        acceptance: { minPassRate: 1 },
      };
      const report = yield* runSuite(suite, programCaseRunner);
      expect(report.passed).toBe(false);
    }),
  );
});
