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
  it.each([
    {
      label: "aggregate and payload bind different Executions",
      aggregate: executionId,
      payload: otherExecutionId,
    },
    {
      label: "payload binds this Workspace but aggregate_ref points elsewhere",
      aggregate: otherExecutionId,
      payload: executionId,
    },
    {
      label: "in-scope event omits its Execution binding",
      aggregate: executionId,
      payload: undefined,
    },
  ] as const)(
    "fails closed when ReconciliationEscalated %s",
    ({ aggregate, payload }) =>
      runDb(
        Effect.gen(function* () {
          yield* seed();
          yield* seedOtherWorkspaceExecution;
          yield* appendReconciliationEvent(aggregate, payload);
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
      ),
  );

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

  it.each([
    {
      label: "payload points to a missing Execution",
      aggregate: executionId,
      payload: "exe_018f2b3c-4d5e-7abc-8def-0123456789ff",
      expectedId: "exe_018f2b3c-4d5e-7abc-8def-0123456789ff",
    },
    {
      label: "both identities match but the Execution is missing",
      aggregate: "exe_018f2b3c-4d5e-7abc-8def-0123456789fe",
      payload: "exe_018f2b3c-4d5e-7abc-8def-0123456789fe",
      expectedId: "exe_018f2b3c-4d5e-7abc-8def-0123456789fe",
    },
    {
      label:
        "aggregate Execution is missing but payload binds the requested Workspace",
      aggregate: "exe_018f2b3c-4d5e-7abc-8def-0123456789fd",
      payload: executionId,
      expectedId: undefined,
    },
  ] as const)(
    "fails closed with SourceExecutionMissing when ReconciliationEscalated %s",
    ({ aggregate, payload, expectedId }) =>
      runDb(
        Effect.gen(function* () {
          yield* seed();
          yield* appendReconciliationEvent(aggregate, payload);
          const exit = yield* Effect.exit(query());
          expect(exit._tag).toBe("Failure");
          if (exit._tag === "Failure") {
            expect(JSON.stringify(exit.cause)).toContain(
              '"reasonCode":"SourceExecutionMissing"',
            );
            if (expectedId !== undefined) {
              expect(JSON.stringify(exit.cause)).toContain(
                `"executionId":"${expectedId}"`,
              );
            }
          }
        }),
      ),
  );

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

  it("ignores a valid ReconciliationEscalated event whose exact Execution belongs to another Workspace", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedOtherWorkspaceExecution;
        yield* appendReconciliationEvent(otherExecutionId, otherExecutionId);
        expect(Option.isNone(yield* query())).toBe(true);
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
