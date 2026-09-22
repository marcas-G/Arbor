import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  EnvironmentRevisionStoreLive,
  P8_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  makeStartVerificationHandler,
  type StartVerificationPayload,
  type StartVerificationResult,
} from "../packages/application/src/commands/start-verification.js";
import type {
  CommandOutcome,
  CommandResult,
  GatewayEnvelope,
} from "../packages/application/src/index.js";
import {
  ArtifactId,
  CommandId,
  DeliverableId,
  ExecutionId,
  parse,
  startVerification,
  VerificationId,
  type VerificationMission,
  WorkId,
  WorkRevision,
} from "../packages/domain/dist/index.js";
import {
  DeliverableRepository,
  type DeliverableRepositoryError,
  EnvironmentRevisionStore,
  TransactionPort,
  VerificationRepository,
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

const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const UNKNOWN_WORK = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ff");
const ASSIGN_CMD = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const EXE_1 = parse(ExecutionId)("exe_00000000-0000-7000-8000-000000000001");
const ART_1 = parse(ArtifactId)("art_00000000-0000-7000-8000-000000000001");
const DEL_1 = parse(DeliverableId)("del_00000000-0000-7000-8000-000000000001");
const VER = (suffix: string) =>
  parse(VerificationId)(`ver_00000000-0000-7000-8000-00000000${suffix}`);
const CMD = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);

/** p7-app extension layer: adds the environment-revision store the handler
 * reads (p8-ddl pattern — P8 repos already ride on makeP7App; the store
 * also needs Clock, satisfied locally so the merged layer stays
 * requirement-free). */
const makeP8App = () =>
  Layer.provideMerge(
    Layer.provide(EnvironmentRevisionStoreLive, ClockLive),
    makeP7App(),
  );

const seed = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
});

const missionOf = (
  overrides: Partial<VerificationMission> = {},
): VerificationMission => ({
  goal: "verify the outcome",
  criteria: [
    { criterionId: "c1", requirement: "tests pass", required: true },
    { criterionId: "c2", requirement: "lint clean", required: false },
  ],
  riskRequirements: [],
  ...overrides,
});

const makeHandler = Effect.gen(function* () {
  const works = yield* WorkRepository;
  const verifications = yield* VerificationRepository;
  const deliverableService = yield* DeliverableRepository;
  const environmentRevisions = yield* EnvironmentRevisionStore;
  const sql = yield* SqlClient;
  return makeStartVerificationHandler({
    works,
    verifications,
    environmentRevisions,
    deliverables: {
      ...deliverableService,
      // role→artifactId binding read — the `04` §3 derivation source for
      // targetArtifactVersions (test-side seam until the port grows an
      // id lister).
      listArtifacts: (deliverableId) =>
        sql
          .unsafe<{ readonly role: string; readonly artifact_id: string }>(
            "SELECT role, artifact_id FROM deliverable_artifacts WHERE deliverable_id = ?",
            [deliverableId],
          )
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                role: row.role,
                artifactId: row.artifact_id as never,
              })),
            ),
            Effect.mapError(
              (cause) =>
                ({
                  _tag: "DeliverableRepositoryFailure",
                  cause,
                }) as DeliverableRepositoryError,
            ),
          ),
    },
  });
});

const payloadOf = (
  overrides: Partial<StartVerificationPayload> = {},
): StartVerificationPayload => ({
  verificationId: VER("0001"),
  workId: WORK_1,
  observedWorkRevision: parse(WorkRevision)(0),
  missionSnapshot: missionOf(),
  verifierExecutionId: EXE_1,
  executableMission: false,
  ...overrides,
});

const envelopeOf = (
  commandId: CommandId,
  payload: StartVerificationPayload,
): GatewayEnvelope<StartVerificationPayload> => ({
  commandType: "StartVerification",
  commandId,
  projectId: p7Project,
  actor: p7TestActor,
  issuedAt: "t",
  payload,
});

const context = {
  _tag: "External",
  principal: p7TestPrincipal,
} as const;

type Outcome = CommandResult<CommandOutcome<StartVerificationResult>>;

const expectRejected = (outcome: Outcome, tag: string) => {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.error._tag).toBe(tag);
  }
};

