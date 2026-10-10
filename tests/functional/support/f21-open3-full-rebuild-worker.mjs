import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  ClockLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  IdGeneratorLive,
  makeProjectAttentionProjectionStore,
  OwnershipWriteServiceWithQualificationProbe,
  P10_ATTENTION_CONSUMER_ID,
  ResourceOwnershipRepositoryLive,
  rebuildProjection,
  runConsumerBatch,
  layer as sqliteLayer,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorkspaceResourceActivationStoreLive,
} from "../../../adapters/persistence-sqlite/dist/index.js";
import { buildSingleWorkspaceLayer } from "../../../apps/single-workspace/dist/index.js";
import {
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  WorkspaceId,
} from "../../../packages/domain/dist/index.js";
import {
  AttentionProjectionStore,
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  DomainEventJournal,
  OwnershipWriteService,
  ProjectEnvironmentPort,
  ProjectionStore,
  RecoveryAttentionFactStore,
  TransactionPort,
  WorkspaceResourceActivationStore,
} from "../../../packages/ports/dist/index.js";

const [databaseFile, projectIdRaw, workspaceIdRaw, mode, markerFile] =
  process.argv.slice(2);
if (
  databaseFile === undefined ||
  projectIdRaw === undefined ||
  workspaceIdRaw === undefined ||
  mode === undefined ||
  markerFile === undefined
) {
  throw new Error("expected database, project, workspace, mode, marker path");
}

const projectId = parse(ProjectId)(projectIdRaw);
const workspaceId = parse(WorkspaceId)(workspaceIdRaw);
const address = { _tag: "FileTree", path: "C:/F21_PRIVATE_TEST_PATH" };
const waitForever = () =>
  new Promise(() => {
    setInterval(() => {}, 1_000);
  });

if (mode === "activate") {
  const base = sqliteLayer({ filename: databaseFile });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const services = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ResourceOwnershipRepositoryLive, infra),
    Layer.provide(EnvironmentRevisionStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(WorkspaceResourceActivationStoreLive, infra),
    Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_project, addresses) =>
        Effect.succeed({
          regions: addresses.map((item) => ({
            resourceSpaceId: "f21-full-rebuild-test",
            normalizedRegion: item,
          })),
          observedEnvironmentRevision: "test-env-revision",
        }),
    }),
  );
  const app = Layer.mergeAll(
    infra,
    services,
    Layer.provide(
      OwnershipWriteServiceWithQualificationProbe(),
      Layer.mergeAll(services, infra),
    ),
  );
  const lockWaitMarker = process.env.F21_ACTIVATION_LOCK_WAIT_MARKER;
  const lockAcquiredMarker = process.env.F21_ACTIVATION_LOCK_ACQUIRED_MARKER;
  if (lockWaitMarker === undefined || lockAcquiredMarker === undefined) {
    throw new Error("activation worker requires lock-wait marker paths");
  }
  let observedBusy = false;
  for (;;) {
    const db = new DatabaseSync(databaseFile);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
      db.close();
      writeFileSync(
        lockAcquiredMarker,
        "P1 SQLite writer lock acquired",
        "utf8",
      );
      break;
    } catch (error) {
      db.close();
      const reason =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      if (!/SQLITE_BUSY|database is locked/i.test(reason)) throw error;
      if (!observedBusy) {
        writeFileSync(lockWaitMarker, reason, "utf8");
        observedBusy = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ownership = yield* OwnershipWriteService;
        const result = yield* ownership.activatePendingWorkspaceResource(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(0),
          [address],
        );
        writeFileSync(markerFile, JSON.stringify(result), "utf8");
        yield* Effect.promise(waitForever);
      }).pipe(Effect.provide(app)),
    ),
  );
  process.exit(0);
}

if (
  mode !== "hold-before-commit" &&
  mode !== "hold-after-commit" &&
  mode !== "complete-rebuild" &&
  mode !== "catch-up"
) {
  throw new Error(`unknown mode ${mode}`);
}

const app = buildSingleWorkspaceLayer({ databaseFile, projectId });
const rebuild = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const journal = yield* DomainEventJournal;
  const offsets = yield* ConsumerOffsetStore;
  const deadLetters = yield* ConsumerDeadLetterStore;
  const sql = yield* SqlClient;
  const activationIntents = yield* WorkspaceResourceActivationStore;
  const sourceFacts = yield* RecoveryAttentionFactStore;
  const attentionProjection = yield* AttentionProjectionStore;
  const projection = makeProjectAttentionProjectionStore(
    projectId,
    sourceFacts,
    attentionProjection,
    activationIntents,
  );
  const provideConsumerServices = (effect) =>
    effect.pipe(
      Effect.provideService(TransactionPort, tx),
      Effect.provideService(DomainEventJournal, journal),
      Effect.provideService(ConsumerOffsetStore, offsets),
      Effect.provideService(ConsumerDeadLetterStore, deadLetters),
      Effect.provideService(ProjectionStore, projection),
      Effect.provideService(SqlClient, sql),
    );
  const result =
    mode === "catch-up"
      ? yield* provideConsumerServices(
          runConsumerBatch(P10_ATTENTION_CONSUMER_ID, projectId, 10),
        )
      : yield* provideConsumerServices(
          rebuildProjection(
            P10_ATTENTION_CONSUMER_ID,
            projectId,
            100,
            mode === "hold-after-commit"
              ? async (event) => {
                  if (
                    event.boundary ===
                      "P10AfterResetAndOffsetRewindCommitBeforeCatchUp" &&
                    event.projectId === projectId
                  ) {
                    writeFileSync(markerFile, JSON.stringify(event), "utf8");
                    await waitForever();
                  }
                }
              : undefined,
          ),
        );
  writeFileSync(markerFile, JSON.stringify(result), "utf8");
  yield* Effect.promise(waitForever);
});

const layer =
  mode === "hold-before-commit"
    ? buildSingleWorkspaceLayer({
        databaseFile,
        projectId,
        attentionProjectionQualificationProbe: async (event) => {
          if (
            event.boundary ===
              "P10AfterActivationAttentionRowWriteBeforeProjectionCommit" &&
            event.projectId === projectId &&
            event.workspaceId === workspaceId
          ) {
            writeFileSync(markerFile, JSON.stringify(event), "utf8");
            await waitForever();
          }
        },
      })
    : app;

await Effect.runPromise(Effect.scoped(Effect.provide(rebuild, layer)));
