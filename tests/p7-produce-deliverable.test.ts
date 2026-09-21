import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P7_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  makeProduceDeliverableHandler,
  type ProduceDeliverablePayload,
} from "../packages/application/src/commands/produce-deliverable.js";
import {
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import {
  ArtifactId,
  type ArtifactRole,
  CommandId,
  DeliverableId,
  type DeliverableKind,
  parse,
  WorkId,
  WorkRevision,
} from "../packages/domain/dist/index.js";
import type { PendingDomainEvent } from "../packages/ports/src/index.js";
import {
  DeliverableRepository,
  TransactionPort,
  WorkRepository,
} from "../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "./support/p7-app.js";

const DEL_1 = parse(DeliverableId)("del_00000000-0000-7000-8000-000000000001");
const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const UNKNOWN_WORK = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000ff");
const ASSIGN_CMD = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const PRODUCE_CMD = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
const REPLAY_CMD = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789b2");
const CONFLICT_CMD = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789b3",
);
const REJECT_CMDS = [
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c2",
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c3",
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c4",
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c5",
].map((id) => parse(CommandId)(id));
const COMPLETED_CMD = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const ART_SUMMARY = parse(ArtifactId)(
  "art_00000000-0000-7000-8000-000000000001",
);
const ART_BODY = parse(ArtifactId)("art_00000000-0000-7000-8000-000000000002");

const KIND = "report" as never as DeliverableKind;

const producePayload = (
  overrides: Partial<ProduceDeliverablePayload> = {},
): ProduceDeliverablePayload => ({
  deliverableId: DEL_1,
  sourceWorkId: WORK_1,
  observedSourceWorkRevision: parse(WorkRevision)(0),
  kind: KIND,
  artifacts: [
    {
      role: "summary" as never as ArtifactRole,
      artifactId: ART_SUMMARY,
    },
    {
      role: "body" as never as ArtifactRole,
      artifactId: ART_BODY,
    },
  ],
  ...overrides,
});

const envelopeOf = (
  commandId: CommandId,
  payload: ProduceDeliverablePayload,
): GatewayEnvelope<ProduceDeliverablePayload> => ({
  commandType: "ProduceDeliverable",
  commandId,
  projectId: p7Project,
  actor: p7TestActor,
  issuedAt: "t",
  payload,
});

const CONTEXT = {
  _tag: "External",
  principal: p7TestPrincipal,
} as const;

const seed = Effect.gen(function* () {
  yield* runMigrations(P7_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
});

/** Gateway boundary stand-in: the handler only returns drafts, the gateway
 * appends them — replaying this insert mimics `DomainEventJournal.append`. */
let testEventNo = 0;
const appendEvents = (events: ReadonlyArray<PendingDomainEvent>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    for (const draft of events) {
      testEventNo += 1;
      const sequenceRows = yield* sql.unsafe<{ last_sequence: number }>(
        "INSERT INTO project_event_sequences (project_id, last_sequence) VALUES (?, 1) ON CONFLICT(project_id) DO UPDATE SET last_sequence = last_sequence + 1 RETURNING last_sequence",
        [draft.projectId],
      );
      const sequence = Number(sequenceRows[0]?.last_sequence ?? 0);
      yield* sql.unsafe(
        "INSERT INTO domain_events (event_id, project_id, sequence, event_type, event_version, occurred_at, aggregate_ref, actor, caused_by_command_id, caused_by_event_id, correlation_ref, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          `evt_test_${testEventNo}`,
          draft.projectId,
          sequence,
          draft.eventType,
          draft.eventVersion,
          draft.occurredAt,
          draft.aggregateRef,
          draft.actor,
          draft.causedByCommandId ?? null,
          draft.causedByEventId ?? null,
          draft.correlationRef ?? null,
          JSON.stringify(draft.payload),
        ],
      );
    }
  });

const produceEventCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'DeliverableProduced'",
  );
  return Number(rows[0]?.count ?? 0);
});

const produceEventPayloads = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ payload_json: string }>(
    "SELECT payload_json FROM domain_events WHERE event_type = 'DeliverableProduced'",
  );
  return rows.map((row) => JSON.parse(row.payload_json));
});