describe("p8-start-verification", () => {
  it("starts an Open verification: owner snapshot, mission, preallocated verifier id, event, no environment binding", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const verificationId = VER("0001");
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789d1"), payloadOf({ verificationId })),
            context,
          ),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.result).toEqual({
            verificationId,
            workId: WORK_1,
            targetWorkRevision: 0,
            ownerWorkspaceId: p7RootWorkspace,
            state: "Open",
            verifierExecutionId: EXE_1,
          });
          expect(outcome.value.events).toHaveLength(1);
          const event = outcome.value.events[0]!;
          expect(event.eventType).toBe("VerificationStarted");
          expect(event.aggregateRef).toBe(verificationId);
          expect(event.payload).toEqual({
            verificationId,
            workId: WORK_1,
            targetWorkRevision: 0,
            missionDigest: "verify the outcome [criteria=2 required=1]",
          });
        }
        const repos = yield* VerificationRepository;
        const stored = yield* tx.transact(repos.findById(verificationId));
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isSome(stored)) {
          expect(stored.value.state).toEqual({ status: "Open" });
          expect(stored.value.missionSnapshot).toEqual(missionOf());
          expect(stored.value.verificationExecutionIds).toEqual([EXE_1]);
          expect(stored.value.targetEnvironmentRevision).toBeNull();
          expect(stored.value.targetDeliverables).toEqual([]);
          expect(stored.value.targetArtifactVersions).toEqual([]);
        }
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ owner_workspace_id: string }>(
          "SELECT owner_workspace_id FROM verifications WHERE verification_id = ?",
          [verificationId],
        );
        expect(rows[0]!.owner_workspace_id).toBe(p7RootWorkspace);
      }),
      makeP8App(),
    );
  });

  it("binds targetEnvironmentRevision from EnvironmentRevisionStore.current on an executable mission", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const environmentRevisions = yield* EnvironmentRevisionStore;
        yield* tx.transact(environmentRevisions.record(p7Project, "env-1"));
        const verificationId = VER("0002");
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789d2"),
              payloadOf({ verificationId, executableMission: true }),
            ),
            context,
          ),
        );
        expect(outcome.ok).toBe(true);
        const repos = yield* VerificationRepository;
        const stored = yield* tx.transact(repos.findById(verificationId));
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isSome(stored)) {
          expect(stored.value.targetEnvironmentRevision).toBe("env-1");
        }
      }),
      makeP8App(),
    );
  });

  it("rejects InvalidVerificationMission when an executable mission has no recorded environment revision", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789d3"),
              payloadOf({
                verificationId: VER("0003"),
                executableMission: true,
              }),
            ),
            context,
          ),
        );
        expectRejected(outcome, "InvalidVerificationMission");
      }),
      makeP8App(),
    );
  });

  it("rejects WorkNotFound for an unknown work", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789d4"),
              payloadOf({ verificationId: VER("0004"), workId: UNKNOWN_WORK }),
            ),
            context,
          ),
        );
        expectRejected(outcome, "WorkNotFound");
      }),
      makeP8App(),
    );
  });

  it("rejects TerminalLifecycleMutation(Work) for a Cancelled work", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const sql = yield* SqlClient;
        yield* tx.transact(
          sql.unsafe(
            "UPDATE works SET lifecycle = 'Cancelled' WHERE work_id = ?",
            [WORK_1],
          ),
        );
        const handler = yield* makeHandler;
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789d5"),
              payloadOf({ verificationId: VER("0005") }),
            ),
            context,
          ),
        );
        expectRejected(outcome, "TerminalLifecycleMutation");
      }),
      makeP8App(),
    );
  });

  it("rejects RevisionConflict on a stale observedWorkRevision", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789d6"),
              payloadOf({
                verificationId: VER("0006"),
                observedWorkRevision: parse(WorkRevision)(5),
              }),
            ),
            context,
          ),
        );
        expectRejected(outcome, "RevisionConflict");
      }),
      makeP8App(),
    );
  });

  it("rejects InvalidVerificationMission on an empty goal", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789d7"),
              payloadOf({
                verificationId: VER("0007"),
                missionSnapshot: missionOf({ goal: "" }),
              }),
            ),
            context,
          ),
        );
        expectRejected(outcome, "InvalidVerificationMission");
      }),
      makeP8App(),
    );
  });

  it("rejects InvalidVerificationMission when no criterion is required", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789d8"),
              payloadOf({
                verificationId: VER("0008"),
                missionSnapshot: missionOf({
                  criteria: [
                    { criterionId: "c1", requirement: "r", required: false },
                  ],
                }),
              }),
            ),
            context,
          ),
        );
        expectRejected(outcome, "InvalidVerificationMission");
      }),
      makeP8App(),
    );
  });

  it("rejects VerificationAlreadyOpen when an Open verification already binds (workId, revision)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const repos = yield* VerificationRepository;
        yield* tx.transact(
          repos.insert(
            startVerification({
              verificationId: VER("0009"),
              workId: WORK_1,
              targetWorkRevision: 0 as never,
              missionSnapshot: missionOf(),
            }),
            p7Project,
            p7RootWorkspace,
          ),
        );
        const handler = yield* makeHandler;
        const outcome = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789d9"),
              payloadOf({ verificationId: VER("000a") }),
            ),
            context,
          ),
        );
        expectRejected(outcome, "VerificationAlreadyOpen");
      }),
      makeP8App(),
    );
  });

  it("derives targetArtifactVersions from deliverables at the bound revision and rejects a revision mismatch", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const deliverables = yield* DeliverableRepository;
        // bound deliverable: source work at the verified revision
        yield* tx.transact(
          deliverables.insert(
            {
              deliverableId: DEL_1,
              sourceWorkId: WORK_1,
              sourceWorkRevision: 0,
              kind: "report",
            },
            [{ role: "summary", artifactId: ART_1 }],
            p7Project,
          ),
        );
        const handler = yield* makeHandler;
        const bound = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789e1"),
              payloadOf({
                verificationId: VER("000b"),
                targetDeliverables: [DEL_1],
              }),
            ),
            context,
          ),
        );
        expect(bound.ok).toBe(true);
        const repos = yield* VerificationRepository;
        const stored = yield* tx.transact(repos.findById(VER("000b")));
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isSome(stored)) {
          expect(stored.value.targetDeliverables).toEqual([DEL_1]);
          expect(stored.value.targetArtifactVersions).toEqual([ART_1]);
        }
        // mismatched deliverable: bound to a different work revision
        const sql = yield* SqlClient;
        yield* tx.transact(
          sql.unsafe(
            "UPDATE deliverables SET source_work_revision = 1 WHERE deliverable_id = ?",
            [DEL_1],
          ),
        );
        const mismatch = yield* tx.transact(
          handler.execute(
            envelopeOf(
              CMD("0123456789e2"),
              payloadOf({
                verificationId: VER("000c"),
                targetDeliverables: [DEL_1],
              }),
            ),
            context,
          ),
        );
        expectRejected(mismatch, "InvalidVerificationMission");
      }),
      makeP8App(),
    );
  });
});
