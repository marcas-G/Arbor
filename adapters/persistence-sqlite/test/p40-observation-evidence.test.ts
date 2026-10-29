import {
  Actor,
  CommandId,
  type DomainEvent,
  EventId,
  EventSequence,
  ExecutionId,
  ProjectId,
  parse,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  type AssignWorkBindingAttentionFact,
  type ToolObservationReplayAttentionFact,
  TransactionScope,
} from "@arbor/ports";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeProjectAttentionProjectionStore } from "../src/attention-projection.js";
import * as persistenceExports from "../src/index.js";
import * as migrationExports from "../src/migrations.js";

const p40Migration = (
  migrationExports as typeof migrationExports & {
    readonly P40_TOOL_OBSERVATION_REPLAY_MIGRATION?: {
      readonly id: number;
      readonly name: string;
      readonly sql: string;
    };
  }
).P40_TOOL_OBSERVATION_REPLAY_MIGRATION;
const p36Migrations = (
  migrationExports as typeof migrationExports & {
    readonly P36_MIGRATIONS?: ReadonlyArray<{ readonly id: number }>;
  }
).P36_MIGRATIONS;

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const logicalActionId = "act_018f2b3c-4d5e-7abc-8def-0123456789a1";
const providerTurnId = "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1";
const callRef = "call-p40-1";
const attentionFactId = `att_${"1".repeat(64)}`;
const eventId = parse(EventId)("evt_018f2b3c-4d5e-7abc-8def-0123456789a1");
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const detectedAt = "2026-10-11T00:00:01.000Z";
const assignWorkFact: AssignWorkBindingAttentionFact = {
  attentionFactId: "assign-work-attention-fact",
  projectId,
  executionId,
  targetWorkspaceId: workspaceId,
  logicalActionId,
  committedCommandId: commandId,
  failureCode: "MissingBinding",
  firstDetectedAt: detectedAt,
  eventId,
};

const replayFact: ToolObservationReplayAttentionFact = {
  attentionFactId,
  eventId,
  projectId,
  executionId,
  targetWorkspaceId: workspaceId,
  logicalActionId,
  providerTurnId,
  callRef,
  invocationId,
  failureCode: "Missing",
  firstDetectedAt: detectedAt,
};

const replayEvent: DomainEvent<unknown> = {
  eventId,
  projectId,
  sequence: parse(EventSequence)(1),
  eventType: "ToolObservationReplayEvidenceEscalated",
  eventVersion: 1,
  occurredAt: detectedAt,
  aggregateRef: workspaceId,
  actor: parse(Actor)("system:recovery"),
  correlationRef: logicalActionId,
  payload: {
    _tag: "ToolObservationReplayEvidenceEscalated",
    attentionFactId,
    executionId,
    targetWorkspaceId: workspaceId,
    logicalActionId,
    providerTurnId,
    callRef,
    invocationId,
    failureCode: "Missing",
  },
};

const baseAttentionFacts = () => ({
  findAssignWorkBindingFailure: () => Effect.succeed(Option.none()),
  findDeliverReplayFailure: () => Effect.succeed(Option.none()),
  listDeliverReplayFailures: () => Effect.succeed([]),
  listPendingDeliverReplayAttention: () => Effect.succeed([]),
  acknowledgePendingDeliverReplayAttention: () => Effect.void,
});

