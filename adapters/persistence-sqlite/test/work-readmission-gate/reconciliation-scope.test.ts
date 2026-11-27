import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  appendMalformedReconciliationEvent,
  appendReconciliationEvent,
  executionId,
  otherExecutionId,
  otherProjectExecutionId,
  otherWorkId,
  otherWorkspaceId,
  projectId,
  query,
  queryTarget,
  runDb,
  seed,
  seedOtherProjectExecution,
  seedOtherWorkspaceExecution,
  seedThirdWorkspaceExecution,
  thirdExecutionId,
  thirdWorkId,
  thirdWorkspaceId,
  workId,
  workspaceId,
} from "./support.js";

describe("WorkReadmissionGateStore", () => {
  it("fails closed when ReconciliationEscalated aggregate and payload bind different Executions", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendReconciliationEvent(executionId, otherExecutionId);
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
          expect(JSON.stringify(exit.cause)).toContain(
            `"executionId":"${executionId}"`,
          );
        }
      }),
    ));

  it("does not let a B/C mismatch block A, while each referenced Workspace fails closed", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* seedThirdWorkspaceExecution;
        yield* appendReconciliationEvent(otherExecutionId, thirdExecutionId);
        expect(
          Option.isNone(yield* queryTarget(projectId, workspaceId, workId)),
        ).toBe(true);
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        const inC = yield* Effect.exit(
          queryTarget(projectId, thirdWorkspaceId, thirdWorkId),
        );
        expect(inB._tag).toBe("Failure");
        expect(inC._tag).toBe("Failure");
        if (inB._tag === "Failure") {
          expect(JSON.stringify(inB.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
        }
        if (inC._tag === "Failure") {
          expect(JSON.stringify(inC.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
        }
      }),
    ));

  it("fails closed when a ReconciliationEscalated payload binds this Workspace but aggregate_ref points elsewhere", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendReconciliationEvent(otherExecutionId, executionId);
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
          expect(JSON.stringify(exit.cause)).toContain(
            `"executionId":"${executionId}"`,
          );
        }
      }),
    ));

  it("fails closed when ReconciliationEscalated payload points to a missing Execution", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* appendReconciliationEvent(
          executionId,
          "exe_018f2b3c-4d5e-7abc-8def-0123456789ff",
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceExecutionMissing"',
          );
        }
      }),
    ));

  it("lets unrelated A skip aggregate B with a missing payload identity, while B rejects it", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendReconciliationEvent(otherExecutionId);
        expect(
          Option.isNone(yield* queryTarget(projectId, workspaceId, workId)),
        ).toBe(true);
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        expect(inB._tag).toBe("Failure");
        if (inB._tag === "Failure") {
          expect(JSON.stringify(inB.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
        }
      }),
    ));

  it("lets unrelated A skip aggregate B with a foreign-project payload, while B rejects it", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* seedOtherProjectExecution;
        yield* appendReconciliationEvent(
          otherExecutionId,
          otherProjectExecutionId,
        );
        expect(
          Option.isNone(yield* queryTarget(projectId, workspaceId, workId)),
        ).toBe(true);
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        expect(inB._tag).toBe("Failure");
        if (inB._tag === "Failure") {
          expect(JSON.stringify(inB.cause)).toContain(
            '"reasonCode":"SourceProjectMismatch"',
          );
        }
      }),
    ));

  it("fails closed when both ReconciliationEscalated identities match but the Execution is missing", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        const missingExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789fe";
        yield* appendReconciliationEvent(
          missingExecutionId,
          missingExecutionId,
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceExecutionMissing"',
          );
          expect(JSON.stringify(exit.cause)).toContain(
            `"executionId":"${missingExecutionId}"`,
          );
        }
      }),
    ));

  it("fails closed when aggregate Execution is missing but payload binds the requested Workspace", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        const missingExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789fd";
        yield* appendReconciliationEvent(missingExecutionId, executionId);
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceExecutionMissing"',
          );
        }
      }),
    ));

  it("fails closed when both ReconciliationEscalated identities match an Execution in another Project", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherProjectExecution;
        yield* appendReconciliationEvent(
          otherProjectExecutionId,
          otherProjectExecutionId,
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceProjectMismatch"',
          );
        }
      }),
    ));

  it("fails closed for A and B when aggregate is missing even if payload points to B", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        const missingExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789fc";
        yield* appendReconciliationEvent(missingExecutionId, otherExecutionId);
        const inA = yield* Effect.exit(
          queryTarget(projectId, workspaceId, workId),
        );
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        for (const exit of [inA, inB]) {
          expect(exit._tag).toBe("Failure");
          if (exit._tag === "Failure") {
            expect(JSON.stringify(exit.cause)).toContain(
              '"reasonCode":"SourceExecutionMissing"',
            );
          }
        }
      }),
    ));

  it("fails closed for A and B when aggregate belongs to another Project even if payload points to B", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* seedOtherProjectExecution;
        yield* appendReconciliationEvent(
          otherProjectExecutionId,
          otherExecutionId,
        );
        const inA = yield* Effect.exit(
          queryTarget(projectId, workspaceId, workId),
        );
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        for (const exit of [inA, inB]) {
          expect(exit._tag).toBe("Failure");
          if (exit._tag === "Failure") {
            expect(JSON.stringify(exit.cause)).toContain(
              '"reasonCode":"SourceProjectMismatch"',
            );
          }
        }
      }),
    ));

  it("fails closed when an in-scope ReconciliationEscalated event omits its Execution binding", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* appendReconciliationEvent(executionId);
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
        }
      }),
    ));

  it("ignores a valid ReconciliationEscalated event whose exact Execution belongs to another Workspace", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendReconciliationEvent(otherExecutionId, otherExecutionId);
        expect(Option.isNone(yield* query())).toBe(true);
      }),
    ));

  it("scopes a missing ReconciliationEscalated payload identity to its aggregate Workspace", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendReconciliationEvent(otherExecutionId);
        expect(
          Option.isNone(yield* queryTarget(projectId, workspaceId, workId)),
        ).toBe(true);
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        expect(inB._tag).toBe("Failure");
        if (inB._tag === "Failure") {
          expect(JSON.stringify(inB.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
        }
      }),
    ));

  it("scopes an unparseable ReconciliationEscalated payload by aggregate Execution", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendMalformedReconciliationEvent(otherExecutionId);
        expect(
          Option.isNone(yield* queryTarget(projectId, workspaceId, workId)),
        ).toBe(true);
        const inB = yield* Effect.exit(
          queryTarget(projectId, otherWorkspaceId, otherWorkId),
        );
        expect(inB._tag).toBe("Failure");
        if (inB._tag === "Failure") {
          expect(JSON.stringify(inB.cause)).toContain(
            '"reasonCode":"SourceEventExecutionMismatch"',
          );
        }
      }),
    ));
});
