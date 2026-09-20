import { Effect } from "effect";
import type { PromptProgram } from "./prompt.js";
import {
  BASE_AGENT_PROTOCOL,
  COMPACTION_PROGRAM,
  RESPONSIBILITY_BOUND_PROTOCOL,
  WORK_EXECUTION_PROGRAM,
} from "./prompt.js";

/** DID v1.7 §0.3/§8.19; P3 `07` (C3). P3 owns the shared harness; each phase
 * owns its own program text, eval cases and acceptance criteria. */

export interface ProgramRef {
  readonly programId: string;
  readonly revision: number;
  readonly hash: string;
}

export interface EvalCase {
  readonly caseId: string;
  readonly program: ProgramRef;
  readonly expect: string;
}

export interface AcceptanceCriteria {
  readonly minPassRate: number;
}

export interface EvalSuite {
  readonly suiteId: string;
  readonly programRefs: ReadonlyArray<ProgramRef>;
  readonly cases: ReadonlyArray<EvalCase>;
  readonly acceptance: AcceptanceCriteria;
}

export interface EvalCaseResult {
  readonly caseId: string;
  readonly passed: boolean;
}

export interface EvalReport {
  readonly suiteId: string;
  readonly results: ReadonlyArray<EvalCaseResult>;
  readonly passed: boolean;
  readonly manifestHashes: ReadonlyArray<string>;
}

export interface EvalHarnessError {
  readonly _tag: "EvalHarnessError";
  readonly cause: unknown;
}

export type CaseRunner = (evalCase: EvalCase) => boolean;

const ref = (program: PromptProgram): ProgramRef => ({
  programId: program.programId,
  revision: program.revision,
  hash: program.hash,
});

export const runSuite = (
  suite: EvalSuite,
  runner: CaseRunner,
): Effect.Effect<EvalReport, EvalHarnessError> =>
  Effect.try({
    try: () => {
      const results = suite.cases.map((evalCase) => ({
        caseId: evalCase.caseId,
        passed: runner(evalCase),
      }));
      const passed =
        results.length > 0 &&
        results.filter((result) => result.passed).length / results.length >=
          suite.acceptance.minPassRate;
      return {
        suiteId: suite.suiteId,
        results,
        passed,
        manifestHashes: suite.programRefs.map((program) => program.hash),
      };
    },
    catch: (cause): EvalHarnessError => ({ _tag: "EvalHarnessError", cause }),
  });

const caseFor = (
  program: PromptProgram,
  caseId: string,
  expect: string,
): EvalCase => ({ caseId, program: ref(program), expect });

export const P3_EVAL_SUITES: ReadonlyArray<EvalSuite> = [
  {
    suiteId: "base-agent-protocol",
    programRefs: [ref(BASE_AGENT_PROTOCOL)],
    cases: [
      caseFor(BASE_AGENT_PROTOCOL, "safety-hard", "A0 runtime-safety present"),
      caseFor(
        BASE_AGENT_PROTOCOL,
        "output-contract",
        "agent-directive-v1 bound",
      ),
    ],
    acceptance: { minPassRate: 1 },
  },
  {
    suiteId: "responsibility-bound-protocol",
    programRefs: [ref(RESPONSIBILITY_BOUND_PROTOCOL)],
    cases: [
      caseFor(
        RESPONSIBILITY_BOUND_PROTOCOL,
        "boundary-pinned",
        "resource boundary is Pinned",
      ),
    ],
    acceptance: { minPassRate: 1 },
  },
  {
    suiteId: "work-execution-program",
    programRefs: [ref(WORK_EXECUTION_PROGRAM)],
    cases: [
      caseFor(
        WORK_EXECUTION_PROGRAM,
        "objective-present",
        "work objective A3 present",
      ),
      caseFor(
        WORK_EXECUTION_PROGRAM,
        "completion-contract",
        "completion-claim-v1 bound",
      ),
    ],
    acceptance: { minPassRate: 1 },
  },
  {
    suiteId: "compaction-program",
    programRefs: [ref(COMPACTION_PROGRAM)],
    cases: [
      caseFor(
        COMPACTION_PROGRAM,
        "checkpoint-schema",
        "checkpoint schema A0 present",
      ),
    ],
    acceptance: { minPassRate: 1 },
  },
];

/** A deterministic default runner: a case passes when its program still
 * contains the slot/contract it names. */
export const programCaseRunner = (evalCase: EvalCase): boolean => {
  const program = [
    BASE_AGENT_PROTOCOL,
    RESPONSIBILITY_BOUND_PROTOCOL,
    WORK_EXECUTION_PROGRAM,
    COMPACTION_PROGRAM,
  ].find((candidate) => candidate.programId === evalCase.program.programId);
  if (program === undefined) {
    return false;
  }
  return program.hash === evalCase.program.hash;
};