describe("P40 tool observation evidence module", () => {
  it("rejects a directly applied v2 AssignWork event at the P10 store boundary", async () => {
    let writes = 0;
    const noOp = Effect.succeed(undefined);
    const projection = makeProjectAttentionProjectionStore(
      projectId,
      {
        ...baseAttentionFacts(),
        findAssignWorkBindingFailure: () =>
          Effect.succeed(Option.some(assignWorkFact)),
      },
      {
        putAssignWorkBindingFailure: () => {
          writes += 1;
          return noOp;
        },
        putDeliverReplayFailure: () => noOp,
        putToolObservationReplayFailure: () => noOp,
        resetProject: () => noOp,
        reconcileWorkspaceResourceActivation: () => noOp,
        reconcileStaleWorkRevisionRows: () => noOp,
      },
    );
    const unsupported: DomainEvent<unknown> = {
      eventId,
      projectId,
      sequence: parse(EventSequence)(1),
      eventType: "AssignWorkTargetBindingEscalated",
      eventVersion: 2,
      occurredAt: detectedAt,
      aggregateRef: workspaceId,
      actor: parse(Actor)("system:recovery"),
      causedByCommandId: commandId,
      correlationRef: logicalActionId,
      payload: {
        _tag: "AssignWorkTargetBindingEscalated",
        attentionFactId: assignWorkFact.attentionFactId,
        executionId,
        targetWorkspaceId: workspaceId,
        logicalActionId,
        committedCommandId: commandId,
        failureCode: "MissingBinding",
      },
    };
    const exit = await Effect.runPromise(
      Effect.exit(
        projection.apply([unsupported]).pipe(
          Effect.provideService(TransactionScope, {
            session: { id: "p10-direct-v2-test" },
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "PersistenceCorruption",
        repository: "ConsumerOffsetStore",
        operation: "p10-attention-apply",
        reason:
          "AssignWork binding event does not exactly match its immutable P9 fact",
      });
    }
    expect(writes).toBe(0);
  });

  it("allows the pre-P40 P10 projection to run without the P40-only replay-fact source", async () => {
    const noOp = Effect.succeed(undefined);
    const projection = makeProjectAttentionProjectionStore(
      projectId,
      baseAttentionFacts(),
      {
        putAssignWorkBindingFailure: () => noOp,
        putDeliverReplayFailure: () => noOp,
        putToolObservationReplayFailure: () => noOp,
        resetProject: () => noOp,
        reconcileWorkspaceResourceActivation: () => noOp,
        reconcileStaleWorkRevisionRows: () => noOp,
      },
    );
    const applied = await Effect.runPromise(
      projection.apply([]).pipe(
        Effect.provideService(TransactionScope, {
          session: { id: "pre-p40" },
        }),
      ),
    );
    expect(applied).toBeUndefined();
  });

  it("exports an unregistered version-40 migration for the exact P39 prefix", () => {
    expect(p36Migrations?.at(-1)?.id).toBe(36);
    expect(p36Migrations?.some((migration) => migration.id === 40)).toBe(false);
    expect(p40Migration).toBeDefined();
    expect(p40Migration).toMatchObject({
      id: 40,
      name: "tool_observation_replay_evidence",
    });
    expect(p40Migration?.sql).toContain("observation_format_version");
    expect(p40Migration?.sql).toContain("observation_json");
    expect(p40Migration?.sql).toContain("observation_sha256");
    expect(p40Migration?.sql).toContain("length(NEW.result_ref) = 40");
    expect(p40Migration?.sql).toContain(
      "tool_observation_replay_attention_facts",
    );
    expect(p40Migration?.sql).toContain(
      "tool_observation_replay_attention_rows",
    );
    expect(p40Migration?.sql).toContain(
      "tool_observation_replay_attention_fact_no_update",
    );
    expect(p40Migration?.sql).toContain(
      "tool_observation_replay_attention_fact_no_delete",
    );
    expect(p40Migration?.sql).toContain(
      "effect_admission_state = 'MayHaveStarted'",
    );
  });

  it("exports a P40-only evidence store adapter without changing the P36 runner", () => {
    expect(
      (
        persistenceExports as typeof persistenceExports & {
          readonly ToolObservationEvidenceStoreLive?: unknown;
        }
      ).ToolObservationEvidenceStoreLive,
    ).toBeDefined();
  });

  it("projects only an exact immutable P9 replay-failure event into the P10 source row", async () => {
    let projected: ToolObservationReplayAttentionFact | undefined;
    const noOp = Effect.succeed(undefined);
    const projection = makeProjectAttentionProjectionStore(
      projectId,
      baseAttentionFacts(),
      {
        putAssignWorkBindingFailure: () => noOp,
        putDeliverReplayFailure: () => noOp,
        putToolObservationReplayFailure: (fact) => {
          projected = fact;
          return noOp;
        },
        resetProject: () => noOp,
        reconcileWorkspaceResourceActivation: () => noOp,
        reconcileStaleWorkRevisionRows: () => noOp,
      },
      undefined,
      { findById: () => Effect.succeed(Option.some(replayFact)) },
    );
    await Effect.runPromise(
      projection.apply([replayEvent]).pipe(
        Effect.provideService(TransactionScope, {
          session: { id: "p40-test" },
        }),
      ),
    );
    expect(projected).toEqual(replayFact);
  });

  it("does not materialize P10 Attention when the immutable P9 fact and event disagree", async () => {
    let writes = 0;
    const noOp = Effect.succeed(undefined);
    const projection = makeProjectAttentionProjectionStore(
      projectId,
      baseAttentionFacts(),
      {
        putAssignWorkBindingFailure: () => noOp,
        putDeliverReplayFailure: () => noOp,
        putToolObservationReplayFailure: () => {
          writes += 1;
          return noOp;
        },
        resetProject: () => noOp,
        reconcileWorkspaceResourceActivation: () => noOp,
        reconcileStaleWorkRevisionRows: () => noOp,
      },
      undefined,
      { findById: () => Effect.succeed(Option.some(replayFact)) },
    );
    const invalid: DomainEvent<unknown> = {
      ...replayEvent,
      payload: {
        _tag: "ToolObservationReplayEvidenceEscalated",
        attentionFactId,
        executionId,
        targetWorkspaceId: workspaceId,
        logicalActionId,
        providerTurnId,
        callRef,
        invocationId,
        failureCode: "HashMismatch",
      },
    };
    const exit = await Effect.runPromise(
      Effect.exit(
        projection.apply([invalid]).pipe(
          Effect.provideService(TransactionScope, {
            session: { id: "p40-test" },
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(writes).toBe(0);
  });
});