describe("p7-produce-deliverable", () => {
  it("commits the immutable fact: No.49 revision binding, artifact roles, DeliverableProduced", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const works = yield* WorkRepository;
        const deliverables = yield* DeliverableRepository;
        const handler = makeProduceDeliverableHandler({ works, deliverables });

        const outcome = yield* tx.transact(
          handler.execute(envelopeOf(PRODUCE_CMD, producePayload()), CONTEXT),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.result).toEqual({
            deliverableId: DEL_1,
            sourceWorkId: WORK_1,
            sourceWorkRevision: 0,
            kind: KIND,
            artifactRoles: ["summary", "body"],
          });
          yield* tx.transact(appendEvents(outcome.value.events));
        }

        const stored = yield* tx.transact(deliverables.findById(DEL_1));
        expect(Option.isSome(stored)).toBe(true);
        const roles = yield* tx.transact(deliverables.listArtifactRoles(DEL_1));
        expect([...roles].sort()).toEqual(["body", "summary"]);
        expect(yield* produceEventCount).toBe(1);
        const payloads = yield* produceEventPayloads;
        expect(payloads[0]).toEqual({
          deliverableId: DEL_1,
          sourceWorkId: WORK_1,
          sourceWorkRevision: 0,
          kind: KIND,
          artifactRoles: ["summary", "body"],
        });
      }),
      makeP7App(),
    );
  });

  it("same deliverableId + same content replays Committed without a second event; moved revision conflicts", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const works = yield* WorkRepository;
        const deliverables = yield* DeliverableRepository;
        const handler = makeProduceDeliverableHandler({ works, deliverables });

        const first = yield* tx.transact(
          handler.execute(envelopeOf(PRODUCE_CMD, producePayload()), CONTEXT),
        );
        expect(first.ok).toBe(true);
        if (first.ok) {
          yield* tx.transact(appendEvents(first.value.events));
        }

        const replay = yield* tx.transact(
          handler.execute(envelopeOf(REPLAY_CMD, producePayload()), CONTEXT),
        );
        expect(replay.ok).toBe(true);
        if (replay.ok && first.ok) {
          expect(replay.value.result).toEqual(first.value.result);
          expect(replay.value.events).toHaveLength(0);
          yield* tx.transact(appendEvents(replay.value.events));
        }
        expect(yield* produceEventCount).toBe(1);

        const work = yield* tx.transact(works.findById(WORK_1));
        expect(Option.isSome(work)).toBe(true);
        if (Option.isSome(work)) {
          yield* tx.transact(
            works.refineIfRevision(
              WORK_1,
              work.value.revision,
              {
                objective: work.value.objective,
                completionExpectation: work.value.completionExpectation,
                verificationMission: work.value.verificationMission,
              },
              parse(WorkRevision)(work.value.revision + 1),
            ),
          );
        }

        const conflict = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CONFLICT_CMD,
              producePayload({
                observedSourceWorkRevision: parse(WorkRevision)(1),
              }),
            ),
            CONTEXT,
          ),
        );
        expect(conflict.ok).toBe(false);
        if (!conflict.ok) {
          expect(conflict.error).toEqual({
            _tag: "IdempotencyConflict",
            commandId: CONFLICT_CMD,
          });
        }
        expect(yield* produceEventCount).toBe(1);
      }),
      makeP7App(),
    );
  });

  it("rejects the frozen rejection table (§3): WorkNotFound / Cancelled source", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const works = yield* WorkRepository;
        const deliverables = yield* DeliverableRepository;
        const handler = makeProduceDeliverableHandler({ works, deliverables });

        const notFound = yield* tx.transact(
          handler.execute(
            envelopeOf(
              REJECT_CMDS[0]!,
              producePayload({ sourceWorkId: UNKNOWN_WORK }),
            ),
            CONTEXT,
          ),
        );
        expect(notFound.ok).toBe(false);
        if (!notFound.ok) {
          expect(notFound.error).toEqual({
            _tag: "WorkNotFound",
            workId: UNKNOWN_WORK,
          });
        }

        yield* tx.transact(
          works.cancelIfRevision(WORK_1, parse(WorkRevision)(0)),
        );
        const cancelled = yield* tx.transact(
          handler.execute(
            envelopeOf(REJECT_CMDS[1]!, producePayload()),
            CONTEXT,
          ),
        );
        expect(cancelled.ok).toBe(false);
        if (!cancelled.ok) {
          expect(cancelled.error).toEqual({
            _tag: "TerminalLifecycleMutation",
            entity: "Work",
            lifecycle: "Cancelled",
          });
        }

        expect(yield* produceEventCount).toBe(0);
      }),
      makeP7App(),
    );
  });

  it("revision mismatch is a RevisionConflict; empty kind is AuthorityDenied (Open source)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const works = yield* WorkRepository;
        const deliverables = yield* DeliverableRepository;
        const handler = makeProduceDeliverableHandler({ works, deliverables });

        const stale = yield* tx.transact(
          handler.execute(
            envelopeOf(
              REJECT_CMDS[2]!,
              producePayload({
                observedSourceWorkRevision: parse(WorkRevision)(3),
              }),
            ),
            CONTEXT,
          ),
        );
        expect(stale.ok).toBe(false);
        if (!stale.ok) {
          expect(stale.error).toEqual({
            _tag: "RevisionConflict",
            expected: 3,
            actual: 0,
          });
        }

        const noKind = yield* tx.transact(
          handler.execute(
            envelopeOf(
              REJECT_CMDS[3]!,
              producePayload({ kind: "" as never as DeliverableKind }),
            ),
            CONTEXT,
          ),
        );
        expect(noKind.ok).toBe(false);
        if (!noKind.ok) {
          expect(noKind.error).toEqual({
            _tag: "AuthorityDenied",
            reason: "deliverable kind required",
          });
        }

        expect(yield* produceEventCount).toBe(0);
      }),
      makeP7App(),
    );
  });

  it("a Completed source Work still produces (G2: result fact, not verified result)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const works = yield* WorkRepository;
        const deliverables = yield* DeliverableRepository;
        const handler = makeProduceDeliverableHandler({ works, deliverables });

        yield* tx.transact(
          works.completeIfRevision(WORK_1, parse(WorkRevision)(0)),
        );
        const late = yield* tx.transact(
          handler.execute(envelopeOf(COMPLETED_CMD, producePayload()), CONTEXT),
        );
        expect(late.ok).toBe(true);
        if (late.ok) {
          yield* tx.transact(appendEvents(late.value.events));
        }
        const stored = yield* tx.transact(deliverables.findById(DEL_1));
        expect(Option.isSome(stored)).toBe(true);
        expect(yield* produceEventCount).toBe(1);
      }),
      makeP7App(),
    );
  });

  it("authority rule is exact-bound to ProduceDeliverableAuthority.sourceWorkId", () => {
    const works = undefined as never;
    const handler = makeProduceDeliverableHandler({
      works,
      deliverables: undefined as never,
    });
    const fingerprint = semanticRequestFingerprint({
      commandType: "ProduceDeliverable",
      projectId: p7Project,
      actor: p7TestActor,
      schemaVersion: "1",
      payload: producePayload(),
    });
    const authority: VerifiedCommandAuthority = {
      _tag: "ProduceDeliverableAuthority",
      principal: p7TestPrincipal,
      commandId: PRODUCE_CMD,
      semanticRequestFingerprint: fingerprint,
      projectId: p7Project,
      sourceWorkspaceId: p7RootWorkspace,
      sourceWorkId: WORK_1,
    };
    expect(handler.authority.targetMatches(authority, producePayload())).toBe(
      true,
    );
    expect(
      handler.authority.targetMatches(
        { ...authority, sourceWorkId: UNKNOWN_WORK },
        producePayload(),
      ),
    ).toBe(false);
    expect(
      handler.authority.targetMatches(
        { ...authority, _tag: "SteerWorkAuthority" as never },
        producePayload(),
      ),
    ).toBe(false);
    expect(handler.stopAdmission).toEqual({ _tag: "NormalExecutionMutation" });
    expect(handler.commandType).toBe("ProduceDeliverable");
    expect(handler.schemaVersion).toBe("1");
  });
});
